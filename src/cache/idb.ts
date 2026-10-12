import { openDB, type IDBPDatabase } from 'idb';
import type { Artifact } from '../types';

/**
 * L2: the persistent artifact store. See internal/DESIGN.md §6.2.
 *
 * Not localForage. That package is unmaintained (last published 2021-08-18), the shipped plugin
 * already wraps its configuration in a try/catch *because it breaks plugin load on mobile*
 * (settings.ts:25-29), and it is the vendored engine's store rather than ours.
 *
 * Every open and every write is guarded. WebKit evicts IndexedDB under storage pressure and after
 * prolonged non-use, so an empty store is NORMAL and must never be reported as corruption; and a
 * QuotaExceededError on write must degrade to "memory only for this session", never to a failed
 * render and never to an unhandled rejection inside the settle path.
 *
 * Three stores:
 *   renders  the artifacts, keyed by cache key. Written when a diagram is stored, never on a hit.
 *   usage    `{key, lastUsed, bytes}` per artifact, indexed by lastUsed. What a hit updates, and
 *            what eviction walks, so neither ever reads or rewrites an SVG to move one number.
 *   meta     the running byte total, so deciding whether to evict never needs a scan.
 *
 * The total is kept EXACT, which is what makes it safe to evict on: every change to it happens in
 * the same transaction as the write it accounts for, against the bytes the record it replaces
 * actually had. It used to be bumped by the full size on every put — overwrites included, and a
 * fresh render is put twice, once rendered and once measured — in a separate read-modify-write
 * that overlapping puts raced, and never lowered by a delete. It only grew: once its excess passed
 * the cap, every write evicted everything, the write included.
 */

const SCHEMA = 3;

const STORES = ['renders', 'usage', 'meta'];

interface Meta {
	key: string;
	totalBytes: number;
	schema: number;
}

interface Usage {
	key: string;
	lastUsed: number;
	bytes: number;
}

export interface CacheStats {
	entries: number;
	bytes: number;
}

/** The two things `settle` needs from a transaction, whatever its scope. */
interface Settling {
	readonly done: Promise<void>;
	readonly error: DOMException | null;
}

export class ArtifactStore {
	private db: IDBPDatabase | null = null;
	private readonly name: string;
	private readonly byteCap: number;
	/** Set when the store has failed in a way that will not get better this session. */
	private disabled = false;

	constructor(appId: string, byteCap: number) {
		// The appId is not decoration. Every vault on a desktop install shares one origin, so an
		// unqualified database name would give every vault on the machine one store, one byte cap
		// and one "Clear all". Obsidian namespaces its own stores exactly this way.
		this.name = `tikzjax-next-${appId}`;
		this.byteCap = byteCap;
	}

	private async open(): Promise<IDBPDatabase | null> {
		if (this.disabled) return null;
		if (this.db) return this.db;
		try {
			this.db = await openDB(this.name, SCHEMA, {
				upgrade(db, oldVersion, _newVersion, transaction) {
					if (oldVersion < 1) {
						db.createObjectStore('renders', { keyPath: 'key' });
						db.createObjectStore('meta', { keyPath: 'key' });
					}
					if (oldVersion < 3) {
						db.createObjectStore('usage', { keyPath: 'key' }).createIndex('lastUsed', 'lastUsed');
					}
					if (oldVersion >= 1 && oldVersion < 3) {
						// What a schema-1 or -2 store holds was written by 0.1.4 or earlier, under keys
						// with no pipeline revision in them (cache/key.ts), so no lookup can reach it
						// again — dropping it turns no hit into a miss. Moving it into `usage` would read
						// the whole store, on a phone, to keep data nothing can ask for, under a byte
						// count that had drifted far past the truth. So the store starts over; the
						// "never a startup wipe" rule is about not discarding answers, and these are not.
						const renders = transaction.objectStore('renders');
						if (renders.indexNames.contains('lastUsed')) renders.deleteIndex('lastUsed');
						void renders.clear();
						void transaction.objectStore('meta').clear();
					}
				},
				blocked: () => {
					/* another tab holds an old version; we simply run memory-only */
				},
			});
			return this.db;
		} catch {
			this.disabled = true;
			return null;
		}
	}

	async get(key: string): Promise<Artifact | undefined> {
		const db = await this.open();
		if (!db) return undefined;
		try {
			const tx = db.transaction('renders', 'readonly');
			tx.done.catch(ignore);
			return (await tx.store.get(key)) as (Artifact & { key: string }) | undefined;
		} catch {
			return undefined;
		}
	}

