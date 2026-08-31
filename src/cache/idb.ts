import { openDB, type IDBPDatabase } from 'idb';
import type { Artifact } from '../types';

/**
 * L2: the persistent artifact store. See docs/DESIGN.md §6.2.
 *
 * Not localForage. That package is unmaintained (last published 2021-08-18), the shipped plugin
 * already wraps its configuration in a try/catch *because it breaks plugin load on mobile*
 * (settings.ts:25-29), and it is the vendored engine's store rather than ours.
 *
 * Every open and every write is guarded. WebKit evicts IndexedDB under storage pressure and after
 * prolonged non-use, so an empty store is NORMAL and must never be reported as corruption; and a
 * QuotaExceededError on write must degrade to "memory only for this session", never to a failed
 * render and never to an unhandled rejection inside the settle path.
 */

const SCHEMA = 2;

interface Meta {
	key: string;
	totalBytes: number;
	schema: number;
}

export interface CacheStats {
	entries: number;
	bytes: number;
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
				upgrade(db, oldVersion) {
					if (oldVersion < 1) {
						const renders = db.createObjectStore('renders', { keyPath: 'key' });
						renders.createIndex('lastUsed', 'lastUsed');
						db.createObjectStore('meta', { keyPath: 'key' });
					}
					// A schema bump makes older records misses, swept later on idle. Never a startup
					// wipe: a mass re-render when a vault opens is exactly the stampede the
					// legacy-cache read-through exists to avoid.
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
			const record = (await db.get('renders', key)) as (Artifact & { key: string }) | undefined;
			return record;
		} catch {
			return undefined;
		}
	}

	async put(key: string, artifact: Artifact): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			await db.put('renders', { ...artifact, key });
			await this.bumpTotal(db, artifact.bytes);
		} catch (error) {
			// QuotaExceededError is the expected one. Degrade rather than fail the render.
			if (isQuotaError(error)) {
				await this.evictTo(0.7).catch(() => undefined);
			} else {
				this.disabled = true;
			}
		}
	}

	async touch(key: string, at: number): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const record = (await db.get('renders', key)) as (Artifact & { key: string }) | undefined;
			if (record) await db.put('renders', { ...record, lastUsed: at });
		} catch {
			/* a failed LRU touch costs eviction accuracy, never correctness */
		}
	}

	async delete(key: string): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			await db.delete('renders', key);
		} catch {
			/* ignore */
		}
	}

	async clear(): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			await db.clear('renders');
			await db.put('meta', { key: 'total', totalBytes: 0, schema: SCHEMA } satisfies Meta);
		} catch {
			/* ignore */
		}
	}

	async stats(): Promise<CacheStats> {
		const db = await this.open();
		if (!db) return { entries: 0, bytes: 0 };
		try {
			const entries = await db.count('renders');
			const meta = (await db.get('meta', 'total')) as Meta | undefined;
			return { entries, bytes: meta?.totalBytes ?? 0 };
		} catch {
			return { entries: 0, bytes: 0 };
		}
	}

	/** Keeps a running total so eviction never needs a full scan of a 64 MB store. */
	private async bumpTotal(db: IDBPDatabase, delta: number): Promise<void> {
		const meta = ((await db.get('meta', 'total')) as Meta | undefined) ?? {
			key: 'total',
			totalBytes: 0,
			schema: SCHEMA,
		};
		const totalBytes = Math.max(0, meta.totalBytes + delta);
		await db.put('meta', { ...meta, totalBytes });
		if (totalBytes > this.byteCap) await this.evictTo(0.9);
	}

	/** Evict least-recently-used down to `fraction` of the cap. Debounced by the caller, on idle. */
	async evictTo(fraction: number): Promise<void> {
		const db = await this.open();
		if (!db) return;
		try {
			const target = this.byteCap * fraction;
			let meta = ((await db.get('meta', 'total')) as Meta | undefined) ?? {
				key: 'total',
				totalBytes: 0,
				schema: SCHEMA,
			};
			if (meta.totalBytes <= target) return;

			let cursor = await db.transaction('renders', 'readwrite').store.index('lastUsed').openCursor();
			while (cursor && meta.totalBytes > target) {
				const record = cursor.value as Artifact & { key: string };
				meta = { ...meta, totalBytes: Math.max(0, meta.totalBytes - record.bytes) };
				await cursor.delete();
				cursor = await cursor.continue();
			}
			await db.put('meta', meta);
		} catch {
			/* eviction is best-effort; the browser will evict the whole store if it must */
		}
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}

function isQuotaError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
	);
}
