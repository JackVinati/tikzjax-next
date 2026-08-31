import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/cache/memory';
import type { Artifact } from '../src/types';

/** Only `bytes` matters to the cache; the rest is filled in so the value is a real Artifact. */
function artifact(bytes: number, template = 'x'): Artifact {
	return {
		v: 1,
		template,
		w: 100,
		h: 50,
		viewBox: null,
		fonts: [],
		bytes,
		engineId: 'test-engine',
		origin: 'render',
		createdAt: 0,
		lastUsed: 0,
	};
}

/**
 * Which of `keys` survived, sorted. Read through `peek` so inspecting the cache never perturbs the
 * very order under test. Recency itself is not observable through the public API by design — it is
 * asserted the only honest way, by driving an eviction and seeing who went.
 */
function survivors(cache: MemoryCache, keys: string[]): string[] {
	return keys.filter((k) => cache.peek(k) !== undefined).sort();
}

const HUGE = 1024 * 1024;

describe('MemoryCache', () => {
	it('round-trips an artifact by identity', () => {
		const cache = new MemoryCache({ entries: 4, bytes: HUGE });
		const a = artifact(10, 'svg-a');
		cache.set('a', a);
		expect(cache.get('a')).toBe(a);
		expect(cache.get('missing')).toBeUndefined();
	});

	it('evicts by entry count, least recently used first', () => {
		const cache = new MemoryCache({ entries: 3, bytes: HUGE });
		cache.set('a', artifact(1));
		cache.set('b', artifact(1));
		cache.set('c', artifact(1));
		cache.set('d', artifact(1));

		expect(cache.peek('a')).toBeUndefined();
		expect(survivors(cache, ['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
		expect(cache.stats()).toEqual({ entries: 3, bytes: 3 });
	});

	it('evicts by bytes even when the entry count is nowhere near its bound', () => {
		const cache = new MemoryCache({ entries: 100, bytes: 100 });
		cache.set('a', artifact(40));
		cache.set('b', artifact(40));
		expect(cache.stats()).toEqual({ entries: 2, bytes: 80 });

		cache.set('c', artifact(40)); // 120 > 100 -> the oldest goes
		expect(cache.peek('a')).toBeUndefined();
		expect(cache.stats()).toEqual({ entries: 2, bytes: 80 });
	});

	it('evicts as many entries as one large admission needs', () => {
		const cache = new MemoryCache({ entries: 100, bytes: 100 });
		for (const k of ['a', 'b', 'c', 'd']) cache.set(k, artifact(20));
		expect(cache.stats()).toEqual({ entries: 4, bytes: 80 });

		cache.set('big', artifact(60)); // 140 > 100: two evictions, not one
		expect(survivors(cache, ['a', 'b', 'c', 'd', 'big'])).toEqual(['big', 'c', 'd']);
		expect(cache.stats()).toEqual({ entries: 3, bytes: 100 });
	});

	it('accepts an artifact exactly at the byte bound', () => {
		const cache = new MemoryCache({ entries: 4, bytes: 100 });
		cache.set('a', artifact(100));
		expect(cache.peek('a')).toBeDefined();
		expect(cache.stats()).toEqual({ entries: 1, bytes: 100 });
	});

	it('tracks LRU order across interleaved get and set', () => {
		const cache = new MemoryCache({ entries: 3, bytes: HUGE });
		cache.set('a', artifact(1));
		cache.set('b', artifact(1));
		cache.set('c', artifact(1));

		cache.get('a'); // a is now the newest: b is the eviction candidate
		cache.set('d', artifact(1));
		expect(survivors(cache, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'd']);

		cache.get('c'); // c back to the front: a is now the oldest
		cache.set('e', artifact(1));
		expect(survivors(cache, ['a', 'c', 'd', 'e'])).toEqual(['c', 'd', 'e']);
	});

	it('promotes an entry when it is overwritten, not just when it is read', () => {
		const cache = new MemoryCache({ entries: 3, bytes: HUGE });
		cache.set('a', artifact(1));
		cache.set('b', artifact(1));
		cache.set('c', artifact(1));

		cache.set('a', artifact(1, 'rerendered'));
		cache.set('d', artifact(1));

		expect(cache.peek('b')).toBeUndefined();
		expect(cache.peek('a')?.template).toBe('rerendered');
	});

	it('peek does not reorder', () => {
		const cache = new MemoryCache({ entries: 3, bytes: HUGE });
		cache.set('a', artifact(1));
		cache.set('b', artifact(1));
		cache.set('c', artifact(1));

		cache.peek('a'); // sizing a placeholder must not rescue `a`
		cache.set('d', artifact(1));

		expect(cache.peek('a')).toBeUndefined();
		expect(survivors(cache, ['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
	});

	it('refuses an artifact larger than the whole budget and leaves the cache intact', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		cache.set('a', artifact(50));
		cache.set('b', artifact(40));
		const before = cache.stats();

		cache.set('huge', artifact(101));

		expect(cache.peek('huge')).toBeUndefined();
		// The eviction-loop hazard: a rejected oversized entry must not have emptied the cache
		// trying to make room it could never make.
		expect(survivors(cache, ['a', 'b'])).toEqual(['a', 'b']);
		expect(cache.stats()).toEqual(before);
	});

	it('refuses an oversized overwrite without dropping the entry already stored', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		const good = artifact(50, 'good');
		cache.set('a', good);

		cache.set('a', artifact(500, 'too-big'));

		expect(cache.get('a')).toBe(good);
		expect(cache.stats()).toEqual({ entries: 1, bytes: 50 });
	});

	it('refuses a non-finite or negative size rather than poisoning the byte total', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		cache.set('a', artifact(50));
		cache.set('nan', artifact(Number.NaN));
		cache.set('inf', artifact(Number.POSITIVE_INFINITY));
		cache.set('neg', artifact(-10));

		expect(cache.stats()).toEqual({ entries: 1, bytes: 50 });
		// The bound must still work afterwards.
		cache.set('b', artifact(60));
		expect(cache.peek('a')).toBeUndefined();
		expect(cache.stats()).toEqual({ entries: 1, bytes: 60 });
	});

	it('stores nothing when the entry bound is zero, instead of spinning', () => {
		const cache = new MemoryCache({ entries: 0, bytes: HUGE });
		cache.set('a', artifact(1));
		expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	it('keeps stats accurate through overwrites of a different size', () => {
		const cache = new MemoryCache({ entries: 10, bytes: HUGE });
		cache.set('a', artifact(30));
		cache.set('b', artifact(30));
		cache.set('a', artifact(5));
		expect(cache.stats()).toEqual({ entries: 2, bytes: 35 });

		cache.set('a', artifact(70));
		expect(cache.stats()).toEqual({ entries: 2, bytes: 100 });
	});

	it('deletes, reports whether anything was removed, and gives the bytes back', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		cache.set('a', artifact(80));
		expect(cache.delete('nope')).toBe(false);
		expect(cache.delete('a')).toBe(true);
		expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });

		// The freed budget is genuinely reusable: this would have evicted `a` otherwise.
		cache.set('b', artifact(80));
		expect(cache.stats()).toEqual({ entries: 1, bytes: 80 });
		expect(cache.delete('a')).toBe(false);
	});

	it('clears both counters and stays usable', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		cache.set('a', artifact(30));
		cache.set('b', artifact(30));
		cache.clear();

		expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
		expect(cache.get('a')).toBeUndefined();

		cache.set('c', artifact(30));
		expect(cache.stats()).toEqual({ entries: 1, bytes: 30 });
	});

	it('is unaffected by later mutation of the limits object it was given', () => {
		const limits = { entries: 2, bytes: HUGE };
		const cache = new MemoryCache(limits);
		limits.entries = 100;

		cache.set('a', artifact(1));
		cache.set('b', artifact(1));
		cache.set('c', artifact(1));
		expect(cache.stats().entries).toBe(2);
	});

	it('protects a recently read entry from a BYTE-driven eviction, not just a count-driven one', () => {
		// The entry bound is nowhere near its limit here, so only the byte bound can fire. Recency
		// has to steer that eviction too — a cache that respects LRU only when counting entries
		// would pass every other test in this file.
		const cache = new MemoryCache({ entries: 100, bytes: 100 });
		cache.set('a', artifact(30));
		cache.set('b', artifact(30));
		cache.set('c', artifact(30));

		cache.get('a'); // `b` is now the oldest
		cache.set('d', artifact(30)); // 120 > 100

		expect(survivors(cache, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'd']);
		expect(cache.stats()).toEqual({ entries: 3, bytes: 90 });
	});

	// -----------------------------------------------------------------------------------------
	// The artifact a caller cached is the same object it keeps mounting from, and the design has
	// it written to after the fact: `viewBox` is null until a mount measures the ink bbox (§7.4),
	// `warn` is stamped when the pipeline degrades. So `artifact.bytes` can move under the cache,
	// and the byte accounting must not be re-derived from it.

	it('bills a re-set artifact at its new size when a mount has edited the object it cached', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		const a = artifact(90);
		cache.set('a', a);

		// The mount measures, fills the viewBox in place, and writes the artifact back.
		a.viewBox = '0 0 90 45';
		a.bytes = 10;
		cache.set('a', a);

		expect(cache.stats()).toEqual({ entries: 1, bytes: 10 });
		// And the freed 80 bytes are genuinely spendable, rather than still booked against `a`.
		cache.set('b', artifact(80));
		expect(survivors(cache, ['a', 'b'])).toEqual(['a', 'b']);
	});

	it('does not empty itself forever after a cached artifact reports a smaller size', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 100 });
		const a = artifact(100);
		cache.set('a', a);
		a.bytes = 1; // an over-booked total makes `evict` walk past the entry it just admitted
		cache.set('a', a);

		cache.set('b', artifact(50));
		cache.set('c', artifact(50));

		// 1 + 50 + 50 = 101, so exactly one eviction is due — not a cache that has gone permanently
		// empty and turned every later render into a miss.
		expect(survivors(cache, ['a', 'b', 'c'])).toEqual(['b', 'c']);
		expect(cache.stats()).toEqual({ entries: 2, bytes: 100 });
	});

	it('never lets the byte total go negative when a cached artifact grew before being deleted', () => {
		const cache = new MemoryCache({ entries: 10, bytes: 1000 });
		const a = artifact(10);
		cache.set('a', a);
		a.bytes = 900;

		expect(cache.delete('a')).toBe(true);
		expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	// -----------------------------------------------------------------------------------------

	it('treats a limit that is not a finite positive number as zero rather than as no limit', () => {
		// `size > NaN` and `total > NaN` are both false, so an unclamped NaN does not relax the
		// bound — it deletes it, silently, which is exactly the unbounded cache of #58/#90.
		const nanBytes = new MemoryCache({ entries: 5, bytes: Number.NaN });
		for (let i = 0; i < 4; i++) nanBytes.set(`k${String(i)}`, artifact(1_000_000));
		expect(nanBytes.stats()).toEqual({ entries: 0, bytes: 0 });

		const nanEntries = new MemoryCache({ entries: Number.NaN, bytes: HUGE });
		for (let i = 0; i < 500; i++) nanEntries.set(`k${String(i)}`, artifact(1));
		expect(nanEntries.stats()).toEqual({ entries: 0, bytes: 0 });

		const infinite = new MemoryCache({ entries: Number.POSITIVE_INFINITY, bytes: HUGE });
		infinite.set('a', artifact(1));
		expect(infinite.stats()).toEqual({ entries: 0, bytes: 0 });

		const negative = new MemoryCache({ entries: 10, bytes: -1 });
		negative.set('a', artifact(1));
		expect(negative.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	it('survives churn well past both bounds', () => {
		const cache = new MemoryCache({ entries: 8, bytes: 100 });
		const keys: string[] = [];
		for (let i = 0; i < 200; i++) {
			const key = `k${String(i)}`;
			keys.push(key);
			cache.set(key, artifact((i % 5) + 1));
			if (i % 3 === 0) cache.get(`k${String(i - 1)}`);
			if (i % 7 === 0) cache.delete(`k${String(i - 2)}`);

			const { entries, bytes } = cache.stats();
			expect(entries).toBeLessThanOrEqual(8);
			expect(bytes).toBeLessThanOrEqual(100);
			// The reported total must be the sum of what is actually held, not merely in range: a
			// drifting counter stays inside the bounds for a long time before it strands the cache.
			const held = keys.filter((k) => cache.peek(k) !== undefined);
			expect(entries).toBe(held.length);
			expect(bytes).toBe(held.reduce((sum, k) => sum + (cache.peek(k)?.bytes ?? 0), 0));
		}
	});
});
