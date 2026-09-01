import { openDB, type IDBPDatabase } from 'idb';
import type { Artifact } from '../types';
import { MemoryCache } from './memory';
import { ArtifactStore } from './idb';
import { legacyKey } from './legacy-key';

/**
 * The cache, as one thing. See internal/DESIGN.md §6.
 *
 *   L1  in memory, SYNCHRONOUS. This is the tier that makes a seen diagram paint in the same frame
 *       as the text around it, because the code-block processor can probe it before returning.
 *   L2  IndexedDB, ours, per vault.
 *   L3  READ-THROUGH of the previous plugin's localForage store.
 *
 * L3 is the migration story and it is not a nicety. Without it every user's vault recompiles from
 * scratch on upgrade — at ~156 MiB per render, concurrency 1, on the very iOS devices reported
 * crashing. That is not an upgrade, it is an incident.
 *
 * L3 NEVER DELETES (internal/DECISIONS.md D1). This is a fork with a different plugin id, so the
 * original may still be installed and still using those records; draining them would break a
 * plugin we do not own. Reclaiming that space is an explicit command instead.
 */

export interface CacheOptions {
	appId: string;
	l1: { entries: number; bytes: number };
	l2Bytes: number;
	/** Read the previous plugin's store on a miss. */
	importLegacy: boolean;
	now: () => number;
}

export interface LookupResult {
	artifact: Artifact;
	tier: 'l1' | 'l2' | 'l3';
}

/** localForage's own defaults, as configured by the plugin this one forks from (settings.ts:25). */
const LEGACY_DB = 'TikzJax';
const LEGACY_STORE = 'svgImages';

export class DiagramCache {
	private readonly l1: MemoryCache;
	private readonly l2: ArtifactStore;
	private readonly options: CacheOptions;
	private legacyDb: IDBPDatabase | null = null;
	private legacyChecked = false;

	constructor(options: CacheOptions) {
		this.options = options;
		this.l1 = new MemoryCache(options.l1);
		this.l2 = new ArtifactStore(options.appId, options.l2Bytes);
	}

	/**
	 * The synchronous probe. Returning `undefined` here is what puts a block on the async path;
	 * returning an artifact is what avoids a placeholder, a layout shift and a frame entirely.
	 */
	peek(key: string): Artifact | undefined {
		return this.l1.get(key);
	}

	/** Size only, without an LRU touch — for the placeholder, which must not disturb eviction. */
	peekSize(key: string): { w: number; h: number } | undefined {
		const hit = this.l1.peek(key);
		return hit ? { w: hit.w, h: hit.h } : undefined;
	}

	async lookup(key: string, legacySource: string | null): Promise<LookupResult | undefined> {
		const hot = this.l1.get(key);
		if (hot) return { artifact: hot, tier: 'l1' };

		const stored = await this.l2.get(key);
		if (stored) {
			this.l1.set(key, stored);
			void this.l2.touch(key, this.options.now());
			return { artifact: stored, tier: 'l2' };
		}

		if (this.options.importLegacy && legacySource !== null) {
			const raw = await this.readLegacy(legacySource);
			if (raw !== undefined) {
				// Deliberately NOT an Artifact: an L3 record is the raw, pre-post-process,
				// pgf-id-baked SVG the old bundle stored before it dispatched its completion event.
				// It has to go through the full pipeline before it can be mounted or persisted,
				// which is why the state machine routes an l3 hit to `transform` and an l2 hit
				// straight to `mount`.
				return {
					artifact: {
						v: 1,
						template: raw,
						w: 0,
						h: 0,
						viewBox: null,
						fonts: [],
						bytes: raw.length,
						engineId: '',
						origin: 'legacy-import',
						createdAt: this.options.now(),
						lastUsed: this.options.now(),
					},
					tier: 'l3',
				};
			}
		}

		return undefined;
	}

	/**
	 * Drop one artifact from both tiers.
	 *
	 * Used when a preamble file changes: the key was derived from a preamble text that no longer
	 * exists, so the stored artifact is not stale in the ordinary sense — it is an answer to a
	 * question nobody will ask again. Removing it keeps the byte accounting honest rather than
	 * leaving it to expire by LRU.
	 */
	forget(key: string): Promise<void> {
		this.l1.delete(key);
		return this.l2.delete(key);
	}

	put(key: string, artifact: Artifact): void {
		this.l1.set(key, artifact);
		// L2 is fire-and-forget: a render must never wait on, or fail because of, storage.
		void this.l2.put(key, artifact);
	}

	/**
	 * Read one record from the previous plugin's store.
	 *
	 * localForage's IndexedDB driver creates the object store WITHOUT a keyPath and writes with
	 * `put(value, key)`, so `get(key)` returns the stored string directly rather than a wrapper.
	 */
	private async readLegacy(source: string): Promise<string | undefined> {
		const db = await this.openLegacy();
		if (!db) return undefined;
		try {
			const value: unknown = await db.get(LEGACY_STORE, legacyKey(source));
			return typeof value === 'string' && value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	private async openLegacy(): Promise<IDBPDatabase | null> {
		if (this.legacyDb) return this.legacyDb;
		if (this.legacyChecked) return null;
		this.legacyChecked = true;

		try {
			// Opening a database that does not exist CREATES it, which would leave an empty
			// `TikzJax` database behind in every vault that never had the old plugin. Ask first
			// where the browser can tell us; where it cannot, opening is still safe enough —
			// an empty store simply never produces a hit.
			const list = (indexedDB as { databases?: () => Promise<{ name?: string }[]> }).databases;
			if (typeof list === 'function') {
				const names = await list.call(indexedDB);
				if (!names.some((d) => d.name === LEGACY_DB)) return null;
			}

			this.legacyDb = await openDB(LEGACY_DB, undefined, {
				blocked: () => undefined,
				blocking: () => this.closeLegacy(),
			});

			if (!this.legacyDb.objectStoreNames.contains(LEGACY_STORE)) {
				this.closeLegacy();
				return null;
			}
			return this.legacyDb;
		} catch {
			return null;
		}
	}

	private closeLegacy(): void {
		this.legacyDb?.close();
		this.legacyDb = null;
	}

	stats(): Promise<{ entries: number; bytes: number }> {
		return this.l2.stats();
	}

	memoryStats(): { entries: number; bytes: number } {
		return this.l1.stats();
	}

	async clear(): Promise<void> {
		this.l1.clear();
		await this.l2.clear();
	}

	/** Mobile teardown: L1 is the cheap thing to give back under memory pressure. */
	dropMemory(): void {
		this.l1.clear();
	}

	dispose(): void {
		this.l1.clear();
		this.l2.close();
		this.closeLegacy();
	}
}
