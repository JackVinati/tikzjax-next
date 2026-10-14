import { openDB, type IDBPDatabase } from 'idb';
import type { SavedRunMessage, StoredRun } from '../../engine-src/protocol';
import { isConnectionLost } from './idb';

/**
 * Saved preambles kept across the engine's stops (internal/DECISIONS.md D36).
 *
 * An engine saves a diagram's first pass at the end of its \begin{document}, and a later diagram with
 * the same input up to there starts from that run (engine-src/snapshot.ts, D32). The runs lived in
 * the engine, and went with it: on a phone it stops after 15 s idle (D37) and whenever Obsidian goes
 * to the background, so the first diagram after each of those compiled its preamble again. A worker now
 * hands each run it saves to the host as bytes (engine-src/stored-run.ts), and they are kept here,
 * in IndexedDB, for the next engine: when a job reaches an engine that does not hold its run, the
 * host reads the run and sends it with the job.
 *
 * In the app's own IndexedDB, as the diagram cache is (./idb), in a database of its own beside it,
 * `tikzjax-next-<appId>-preambles`, so that neither store's schema or failures reach the other. Never
 * in the vault or the plugin's folder, which Obsidian Sync and iCloud copy to every device: a run is
 * this engine's memory, megabytes of it, and is worth nothing to another build.
 *
 * - **Keyed by ENGINE_ID** and the run's name (engine-src/document.ts routeKey, a hash of the text the
 *   run stands for and of whether the log is kept): a run is TeX's memory as one build of the engine
 *   left it, which no other build can start from. The index is read once a session, and every entry
 *   of another ENGINE_ID is deleted then, unread. The worker checks the ENGINE_ID inside the bytes,
 *   and the text, again.
 * - **Within a budget** of stored bytes (platform/budgets.ts storedRunBytes), least recently used out.
 * - **Never in the way.** IndexedDB missing or refusing to open (a private window, site data
 *   blocked, a WebView that keeps none) turns this off for the session; a write the browser refuses for want of room
 *   stops writing for the session; each counts as a storage error for the diagnostics view, and the
 *   diagram is drawn either way. A run whose bytes do not read back is deleted (`forget`).
 *
 * Two stores: `runs`, `{key, data}`, the bytes, read only to send one; and `index`, a small record per
 * run, read whole once a session, so that whether a run is stored is known without touching its
 * bytes. A put, a delete and an eviction write both in one transaction.
 */

const SCHEMA = 1;
const STORES = ['runs', 'index'];

/** What is known of a stored run without reading it. */
export interface StoredRunInfo {
	/** `<ENGINE_ID>/<route>`. */
	key: string;
	engineId: string;
	route: string;
	/** What it takes in storage, gzipped where `compressed`. */
	bytes: number;
	/** Its bytes once inflated. */
	rawBytes: number;
	compressed: boolean;
	/** What the engine that saved it spent reaching the point it stands for, and saving it. */
	preambleMs: number;
	saveMs: number;
	createdAt: number;
	lastUsed: number;
}

/** What the diagnostics view says of stored runs. */
export interface StoredRunStats {
	/** False once IndexedDB could not be opened this session. */
	available: boolean;
	/**
	 * Whether what is stored has been read this session, which happens when the engine first starts:
	 * until then the counts below say nothing of what an earlier session stored.
	 */
	read: boolean;
	runs: number;
	bytes: number;
	/** Opens, reads and writes the browser refused this session, and runs that did not read back. */
	errors: number;
}

export interface RunStoreOptions {
	appId: string;
	engineId: string;
	/** What may be stored, in bytes, read at each write: the platform's budget (budgets.ts). */
	budget: () => number;
	now: () => number;
}

interface RunRecord {
	key: string;
	data: ArrayBuffer;
}

/**
 * What putting a run back costs: a time to read anything from IndexedDB at all, and a time per MiB of
 * its bytes, stored, to read them, and inflated, for the worker to inflate, check and read them back.
 * A run is sent with a job, and kept at all, only when that is likely less than what compiling its
 * preamble and saving it took the engine that saved it (`worth`). To begin with, the slower of WebKit
 * and Chromium on the desktop (D36): WebKit took 9 to 13 ms to read a run of 0.2 to 2.8 MiB with the
 * engine already up, Chromium 1 to 3; Chromium put 8.9 MiB back in 14 to 22 ms. Then, on each device,
 * what it took there lately (`measured`).
 */
const FIXED_MS = 12;
const READ_MS_PER_MIB = 1;
const RESTORE_MS_PER_MIB = 2.5;

