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
 * - **Within a budget** of stored bytes (platform/budgets.ts storedRunBytes), the least recently used
 *   out, where a run whose preamble took longer counts as used later (`keptUntil`), and a run that
 *   would go first itself is not kept.
 * - **Never in the way.** IndexedDB missing or refusing to open (a private window, site data
 *   blocked, a WebView that keeps none) turns this off for the session. A write the browser refuses
 *   for want of room makes room from the least recently used runs and is tried once more, as the
 *   diagram cache makes room (./idb); refused again, nothing more is written this session, and the
 *   runs stored go on being read. Each run lost counts as a storage error for the diagnostics view,
 *   and the diagram is drawn either way. A run whose bytes do not read back is deleted (`forget`).
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
	/**
	 * Saved preambles are turned off (Settings → Saved preambles), so that nothing is read, kept or
	 * sent: said by the plugin, which has the switch.
	 */
	off?: boolean | undefined;
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
 * engine already up, Chromium 1 to 3; Chromium put 8.9 MiB back in 14 to 22 ms.
 *
 * Then, for sending, on each device, what it took there lately (`measured`). A read is timed on the
 * main thread, behind other transactions and whatever else the thread was doing, and a fixed delay
 * divided by a small run's size is a large cost a MiB: one read of 300 ms of tikz-cd's 0.4 MiB, taken
 * as it came, put the estimate for circuitikz's run past what its preamble takes, and no run that size
 * was sent, or measured, again that session. So each sample moves the estimate a quarter of the way
 * towards it and counts for at most four times the larger of the estimate and these figures, which
 * one slow read moves by 1.75 times at most; and each run not sent for its cost moves it a quarter of
 * the way back to these, so that after a few a run is sent again and measured. Keeping goes by these
 * figures alone (`worthKeeping`): a run kept is for later sessions, which start from them.
 */
const FIXED_MS = 12;
const READ_MS_PER_MIB = 1;
const RESTORE_MS_PER_MIB = 2.5;

/**
 * What goes first when room is made: the run kept until the earliest, counted from its last use, a
 * minute later for each millisecond its preamble and save took the engine that saved it. Until
 * 0.2.1-beta.5 the least recently used went first, whatever it had cost; once a phone's engine handed
 * over every run of a note as it went (internal/DECISIONS.md D38), a note with more preambles than its
 * 16 MiB filled it in the order they came, and the next visit of the note, from its top, found the
 * runs of its first diagrams gone to make room for its last, and stored its first ones again over
 * the last: in WebKit at a phone's budgets, a second visit of the 44 test diagrams started 6 of them
 * from storage, against 0.2.1-beta.4's 11. So a run that saves more is kept longer: circuitikz's,
 * whose preamble and save took 220 to 330 ms in WebKit on the desktop, four to five hours longer
 * than plain TikZ's, 15 to 30. Over a day or more, recency still decides.
 */
const RETAIN_MS_PER_MS = 60_000;
const keptUntil = (info: Pick<StoredRunInfo, 'lastUsed' | 'preambleMs' | 'saveMs'>): number =>
	info.lastUsed + (info.preambleMs + info.saveMs) * RETAIN_MS_PER_MS;

/** How often a run's use by a diagram that resumed from it in memory is written down, at most (`used`). */
const USED_WRITE_MS = 60_000;

/** `estimate` moved a quarter of the way to `sample`, counted at most four times the larger of `estimate` and `base`. */
const lean = (estimate: number, sample: number, base: number): number =>
	0.75 * estimate + 0.25 * Math.min(sample, 4 * Math.max(estimate, base));

