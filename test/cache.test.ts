import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from './support/fake-indexeddb';
import { DiagramCache } from '../src/cache';
import { legacyKey } from '../src/cache/legacy-key';
import type { Artifact } from '../src/types';

/**
 * The three tiers together, against an in-memory IndexedDB (test/support/fake-indexeddb.ts): L1
 * in memory, L2 in our own database, and the read-only L3 read-through of the previous plugin's
 * localForage store.
 */

const fake = installFakeIndexedDB();
const LEGACY_DB = 'TikzJax';
const LEGACY_STORE = 'svgImages';
const SOURCE = '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}';
const LEGACY_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

function artifact(bytes: number): Artifact {
	return {
		v: 1,
		template: 'x'.repeat(bytes),
		w: 10,
		h: 10,
		viewBox: null,
		fonts: [],
		bytes,
		engineId: 'engine',
		origin: 'render',
		createdAt: 0,
		lastUsed: 0,
	};
}

/** The previous plugin's store as localForage leaves it: no keyPath, the SVG string as the value. */
async function seedLegacy(): Promise<void> {
	const db = await openDB(LEGACY_DB, 2, {
		upgrade(upgrading) {
			upgrading.createObjectStore(LEGACY_STORE);
		},
	});
	await db.put(LEGACY_STORE, LEGACY_SVG, legacyKey(SOURCE));
	db.close();
}

let cache: DiagramCache;

function open(importLegacy = true): DiagramCache {
	cache = new DiagramCache({
		appId: 'vault',
		l1: { entries: 16, bytes: 1_000_000 },
		l2Bytes: 1_000_000,
		importLegacy,
		now: () => 5000,
	});
	return cache;
}

beforeEach(() => {
	fake.reset();
});

afterEach(() => {
	cache.dispose();
});

describe('DiagramCache', () => {
	it('answers from memory, then from IndexedDB once memory is dropped', async () => {
		open();
		cache.put('k', artifact(100));
		expect(cache.peek('k')?.bytes).toBe(100);
		await fake.idle();

		// What a mobile background does.
		cache.dropMemory();
		expect(cache.peek('k')).toBeUndefined();

		const found = await cache.lookup('k', null);
		expect(found?.tier).toBe('l2');
		expect(found?.artifact.bytes).toBe(100);
		// Promoted, so the next paint of this block is synchronous again.
		expect(cache.peek('k')?.bytes).toBe(100);
	});

	it('forgets a diagram in both tiers, and its bytes with it', async () => {
		// forget() is what a preamble edit does to every diagram built from the old preamble.
		open();
		cache.put('a', artifact(100));
		cache.put('b', artifact(50));
		await fake.idle();

		await cache.forget('a');
		expect(cache.peek('a')).toBeUndefined();
		expect(await cache.lookup('a', null)).toBeUndefined();
		expect(await cache.stats()).toEqual({ entries: 1, bytes: 50 });
	});

	it("reads the previous plugin's store on a miss, as raw input for the pipeline", async () => {
		await seedLegacy();
		open();

		const found = await cache.lookup('a-key-of-ours', SOURCE);
		expect(found?.tier).toBe('l3');
		expect(found?.artifact.template).toBe(LEGACY_SVG);
		expect(found?.artifact.origin).toBe('legacy-import');
		expect(await cache.lookup('a-key-of-ours', '\\draw (0,0) circle (1);')).toBeUndefined();
	});

	it("never writes to the previous plugin's store", async () => {
		// internal/DECISIONS.md D1: the original plugin may still be installed and using it.
		await seedLegacy();
		const writes = fake.writesTo(LEGACY_DB, LEGACY_STORE);
		open();

		await cache.lookup('k', SOURCE);
		cache.put('k', artifact(100));
		await cache.clear();
		await fake.idle();

		expect(fake.writesTo(LEGACY_DB, LEGACY_STORE)).toBe(writes);
		expect(fake.records(LEGACY_DB, LEGACY_STORE).get(legacyKey(SOURCE))).toBe(LEGACY_SVG);
	});

	it("does not create the previous plugin's database in a vault that never had it", async () => {
		open();
		expect(await cache.lookup('k', SOURCE)).toBeUndefined();
		const names = (await indexedDB.databases()).map((d) => d.name);
		expect(names).not.toContain(LEGACY_DB);
	});

	it("leaves the previous plugin's store unopened when the import is off", async () => {
		await seedLegacy();
		const opens = fake.opens.get(LEGACY_DB);
		open(false);

		expect(await cache.lookup('k', SOURCE)).toBeUndefined();
		expect(fake.opens.get(LEGACY_DB)).toBe(opens);
	});
});