	async put(key: string, artifact: Artifact): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const total = await this.write(db, key, artifact);
			if (total > this.byteCap) await this.evictTo(0.9);
		} catch (error) {
			// QuotaExceededError is the expected one. Degrade rather than fail the render.
			if (isQuotaError(error)) {
				await this.evictTo(0.7).catch(ignore);
			} else {
				this.disabled = true;
			}
		}
	}

	/** Store one artifact and account for it, in one transaction. Returns the new total. */
	private async write(db: IDBPDatabase, key: string, artifact: Artifact): Promise<number> {
		const tx = db.transaction(STORES, 'readwrite');
		return settle(tx, async () => {
			const [previous, meta] = await Promise.all([
				tx.objectStore('usage').get(key) as Promise<Usage | undefined>,
				tx.objectStore('meta').get('total') as Promise<Meta | undefined>,
			]);
			const bytes = sizeOf(artifact);
			const totalBytes = Math.max(0, (meta?.totalBytes ?? 0) - (previous?.bytes ?? 0) + bytes);
			// Storing a diagram again — the measured copy of a fresh render — is not a use, and must not
			// make it look older than its last one.
			const lastUsed = Math.max(previous?.lastUsed ?? 0, artifact.lastUsed);
			await Promise.all([
				tx.objectStore('renders').put({ ...artifact, key }),
				tx.objectStore('usage').put({ key, lastUsed, bytes } satisfies Usage),
				tx.objectStore('meta').put({ key: 'total', totalBytes, schema: SCHEMA } satisfies Meta),
			]);
			return totalBytes;
		});
	}

	/**
	 * Record a use, for eviction order. Touches the small `usage` record only: a hit used to read
	 * the whole artifact back and put it again, a read-write transaction on the store every lookup
	 * reads, for each diagram of a note opened after an iOS background had dropped L1.
	 */
	async touch(key: string, at: number): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const tx = db.transaction('usage', 'readwrite');
			await settle(tx, async () => {
				const usage = (await tx.objectStore('usage').get(key)) as Usage | undefined;
				if (usage && usage.lastUsed < at)
					await tx.objectStore('usage').put({ ...usage, lastUsed: at });
			});
		} catch {
			/* a failed LRU touch costs eviction accuracy, never correctness */
		}
	}

	async delete(key: string): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const tx = db.transaction(STORES, 'readwrite');
			await settle(tx, async () => {
				const [previous, meta] = await Promise.all([
					tx.objectStore('usage').get(key) as Promise<Usage | undefined>,
					tx.objectStore('meta').get('total') as Promise<Meta | undefined>,
				]);
				if (!previous) return;
				const totalBytes = Math.max(0, (meta?.totalBytes ?? 0) - previous.bytes);
				await Promise.all([
					tx.objectStore('renders').delete(key),
					tx.objectStore('usage').delete(key),
					tx.objectStore('meta').put({ key: 'total', totalBytes, schema: SCHEMA } satisfies Meta),
				]);
			});
		} catch {
			/* ignore */
		}
	}

	async clear(): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const tx = db.transaction(STORES, 'readwrite');
			await settle(tx, async () => {
				await Promise.all([
					tx.objectStore('renders').clear(),
					tx.objectStore('usage').clear(),
					tx
						.objectStore('meta')
						.put({ key: 'total', totalBytes: 0, schema: SCHEMA } satisfies Meta),
				]);
			});
		} catch {
			/* ignore */
		}
	}

	async stats(): Promise<CacheStats> {
		const db = await this.open();
		if (!db) return { entries: 0, bytes: 0 };
		try {
			const tx = db.transaction(['renders', 'meta'], 'readonly');
			tx.done.catch(ignore);
			const [entries, meta] = await Promise.all([
				tx.objectStore('renders').count(),
				tx.objectStore('meta').get('total') as Promise<Meta | undefined>,
			]);
			return { entries, bytes: meta?.totalBytes ?? 0 };
		} catch {
			return { entries: 0, bytes: 0 };
		}
	}

	/** Evict least-recently-used down to `fraction` of the cap. Debounced by the caller, on idle. */
	async evictTo(fraction: number): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const tx = db.transaction(STORES, 'readwrite');
			await settle(tx, async () => {
				const target = this.byteCap * fraction;
				const meta = (await tx.objectStore('meta').get('total')) as Meta | undefined;
				let totalBytes = meta?.totalBytes ?? 0;
				if (totalBytes <= target) return;

				let cursor = await tx.objectStore('usage').index('lastUsed').openCursor();
				while (cursor && totalBytes > target) {
					const usage = cursor.value as Usage;
					totalBytes = Math.max(0, totalBytes - usage.bytes);
					await Promise.all([tx.objectStore('renders').delete(usage.key), cursor.delete()]);
					cursor = await cursor.continue();
				}
				await tx.objectStore('meta').put({ key: 'total', totalBytes, schema: SCHEMA } satisfies Meta);
			});
		} catch {
			/* eviction is best-effort; the browser will evict the whole store if it must */
		}
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}

/**
 * Run a transaction's work and wait for it to commit, failing with the transaction's own error.
 *
 * Two IndexedDB details make this worth a helper. When a transaction aborts — for quota, most
 * importantly — the requests still pending fail with a generic AbortError, and the reason is on
 * the transaction; the caller needs the reason, to know it should evict. And `tx.done` rejects
 * whether or not anyone is listening, so it is always handled here, even when the work threw first.
 */
async function settle<T>(tx: Settling, work: () => Promise<T>): Promise<T> {
	tx.done.catch(ignore);
	try {
		const result = await work();
		await tx.done;
		return result;
	} catch (error) {
		throw tx.error ?? error;
	}
}

/** What an artifact counts for. A NaN or negative size would poison the total for good. */
function sizeOf(artifact: Artifact): number {
	const { bytes } = artifact;
	return Number.isFinite(bytes) && bytes >= 0 ? bytes : artifact.template.length;
}

function ignore(): void {
	/* handled by the caller, or deliberately not at all */
}

function isQuotaError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
	);
}