export class RunStore {
	private readonly name: string;
	private readonly options: RunStoreOptions;
	private db: IDBPDatabase | null = null;
	private opening: Promise<IDBPDatabase | null> | null = null;
	/** IndexedDB could not be opened; that will not get better this session. */
	private disabled = false;
	/**
	 * A write was refused for want of room even after room was made for it: nothing more is written
	 * this session. What is stored is still read.
	 */
	private full = false;
	private closed = false;
	/** By route: every run of this engine that is stored, once `load` has read them. */
	private index: Map<string, StoredRunInfo> | null = null;
	private loading: Promise<void> | null = null;
	/**
	 * The keeps, one after another: each plans its evictions from the index as the one before left
	 * it, so that two at once, from two engines, cannot both fit the budget and together pass it.
	 */
	private writing: Promise<void> = Promise.resolve();
	private errors = 0;
	/**
	 * Moved by every `clear`, so that a run being kept, or an index being read, when the switch was
	 * turned off or the cache cleared does not come back after it.
	 */
	private generation = 0;
	/** What putting a run back took here, lately, per MiB of its bytes: read, and in the worker. */
	private readPerMiB = READ_MS_PER_MIB;
	private restorePerMiB = RESTORE_MS_PER_MIB;
	/** When each run's use was last written down (`used`). */
	private readonly usedWritten = new Map<string, number>();

	constructor(options: RunStoreOptions) {
		// Per vault, as the diagram cache is: every vault on a desktop install shares one origin.
		this.name = `tikzjax-next-${options.appId}-preambles`;
		this.options = options;
	}

	/** Whether stored runs can be read now: IndexedDB opened, or has not been tried. */
	get readable(): boolean {
		return !this.disabled && !this.closed;
	}

	/** Whether runs can be kept now: they can be read, and storage has not run out of room. */
	get writable(): boolean {
		return this.readable && !this.full;
	}