export class RunStore {
	private readonly name: string;
	private readonly options: RunStoreOptions;
	private db: IDBPDatabase | null = null;
	private opening: Promise<IDBPDatabase | null> | null = null;
	/** IndexedDB could not be opened; that will not get better this session. */
	private disabled = false;
	/** A write was refused for want of room; nothing more is written this session. */
	private full = false;
	private closed = false;
	/** By route: every run of this engine that is stored, once `load` has read them. */
	private index: Map<string, StoredRunInfo> | null = null;
	private loading: Promise<void> | null = null;
	private errors = 0;
	/**
	 * Moved by every `clear`, so that a run being kept, or an index being read, when the switch was
	 * turned off or the cache cleared does not come back after it.
	 */
	private generation = 0;
	/** What putting a run back took here, lately, per MiB of its bytes: read, and in the worker. */
	private readPerMiB = READ_MS_PER_MIB;
	private restorePerMiB = RESTORE_MS_PER_MIB;

	constructor(options: RunStoreOptions) {
		// Per vault, as the diagram cache is: every vault on a desktop install shares one origin.
		this.name = `tikzjax-next-${options.appId}-preambles`;
		this.options = options;
	}

	/** Whether runs can be kept now: IndexedDB opened, or has not been tried, and has room. */
	get keeping(): boolean {
		return !this.disabled && !this.full && !this.closed;
	}

	stats(): StoredRunStats {
		let runs = 0;
		let bytes = 0;
		for (const info of this.index?.values() ?? []) {
			runs++;
			bytes += info.bytes;
		}
		return { available: !this.disabled, read: this.index !== null, runs, bytes, errors: this.errors };
	}

	/**
	 * Read what is stored, once a session: the index, without the bytes. Every entry of another
	 * ENGINE_ID is deleted here, unread.
	 */
	load(): Promise<void> {
		this.loading ??= this.readIndex();
		return this.loading;
	}

	/** What is stored under `route`, once loaded; undefined if nothing is, or not yet known. */
	info(route: string): StoredRunInfo | undefined {
		return this.index?.get(route);
	}

	/**
	 * Whether putting back a run like `info` is likely to cost less than compiling its preamble did:
	 * reading its bytes, and in the worker inflating, checking and writing them, against what reaching
	 * and saving the run took the engine that saved it, on this device.
	 */
	worth(info: Pick<StoredRunInfo, 'bytes' | 'rawBytes' | 'preambleMs' | 'saveMs'>): boolean {
		return this.estimateMs(info) < info.preambleMs + info.saveMs;
	}

	estimateMs(info: Pick<StoredRunInfo, 'bytes' | 'rawBytes'>): number {
		return FIXED_MS + (info.bytes / MIB) * this.readPerMiB + (info.rawBytes / MIB) * this.restorePerMiB;
	}

	/**
	 * What putting back a run of `info` took: reading it here, `readMs`, and in the worker,
	 * `restoreMs`. The next estimates lean on it, a quarter at a time.
	 */
	measured(info: Pick<StoredRunInfo, 'bytes' | 'rawBytes'>, readMs: number, restoreMs: number): void {
		const stored = info.bytes / MIB;
		const raw = info.rawBytes / MIB;
		if (stored >= 0.25 && Number.isFinite(readMs))
			this.readPerMiB = 0.75 * this.readPerMiB + 0.25 * (Math.max(0, readMs - FIXED_MS) / stored);
		if (raw >= 0.25 && Number.isFinite(restoreMs))
			this.restorePerMiB = 0.75 * this.restorePerMiB + 0.25 * (restoreMs / raw);
	}

	/**
	 * The run stored under `route`, worth sending (`worth`), with its bytes read; undefined if none is,
	 * or it could not be read. Each call reads its own copy, which is transferred to a worker.
	 */
	async read(route: string): Promise<StoredRun | undefined> {
		await this.load();
		const info = this.index?.get(route);
		if (info === undefined || !this.worth(info)) return undefined;
		let record: RunRecord | undefined;
		try {
			record = await this.run(async (db) => {
				const tx = db.transaction('runs', 'readonly');
				tx.done.catch(ignore);
				return (await tx.store.get(info.key)) as RunRecord | undefined;
			});
		} catch {
			this.errors++;
			return undefined;
		}
		// Not there, or not as long as it was stored: deleted, not sent.
		if (!(record?.data instanceof ArrayBuffer) || record.data.byteLength !== info.bytes) {
			if (record !== undefined) this.errors++;
			await this.forget(route);
			return undefined;
		}
		info.lastUsed = this.options.now();
		void this.touch(info);
		return { route, data: record.data, compressed: info.compressed, rawBytes: info.rawBytes };
	}

