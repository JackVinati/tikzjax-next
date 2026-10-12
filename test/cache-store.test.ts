import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from './support/fake-indexeddb';
import { ArtifactStore } from '../src/cache/idb';
import type { Artifact } from '../src/types';

/**
 * L2, the persistent store, against an in-memory IndexedDB with real transactions
 * (test/support/fake-indexeddb.ts). The byte count is what eviction runs on, so it is checked
 * exactly, through every path that writes: an overwrite, a delete, writes that overlap, eviction
 * and a refused write.
 */

const fake = installFakeIndexedDB();
const APP = 'vault';
const DB = `tikzjax-next-${APP}`;

function artifact(bytes: number, lastUsed = 0): Artifact {
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
		lastUsed,
	};
}

function storedKeys(): string[] {
	return [...fake.records(DB, 'renders').keys()].map(String).sort();
}

let store: ArtifactStore;

beforeEach(() => {
	fake.reset();
});

afterEach(() => {
	store.close();
});

describe('ArtifactStore — byte accounting', () => {
	it('counts an overwritten diagram once', async () => {
		// The ordinary case, not an edge: a fresh render is stored, and stored again once a mount has
		// measured its ink bounds.
		store = new ArtifactStore(APP, 10_000);
		await store.put('a', artifact(100));
		await store.put('a', artifact(100));
		expect(await store.stats()).toEqual({ entries: 1, bytes: 100 });
	});

	it('counts the new size when an overwrite changes it', async () => {
		store = new ArtifactStore(APP, 10_000);
		await store.put('a', artifact(100));
		await store.put('a', artifact(40));
		expect(await store.stats()).toEqual({ entries: 1, bytes: 40 });
	});

	it('takes a deleted diagram off the count', async () => {
		// forget() deletes on every preamble edit.
		store = new ArtifactStore(APP, 10_000);
		await store.put('a', artifact(100));
		await store.put('b', artifact(50));
		await store.delete('a');
		await store.delete('never-stored');
		expect(await store.stats()).toEqual({ entries: 1, bytes: 50 });
	});

	it('loses no bytes to writes that overlap', async () => {
		// A note opening renders its diagrams concurrently, and each one is persisted as it lands.
		store = new ArtifactStore(APP, 10_000);
		await Promise.all(Array.from({ length: 20 }, (_, i) => store.put(`k${i}`, artifact(10 + i))));
		expect(await store.stats()).toEqual({ entries: 20, bytes: 20 * 10 + (19 * 20) / 2 });
	});

	it('does not drift into emptying itself as the same diagrams are stored again and again', async () => {
		// Months of Live Preview editing, compressed: five diagrams, each re-stored fifty times. A
		// count that grew with every overwrite passed the cap and then evicted everything on every
		// write, while the store held a fraction of it.
		store = new ArtifactStore(APP, 1000);
		for (let round = 0; round < 50; round++) {
			for (let k = 0; k < 5; k++) await store.put(`k${k}`, artifact(100, round * 5 + k));
		}
		expect(await store.stats()).toEqual({ entries: 5, bytes: 500 });
		expect(storedKeys()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
	});
});

describe('ArtifactStore — eviction', () => {
	it('evicts the least recently used down to 90% of the cap once the cap is passed', async () => {
		store = new ArtifactStore(APP, 1000);
		for (let i = 0; i < 10; i++) await store.put(`k${i}`, artifact(100, i));
		expect(await store.stats()).toEqual({ entries: 10, bytes: 1000 });

		await store.put('k10', artifact(100, 10));
		expect(await store.stats()).toEqual({ entries: 9, bytes: 900 });
		expect(storedKeys()).not.toContain('k0');
		expect(storedKeys()).not.toContain('k1');
		expect(storedKeys()).toContain('k10');
	});

	it('keeps a touched diagram from eviction, without rewriting the diagram itself', async () => {
		store = new ArtifactStore(APP, 1000);
		for (let i = 0; i < 10; i++) await store.put(`k${i}`, artifact(100, i));

		const rewrites = fake.writesTo(DB, 'renders');
		await store.touch('k0', 100);
		// A cache hit used to read the whole record back and put it again to move one number.
		expect(fake.writesTo(DB, 'renders')).toBe(rewrites);

		await store.put('k10', artifact(100, 10));
		expect(storedKeys()).toContain('k0');
		expect(storedKeys()).not.toContain('k1');
		expect(storedKeys()).not.toContain('k2');
	});

	it('makes room and carries on when the browser refuses a write for quota', async () => {
		store = new ArtifactStore(APP, 1000);
		for (let i = 0; i < 9; i++) await store.put(`k${i}`, artifact(100, i));

		fake.failNextWrite(
			DB,
			'renders',
			new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
		);
		await expect(store.put('refused', artifact(100, 9))).resolves.toBeUndefined();
		expect(await store.stats()).toEqual({ entries: 7, bytes: 700 });
		expect(await store.get('refused')).toBeUndefined();

		await store.put('after', artifact(100, 10));
		expect((await store.get('after'))?.bytes).toBe(100);
		expect(await store.stats()).toEqual({ entries: 8, bytes: 800 });
	});
});

describe('ArtifactStore — upgrading a 0.1.4 store', () => {
	it('starts over with an honest count, since 0.1.4 keys can no longer be asked for', async () => {
		// The layout 0.1.4 wrote, with the inflated total its accounting produced over time.
		const old = await openDB(DB, 2, {
			upgrade(db) {
				db.createObjectStore('renders', { keyPath: 'key' }).createIndex('lastUsed', 'lastUsed');
				db.createObjectStore('meta', { keyPath: 'key' });
			},
		});
		await old.put('renders', { ...artifact(100), key: 'stored-by-0.1.4' });
		await old.put('meta', { key: 'total', totalBytes: 50_000_000, schema: 2 });
		old.close();

		store = new ArtifactStore(APP, 1000);
		expect(await store.stats()).toEqual({ entries: 0, bytes: 0 });
		expect(await store.get('stored-by-0.1.4')).toBeUndefined();

		await store.put('fresh', artifact(100));
		expect(await store.stats()).toEqual({ entries: 1, bytes: 100 });
	});
});