	/**
	 * Where the store stands, moved by every `clear`: sent with each render, and handed back with the
	 * run it saved (protocol.ts RenderRequest.epoch), which `keep` refuses if the store was cleared
	 * since.
	 */
	get epoch(): number {
		return this.generation;
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

	/** Whether a run is stored under `route`, as far as is known: false until `load` has read them. */
	has(route: string): boolean {
		return this.index?.has(route) === true;
	}

	/**
	 * Whether putting back a run like `info` is likely to cost less than compiling its preamble did:
	 * reading its bytes, and in the worker inflating, checking and writing them, against what reaching
	 * and saving the run took the engine that saved it, on this device.
	 */
	worth(info: Pick<StoredRunInfo, 'bytes' | 'rawBytes' | 'preambleMs' | 'saveMs'>): boolean {
		return this.estimateMs(info) < info.preambleMs + info.saveMs;
	}

	estimateMs(
		info: Pick<StoredRunInfo, 'bytes' | 'rawBytes'>,
		readPerMiB = this.readPerMiB,
		restorePerMiB = this.restorePerMiB,
	): number {
		return FIXED_MS + (info.bytes / MIB) * readPerMiB + (info.rawBytes / MIB) * restorePerMiB;
	}

	/** Whether a run is worth keeping, for later sessions: by the figures they start from. */
	private worthKeeping(info: Pick<StoredRunInfo, 'bytes' | 'rawBytes' | 'preambleMs' | 'saveMs'>): boolean {
		return this.estimateMs(info, READ_MS_PER_MIB, RESTORE_MS_PER_MIB) < info.preambleMs + info.saveMs;
	}

	/**
	 * What putting back a run of `info` took: reading it here, `readMs`, and in the worker,
	 * `restoreMs`. The next estimates lean on it, a quarter at a time, and on one sample by at most
	 * 1.75 times (`lean`).
	 */
	measured(info: Pick<StoredRunInfo, 'bytes' | 'rawBytes'>, readMs: number, restoreMs: number): void {
		const stored = info.bytes / MIB;
		const raw = info.rawBytes / MIB;
		if (stored >= 0.25 && Number.isFinite(readMs))
			this.readPerMiB = lean(this.readPerMiB, Math.max(0, readMs - FIXED_MS) / stored, READ_MS_PER_MIB);
		if (raw >= 0.25 && Number.isFinite(restoreMs))
			this.restorePerMiB = lean(this.restorePerMiB, Math.max(0, restoreMs) / raw, RESTORE_MS_PER_MIB);
	}

	/**
	 * A diagram started from the run an engine held in memory under `route`: a use of the run stored
	 * under it, if one is, for what goes first when room is made (`keptUntil`). The preamble a note
	 * shares between many diagrams is put back from storage once, and then used from memory; until
	 * 0.2.1-beta.5 only that read counted. Written down at most once a minute a run.
	 */
	used(route: string): void {
		const info = this.index?.get(route);
		if (info === undefined) return;
		const now = this.options.now();
		info.lastUsed = now;
		if (now - (this.usedWritten.get(route) ?? -Infinity) < USED_WRITE_MS) return;
		this.usedWritten.set(route, now);
		void this.touch(info);
	}

	/** A run was not sent for what putting it back would cost: the estimates go a quarter of the way back. */
	private relax(): void {
		this.readPerMiB += (READ_MS_PER_MIB - this.readPerMiB) / 4;
		this.restorePerMiB += (RESTORE_MS_PER_MIB - this.restorePerMiB) / 4;
	}

	/**
	 * The run stored under `route`, worth sending (`worth`), with its bytes read; undefined if none is,
	 * or it could not be read. Each call reads its own copy, which is transferred to a worker.
	 */
	async read(route: string): Promise<StoredRun | undefined> {
		await this.load();
		const info = this.index?.get(route);
		if (info === undefined) return undefined;
		if (!this.worth(info)) {
			this.relax();
			return undefined;
		}
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
		// Not there, as when the browser evicted it, or not as long as it was stored: deleted, not sent.
		if (!(record?.data instanceof ArrayBuffer) || record.data.byteLength !== info.bytes) {
			await (record === undefined ? this.deleteRun(route) : this.forget(route));
			return undefined;
		}
		info.lastUsed = this.options.now();
		void this.touch(info);
		return { route, data: record.data, compressed: info.compressed, rawBytes: info.rawBytes };
	}

	/**
	 * Keep a run a worker saved, if it is worth putting back by the figures a session starts from
	 * (`worthKeeping`) and fits the budget, making room from the runs kept until the earliest
	 * (`keptUntil`). A run larger than the whole budget is not kept, and evicts nothing, nor does one
	 * that would itself go before the runs it would make room from. One keep at a time (`writing`).
	 */
	keep(message: SavedRunMessage): Promise<void> {
		// The store as it stood when the render that saved the run was posted: a worker hands its runs
		// over once it is idle, up to its whole budget of them after a note, so a run saved before a
		// clear can reach the store after it.
		const generation = message.epoch;
		const next = this.writing.then(() => this.write(message, generation));
		this.writing = next.catch(ignore);
		return next;
	}

	private async write(message: SavedRunMessage, generation: number): Promise<void> {
		await this.load();
		if (!this.writable || this.index === null || this.generation !== generation) return;
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
		if (info.bytes > budget || !this.worthKeeping(info)) return;

		// The run kept until the earliest first, but never the one this replaces, which goes anyway;
		// and if that is this run, it is not kept, and nothing is evicted for it.
		const others = [...this.index.values()]
			.filter((other) => other.route !== info.route)
			.sort((a, b) => keptUntil(a) - keptUntil(b));
		let total = others.reduce((n, other) => n + other.bytes, 0) + info.bytes;
		const evicted: StoredRunInfo[] = [];
		for (const other of others) {
			if (total <= budget) break;
			if (keptUntil(other) > keptUntil(info)) return;
			evicted.push(other);
			total -= other.bytes;
		}
		try {
			await this.put(info, run.data, evicted, generation);
		} catch (error) {
			if (!isQuotaError(error)) {
				this.errors++;
				return;
			}
			// Refused for room, which the browser counts for the whole origin, the diagram cache's
			// included, and which can be less than the budget: as much again as the run is made from
			// the least recently used left, in a transaction of its own that frees it, and the run is
			// tried once more. Refused again, nothing more is written this session.
			const more: StoredRunInfo[] = [];
			let freed = 0;
			for (const other of others) {
				if (freed >= info.bytes) break;
				if (evicted.includes(other)) continue;
				more.push(other);
				freed += other.bytes;
			}
			try {
				if (freed < info.bytes) throw error;
				await this.remove([...evicted, ...more], generation);
				await this.put(info, run.data, [], generation);
			} catch (again) {
				this.errors++;
				if (isQuotaError(again)) this.full = true;
			}
		}
	}

	/** Store `info`'s run and delete `evicted`, in one transaction, and say so in the index. */
	private async put(
		info: StoredRunInfo,
		data: ArrayBuffer,
		evicted: readonly StoredRunInfo[],
		generation: number,
	): Promise<void> {
		const written = await this.run(async (db) => {
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
					tx.objectStore('runs').put({ key: info.key, data } satisfies RunRecord),
					tx.objectStore('index').put(info),
				]);
			});
			return true;
		});
		if (written !== true || this.generation !== generation || this.index === null) return;
		for (const other of evicted) this.index.delete(other.route);
		this.index.set(info.route, info);
	}

	/** Delete `evicted`, in a transaction of their own, and say so in the index. */
	private async remove(evicted: readonly StoredRunInfo[], generation: number): Promise<void> {
		const removed = await this.run(async (db) => {
			if (this.generation !== generation) return false;
			const tx = db.transaction(STORES, 'readwrite');
			await settle(tx, async () => {
				await Promise.all(
					evicted.flatMap((other) => [
						tx.objectStore('runs').delete(other.key),
						tx.objectStore('index').delete(other.key),
					]),
				);
			});
			return true;
		});
		if (removed !== true || this.generation !== generation) return;
		for (const other of evicted) this.index?.delete(other.route);
	}

	/**
	 * Delete the run stored under `route`: its bytes did not read back as a run, here or in the worker
	 * (engine-src/stored-run.ts). A storage error, which the diagnostics view counts.
	 */
	async forget(route: string): Promise<void> {
		if (this.index?.has(route) !== true) return;
		this.errors++;
		await this.deleteRun(route);
	}

	/** Delete the run stored under `route`. */
	private async deleteRun(route: string): Promise<void> {
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
	 * after an update needs, and which nothing waits for: the index is known once it is read, and the
	 * first job's lookup used to wait for every byte of the old engine's runs to be deleted too, up to
	 * the whole budget, when nothing of the new engine's could be stored yet. Keeps made meanwhile
	 * queue behind the delete in IndexedDB, and touch none of its keys.
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
					Number.isInteger(info.rawBytes) &&
					info.rawBytes > 0 &&
					Number.isFinite(info.lastUsed)
				)
					mine.set(info.route, info);
				else if (typeof info?.key === 'string') foreign.push(info.key);
			}
		} catch {
			this.errors++;
		}
		// Whatever was read, or nothing: a store that cannot be read is an empty one. Unless it was
		// cleared meanwhile, which left it empty.
		if (this.generation === generation) this.index = mine;
		if (foreign.length > 0) void this.deleteForeign(foreign);
	}

	/** Delete another build's runs, never read: what each stands for is that engine's memory. */
	private async deleteForeign(keys: readonly IDBValidKey[]): Promise<void> {
		try {
			await this.run(async (db) => {
				const tx = db.transaction(STORES, 'readwrite');
				await settle(tx, async () => {
					await Promise.all(
						keys.flatMap((key) => [
							tx.objectStore('runs').delete(key),
							tx.objectStore('index').delete(key),
						]),
					);
				});
			});
		} catch {
			this.errors++;
		}
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