	/**
	 * Keep a run a worker saved, if it is worth putting back (`worth`) and fits the budget, making
	 * room from the least recently used. A run larger than the whole budget is not kept, and evicts
	 * nothing.
	 */
	async keep(message: SavedRunMessage): Promise<void> {
		const generation = this.generation;
		await this.load();
		if (!this.keeping || this.index === null || this.generation !== generation) return;
		const { run } = message;
		const now = this.options.now();
		const info: StoredRunInfo = {
			key: this.keyOf(run.route),
			engineId: this.options.engineId,
			route: run.route,
			bytes: run.data.byteLength,
			rawBytes: run.rawBytes,
			compressed: run.compressed,
			preambleMs: message.preambleMs,
			saveMs: message.saveMs,
			createdAt: now,
			lastUsed: now,
		};
		const budget = this.options.budget();
		if (info.bytes > budget || !this.worth(info)) return;

		// The least recently used first, but never the one this replaces, which goes anyway.
		const others = [...this.index.values()]
			.filter((other) => other.route !== info.route)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		let total = others.reduce((n, other) => n + other.bytes, 0) + info.bytes;
		const evicted: StoredRunInfo[] = [];
		for (const other of others) {
			if (total <= budget) break;
			evicted.push(other);
			total -= other.bytes;
		}
		let written: boolean | undefined;
		try {
			written = await this.run(async (db) => {
				// Cleared since: transactions run in the order they are made, so one made from here on
				// would land after the clear's.
				if (this.generation !== generation) return false;
				const tx = db.transaction(STORES, 'readwrite');
				await settle(tx, async () => {
					await Promise.all([
						...evicted.flatMap((other) => [
							tx.objectStore('runs').delete(other.key),
							tx.objectStore('index').delete(other.key),
						]),
						tx.objectStore('runs').put({ key: info.key, data: run.data } satisfies RunRecord),
						tx.objectStore('index').put(info),
					]);
				});
				return true;
			});
		} catch (error) {
			this.errors++;
			if (isQuotaError(error)) this.full = true;
			return;
		}
		if (written !== true || this.generation !== generation) return;
		for (const other of evicted) this.index.delete(other.route);
		this.index.set(info.route, info);
	}

	/** Delete the run stored under `route`: its bytes did not read back as a run (engine-src/stored-run.ts). */
	async forget(route: string): Promise<void> {
		const info = this.index?.get(route);
		if (info === undefined) return;
		this.index?.delete(route);
		try {
			await this.run(async (db) => {
				const tx = db.transaction(STORES, 'readwrite');
				await settle(tx, async () => {
					await Promise.all([
						tx.objectStore('runs').delete(info.key),
						tx.objectStore('index').delete(info.key),
					]);
				});
			});
		} catch {
			this.errors++;
		}
	}

	/**
	 * Delete every stored run: saved preambles were turned off, or the diagram cache was cleared. A
	 * write refused for room before is tried again after it.
	 */
	async clear(): Promise<void> {
		this.generation++;
		this.index = new Map();
		this.loading = Promise.resolve();
		this.full = false;
		try {
			await this.run(async (db) => {
				const tx = db.transaction(STORES, 'readwrite');
				await settle(tx, async () => {
					await Promise.all([tx.objectStore('runs').clear(), tx.objectStore('index').clear()]);
				});
			});
		} catch {
			this.errors++;
		}
	}

	/**
	 * Delete every stored run, as `clear` does, but only where a database of them exists, which it
	 * asks the browser first where the browser can say: saved preambles are off at load, and a vault
	 * that never kept any is not given an empty database.
	 */
	async discard(): Promise<void> {
		try {
			// Where IndexedDB itself is missing, there is nothing to delete.
			if (typeof indexedDB === 'undefined') return;
			const list = (indexedDB as { databases?: () => Promise<{ name?: string }[]> }).databases;
			if (typeof list === 'function') {
				const names = await list.call(indexedDB);
				if (!names.some((d) => d.name === this.name)) return;
			}
		} catch {
			return;
		}
		await this.clear();
	}

	/** Teardown, on unload: nothing opens a connection after it. */
	close(): void {
		this.closed = true;
		this.drop(this.db);
	}

	// -------------------------------------------------------------------------------------------

	private keyOf(route: string): string {
		return `${this.options.engineId}/${route}`;
	}

