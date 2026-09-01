import type { Artifact } from '../types';

/**
 * L1: the in-memory artifact cache. See internal/DESIGN.md §6.2 and §6.3.
 *
 * This is the tier the *synchronous* code-block probe reads, which is what makes Live Preview ↔
 * Reading switching and scroll-back instant. So every operation is O(1): recency order is the Map's
 * own insertion order, and a touch is a delete plus a set rather than a list walk.
 *
 * Two bounds, both enforced, because either alone misbehaves: an entry count alone lets 256 large
 * pgfplots artifacts hold tens of MB on a phone, and a byte budget alone lets tens of thousands of
 * tiny diagrams accumulate Map overhead the budget cannot see.
 *
 * Nothing here reads a clock or a random source. `Artifact.lastUsed` is data the caller stamps —
 * it is what L2 evicts on (§6.3) — while L1's recency lives entirely in the Map, so this module
 * stays pure and unit-testable in Node.
 */

export interface MemoryCacheLimits {
	entries: number;
	bytes: number;
}

interface Entry {
	artifact: Artifact;
	/**
	 * The size this entry was ADMITTED at — deliberately not `artifact.bytes` re-read later.
	 *
	 * Callers keep a live reference to the artifact they cached, and the design expects them to
	 * write to it: `viewBox` is `null` until a mount measures the ink bbox (§7.4, types.ts), and
	 * `warn` is stamped when the pipeline degrades. Any such edit that also touches `bytes` —
	 * including simply handing the mutated object straight back to `set` — would make the running
	 * total subtract a number it never added. That drift is silent and permanent: undercount and
	 * the byte bound quietly stops holding, overcount and `evict` walks past the entry it just
	 * admitted, so the cache empties itself on every write and never serves another hit.
	 */
	bytes: number;
}

/**
 * A bound that is not a finite positive number is not a bound at all: both `size > NaN` and
 * `total > NaN` are false, so a `NaN` — a hand-edited or Sync-delivered `data.json` carrying a
 * `null` or a string for `l1Bytes` (§8.6) — would silently delete the limit this class exists to
 * enforce, restoring the unbounded cache of #58/#90 with nothing on screen to say so. It is
 * refused at the door for the same reason `set` refuses a NaN artifact size. `Infinity` is refused
 * with it: an explicitly absent bound is still an absent bound. 0 means "store nothing", which is
 * a cache that never hits — slow, but not an OOM inside a 100 MB WKWebView (§7.10).
 */
function boundOrZero(n: number): number {
	return Number.isFinite(n) && n > 0 ? n : 0;
}

export class MemoryCache {
	private readonly entries: Map<string, Entry> = new Map();
	private readonly limits: MemoryCacheLimits;
	private totalBytes = 0;

	constructor(limits: MemoryCacheLimits) {
		// Copied, not aliased: a caller mutating its Budgets object later must not silently
		// redefine a bound this cache has already evicted against.
		this.limits = { entries: boundOrZero(limits.entries), bytes: boundOrZero(limits.bytes) };
	}

	/** A read that counts as a use: the hit moves to the most-recently-used end. */
	get(key: string): Artifact | undefined {
		const hit = this.entries.get(key);
		if (hit === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, hit);
		return hit.artifact;
	}

	/**
	 * A read that deliberately does NOT count as a use.
	 *
	 * The placeholder path sizes its skeleton from a cached artifact's `{w, h}` before it knows
	 * whether the block will ever mount (§7.1). Letting that promote the entry would mean scrolling
	 * past a note reorders the cache in favour of diagrams nobody actually looked at, evicting the
	 * ones they did.
	 */
	peek(key: string): Artifact | undefined {
		return this.entries.get(key)?.artifact;
	}

	set(key: string, artifact: Artifact): void {
		const bytes = artifact.bytes;

		// A NaN or negative size would poison the running total permanently: every later
		// `total > limit` comparison against NaN is false, so the byte bound would silently stop
		// existing rather than fail loudly.
		if (!Number.isFinite(bytes) || bytes < 0) return;

		// An artifact that cannot fit even in an empty cache is refused outright. Admitting it and
		// then evicting to satisfy the bound would walk the entire LRU, empty the cache, and still
		// not fit — trading every warm entry for a guaranteed miss.
		if (bytes > this.limits.bytes || this.limits.entries < 1) return;

		const existing = this.entries.get(key);
		if (existing !== undefined) {
			this.totalBytes -= existing.bytes;
			// Delete before re-inserting so an overwrite lands at the MRU end; a bare `set` on an
			// existing key keeps its original insertion position.
			this.entries.delete(key);
		}
		this.entries.set(key, { artifact, bytes });
		this.totalBytes += bytes;
		this.evict();
	}

	delete(key: string): boolean {
		const existing = this.entries.get(key);
		if (existing === undefined) return false;
		this.totalBytes -= existing.bytes;
		this.entries.delete(key);
		return true;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	stats(): { entries: number; bytes: number } {
		return { entries: this.entries.size, bytes: this.totalBytes };
	}

	/** Evict least-recently-used first until BOTH bounds hold. */
	private evict(): void {
		while (this.entries.size > this.limits.entries || this.totalBytes > this.limits.bytes) {
			// Map iteration is insertion order, so the first key is the least recently used.
			const oldest = this.entries.keys().next();
			// Unreachable while the accounting is exact — an empty cache has `totalBytes === 0`,
			// which exceeds neither bound, because `set` already refused anything larger than the
			// byte budget. Kept so a future bound can never turn this into a spin.
			if (oldest.done === true) return;
			this.delete(oldest.value);
		}
	}
}