	/**
	 * Every index record in one request, getAll, not a cursor: a cursor is a round trip to the storage
	 * a record. In WebKit on the desktop, with 13 runs stored, the first diagram after a fresh start
	 * waited 128 to 146 ms for the cursor, the engine up in 97 to 109, and 9 ms for getAll (D36).
	 * Another ENGINE_ID's are then deleted, in a transaction of their own, which only the first start
	 * after an update needs.
	 */
	private async readIndex(): Promise<void> {
		const generation = this.generation;
		const mine = new Map<string, StoredRunInfo>();
		const foreign: IDBValidKey[] = [];
		try {
			const all = await this.run(async (db) => {
				const tx = db.transaction('index', 'readonly');
				tx.done.catch(ignore);
				return (await tx.store.getAll()) as StoredRunInfo[];
			});
			for (const info of all ?? []) {
				if (
					info.engineId === this.options.engineId &&
					info.key === this.keyOf(info.route) &&
					Number.isFinite(info.bytes) &&
					Number.isFinite(info.lastUsed)
				)
					mine.set(info.route, info);
				else if (typeof info?.key === 'string') foreign.push(info.key);
			}
			if (foreign.length > 0)
				await this.run(async (db) => {
					const tx = db.transaction(STORES, 'readwrite');
					await settle(tx, async () => {
						// Another build's, never read: what it stands for is that engine's memory.
						await Promise.all(
							foreign.flatMap((key) => [
								tx.objectStore('runs').delete(key),
								tx.objectStore('index').delete(key),
							]),
						);
					});
				});
		} catch {
			this.errors++;
		}
		// Whatever was read, or nothing: a store that cannot be read is an empty one. Unless it was
		// cleared meanwhile, which left it empty.
		if (this.generation === generation) this.index = mine;
	}

	/** Record a use, for eviction: the small index record only. */
	private async touch(info: StoredRunInfo): Promise<void> {
		try {
			await this.run(async (db) => {
				const tx = db.transaction('index', 'readwrite');
				await settle(tx, async () => {
					if ((await tx.store.get(info.key)) !== undefined) await tx.store.put({ ...info });
				});
			});
		} catch {
			/* a lost touch costs eviction order, never a diagram */
		}
	}

	private open(): Promise<IDBPDatabase | null> {
		if (this.disabled || this.closed) return Promise.resolve(null);
		if (this.db) return Promise.resolve(this.db);
		this.opening ??= this.connect();
		return this.opening;
	}

	/** As the diagram cache opens its own (./idb ArtifactStore): null to run without it. */
	private connect(): Promise<IDBPDatabase | null> {
		return new Promise((release) => {
			let connection: IDBPDatabase | null = null;
			const done = (db: IDBPDatabase | null): void => {
				this.opening = null;
				release(db);
			};
			let opened: Promise<IDBPDatabase>;
			try {
				opened = openDB(this.name, SCHEMA, {
					upgrade(db) {
						if (!db.objectStoreNames.contains('runs'))
							db.createObjectStore('runs', { keyPath: 'key' });
						if (!db.objectStoreNames.contains('index'))
							db.createObjectStore('index', { keyPath: 'key' });
					},
					blocked: () => release(null),
					blocking: () => this.drop(connection),
					terminated: () => this.drop(connection),
				});
			} catch {
				this.unavailable();
				done(null);
				return;
			}
			opened.then(
				(db) => {
					connection = db;
					if (this.closed) {
						db.close();
						done(null);
						return;
					}
					this.db = db;
					done(db);
				},
				() => {
					this.unavailable();
					done(null);
				},
			);
		});
	}

	private unavailable(): void {
		if (!this.disabled) this.errors++;
		this.disabled = true;
	}

	private drop(connection: IDBPDatabase | null): void {
		if (connection === null) return;
		if (this.db === connection) this.db = null;
		try {
			connection.close();
		} catch {
			/* already closed */
		}
	}

	/** One operation, once more on a fresh connection if the first turns out to be dead (./idb). */
	private async run<T>(operation: (db: IDBPDatabase) => Promise<T>): Promise<T | undefined> {
		for (let attempt = 0; ; attempt++) {
			const db = await this.open();
			if (!db) return undefined;
			try {
				return await operation(db);
			} catch (error) {
				if (attempt > 0 || !isConnectionLost(error)) throw error;
				this.drop(db);
			}
		}
	}
}

const MIB = 1024 * 1024;

/** A transaction's work, then its commit, failing with the transaction's own error (./idb). */
async function settle<T>(
	tx: { readonly done: Promise<void>; readonly error: DOMException | null },
	work: () => Promise<T>,
): Promise<T> {
	tx.done.catch(ignore);
	try {
		const result = await work();
		await tx.done;
		return result;
	} catch (error) {
		throw tx.error ?? error;
	}
}

function ignore(): void {
	/* handled by the caller */
}

function isQuotaError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
	);
}
