import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from './support/fake-indexeddb';
import { RunStore, type StoredRunInfo } from '../src/cache/runs';
import type { SavedRunMessage, StoredRun } from '../engine-src/protocol';

/*
 * Saved preambles kept across the engine's stops (src/cache/runs.ts, internal/DECISIONS.md D36),
 * against an in-memory IndexedDB with real transactions (test/support/fake-indexeddb.ts): another
 * engine's runs are never read and are deleted, bytes that do not read back are deleted, a refused
 * write and a store that will not open cost nothing but the run, the budget is kept with the least
 * recently used out, and clearing leaves nothing.
 */

const fake = installFakeIndexedDB();
const APP = 'vault';
const DB = `tikzjax-next-${APP}-preambles`;
const MIB = 1024 * 1024;

let clock = 1000;
let budget = 10 * MIB;
let store: RunStore;

const make = (engineId = 'engine-a'): RunStore =>
	new RunStore({ appId: APP, engineId, budget: () => budget, now: () => clock++ });

/** A run as a worker hands it over: `bytes` long, with a preamble that took long enough to be worth it. */
function saved(route: string, bytes: number, extra: Partial<SavedRunMessage> = {}): SavedRunMessage {
	const data = new Uint8Array(bytes);
	data[0] = route.charCodeAt(0);
	return {
		type: 'saved-run',
		id: 1,
		epoch: 0,
		run: { route, data: data.buffer, compressed: true, rawBytes: bytes * 3 },
		preambleMs: 1000,
		saveMs: 10,
		encodeMs: 5,
		...extra,
	};
}

const keys = (name: string): string[] => [...fake.records(DB, name).keys()].map(String).sort();

/** The run `read` gave, or undefined where it gave none, or said why it would not. */
async function readRun(name: string): Promise<StoredRun | undefined> {
	const run = await store.read(name);
	return typeof run === 'object' ? run : undefined;
}

beforeEach(() => {
	fake.reset();
	clock = 1000;
	budget = 10 * MIB;
	store = make();
});

afterEach(() => {
	store.close();
});

describe('RunStore — keeping and reading', () => {
	it('keeps a run under its engine and name, and gives back its own copy of the bytes', async () => {
		await store.keep(saved('r1', 1000));
		expect(keys('runs')).toEqual(['engine-a/r1']);
		expect(keys('index')).toEqual(['engine-a/r1']);
		const one = await readRun('r1');
		const two = await readRun('r1');
		expect(one?.data.byteLength).toBe(1000);
		expect(one?.compressed).toBe(true);
		expect(one?.rawBytes).toBe(3000);
		expect(one?.data).not.toBe(two?.data);
		expect(store.stats()).toEqual({
			available: true,
			read: true,
			runs: 1,
			bytes: 1000,
			errors: 0,
			kept: 1,
			refused: {},
		});
	});

	it('reads nothing for a name it does not hold', async () => {
		expect(await store.read('nothing')).toBeUndefined();
	});

	it('reads what an earlier session stored, from the index alone until a run is wanted', async () => {
		await store.keep(saved('r1', 1000));
		store.close();
		store = make();
		await store.load();
		expect(store.info('r1')?.bytes).toBe(1000);
		expect((await readRun('r1'))?.data.byteLength).toBe(1000);
	});
});

describe('RunStore — engine ids', () => {
	it("never reads another engine's runs, and deletes them at the first load", async () => {
		await store.keep(saved('r1', 1000));
		store.close();

		store = make('engine-b');
		expect(await store.read('r1')).toBeUndefined();
		expect(store.stats().runs).toBe(0);
		await fake.idle();
		expect(keys('runs')).toEqual([]);
		expect(keys('index')).toEqual([]);
	});

	it("knows what is stored without waiting for another engine's runs to be deleted", async () => {
		store = make('engine-b');
		await store.keep(saved('mine', 1000));
		store.close();
		// A run of another engine's, as an update leaves the last one's.
		const db = await openDB(DB, 1);
		await db.put('runs', { key: 'engine-a/r1', data: new ArrayBuffer(8) });
		await db.put('index', {
			key: 'engine-a/r1',
			engineId: 'engine-a',
			route: 'r1',
			bytes: 8,
			lastUsed: 1,
		});
		db.close();

		store = make('engine-b');
		await store.load();
		expect(store.has('mine')).toBe(true);
		// The old engine's run is still there: its delete has not been waited for.
		expect(keys('runs')).toContain('engine-a/r1');
		await fake.idle();
		expect(keys('runs')).toEqual(['engine-b/mine']);
	});

	it('deletes an index record that does not say what it is, unread', async () => {
		const db = await openDB(DB, 1, {
			upgrade(d) {
				d.createObjectStore('runs', { keyPath: 'key' });
				d.createObjectStore('index', { keyPath: 'key' });
			},
		});
		await db.put('runs', { key: 'engine-a/odd', data: new ArrayBuffer(8) });
		await db.put('index', { key: 'engine-a/odd', engineId: 'engine-a', route: 'other', bytes: 8 });
		db.close();
		await store.load();
		expect(store.stats().runs).toBe(0);
		await fake.idle();
		expect(keys('runs')).toEqual([]);
	});
});

describe('RunStore — bytes that do not read back', () => {
	it('deletes a run whose bytes are not as long as they were stored, and counts it', async () => {
		await store.keep(saved('r1', 1000));
		const db = await openDB(DB, 1);
		await db.put('runs', { key: 'engine-a/r1', data: new ArrayBuffer(10) });
		db.close();
		expect(await store.read('r1')).toBeUndefined();
		expect(keys('runs')).toEqual([]);
		expect(store.stats()).toMatchObject({ runs: 0, errors: 1 });
	});

	it('deletes a run whose bytes are gone', async () => {
		await store.keep(saved('r1', 1000));
		const db = await openDB(DB, 1);
		await db.delete('runs', 'engine-a/r1');
		db.close();
		expect(await store.read('r1')).toBeUndefined();
		expect(keys('index')).toEqual([]);
	});

	it('deletes a run the worker could not read back (forget), and counts it', async () => {
		await store.keep(saved('r1', 1000));
		await store.forget('r1');
		expect(keys('runs')).toEqual([]);
		expect(keys('index')).toEqual([]);
		expect(store.stats()).toMatchObject({ runs: 0, errors: 1 });
		// Once.
		await store.forget('r1');
		expect(store.stats().errors).toBe(1);
	});

	it('counts no error for a run the browser evicted', async () => {
		await store.keep(saved('r1', 1000));
		const db = await openDB(DB, 1);
		await db.delete('runs', 'engine-a/r1');
		db.close();
		expect(await store.read('r1')).toBeUndefined();
		expect(store.stats().errors).toBe(0);
	});

	it('deletes an index record that does not say how long its run is inflated, unread', async () => {
		await store.keep(
			saved('r1', 1000, {
				run: { route: 'r1', data: new ArrayBuffer(8), compressed: true, rawBytes: -1 },
			}),
		);
		store.close();
		store = make();
		await store.load();
		expect(store.has('r1')).toBe(false);
		await fake.idle();
		expect(keys('runs')).toEqual([]);
	});
});

describe('RunStore — storage that refuses', () => {
	const quota = () => new DOMException('full', 'QuotaExceededError');

	it('makes room from the least recently used when a write is refused for room, and tries once more', async () => {
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		fake.failNextWrite(DB, 'runs', quota());
		await store.keep(saved('c', 1000));
		expect(keys('runs')).toEqual(['engine-a/b', 'engine-a/c']);
		expect(keys('index')).toEqual(['engine-a/b', 'engine-a/c']);
		expect(store.stats()).toMatchObject({ runs: 2, bytes: 2000, errors: 0 });
		expect(store.writable).toBe(true);
	});

	it('stops writing for the session when no room can be made, counts it, and goes on reading', async () => {
		await store.keep(saved('a', 1000));
		fake.failNextWrite(DB, 'runs', quota());
		// Larger than all there is to evict.
		await store.keep(saved('big', 2000));
		expect(store.stats()).toMatchObject({ runs: 1, errors: 1 });
		expect(store.writable).toBe(false);
		expect(store.readable).toBe(true);
		await store.keep(saved('r2', 1000));
		expect(keys('runs')).toEqual(['engine-a/a']);
		// What is stored is still read and sent.
		expect((await readRun('a'))?.data.byteLength).toBe(1000);
		// Clearing gives it another chance.
		await store.clear();
		expect(store.writable).toBe(true);
		await store.keep(saved('r3', 1000, { epoch: store.epoch }));
		expect(keys('runs')).toEqual(['engine-a/r3']);
	});

	it('stops writing when the write is refused for room again after room was made', async () => {
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		fake.failNextWrite(DB, 'runs', quota());
		fake.failNextWrite(DB, 'runs', quota());
		await store.keep(saved('c', 1000));
		expect(store.writable).toBe(false);
		expect(store.stats().errors).toBe(1);
		expect(keys('runs')).not.toContain('engine-a/c');
	});

	it('loses one run to any other refused write, and goes on', async () => {
		fake.failNextWrite(DB, 'index', new DOMException('refused', 'DataError'));
		await store.keep(saved('r1', 1000));
		expect(keys('runs')).toEqual([]);
		await store.keep(saved('r2', 1000));
		expect(keys('runs')).toEqual(['engine-a/r2']);
		expect(store.stats().errors).toBe(1);
	});

	it('runs without storage where IndexedDB will not open, and says so once', async () => {
		fake.failOpens(DB);
		await store.keep(saved('r1', 1000));
		expect(await store.read('r1')).toBeUndefined();
		await store.clear();
		expect(store.readable).toBe(false);
		expect(store.writable).toBe(false);
		expect(store.stats()).toMatchObject({ available: false, runs: 0, bytes: 0, errors: 1 });
	});
});

describe('RunStore — the budget', () => {
	it('makes room from the least recently used, and keeps the rest', async () => {
		budget = 3000;
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		await store.keep(saved('c', 1000));
		await store.read('a');
		await store.keep(saved('d', 1000));
		expect(keys('runs')).toEqual(['engine-a/a', 'engine-a/c', 'engine-a/d']);
		expect(store.stats()).toMatchObject({ runs: 3, bytes: 3000 });
	});

	it('replaces a run kept under the same name without evicting another for it', async () => {
		budget = 2000;
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		await store.keep(saved('a', 1000));
		expect(keys('runs')).toEqual(['engine-a/a', 'engine-a/b']);
	});

	it('stays within the budget when runs are kept at once, as two engines can', async () => {
		budget = 2500;
		await Promise.all([
			store.keep(saved('a', 1000)),
			store.keep(saved('b', 1000)),
			store.keep(saved('c', 1000)),
		]);
		expect(keys('runs')).toEqual(['engine-a/b', 'engine-a/c']);
		expect(store.stats()).toMatchObject({ runs: 2, bytes: 2000 });
	});

	it('keeps no run larger than the whole budget, and evicts nothing for it', async () => {
		budget = 2000;
		await store.keep(saved('a', 1000));
		await store.keep(saved('big', 3000));
		expect(keys('runs')).toEqual(['engine-a/a']);
	});

	/*
	 * Once a phone's engine handed over every run of a note as it went (D38), a note with more
	 * preambles than the store's 16 MiB filled it in the order they came, and its next visit found the
	 * runs of its first diagrams gone for its last, and stored its first ones again over the last: the
	 * least recently used went first, whatever their preambles had cost.
	 */
	it('keeps a run whose preamble took longer for longer: a minute for each millisecond', async () => {
		budget = 3000;
		await store.keep(saved('heavy', 1000, { preambleMs: 300 }));
		await store.keep(saved('light', 1000, { preambleMs: 20 }));
		await store.keep(saved('mid', 1000, { preambleMs: 100 }));
		// The newest, cheap as it is, makes room from the cheapest older one.
		await store.keep(saved('next', 1000, { preambleMs: 60 }));
		expect(keys('runs')).toEqual(['engine-a/heavy', 'engine-a/mid', 'engine-a/next']);
		// One that would go before the runs it would make room from is not kept, and evicts nothing.
		await store.keep(saved('cheap', 1000, { preambleMs: 5 }));
		expect(keys('runs')).toEqual(['engine-a/heavy', 'engine-a/mid', 'engine-a/next']);
		// Recency still decides over a day: a cheap run now is kept over one unused for a day that
		// cost three times as much.
		clock += 24 * 3600_000;
		await store.keep(saved('today', 1000, { preambleMs: 20 }));
		expect(keys('runs')).toEqual(['engine-a/heavy', 'engine-a/mid', 'engine-a/today']);
	});

	it('counts a diagram that started from the run in memory as a use of the run stored under its name', async () => {
		budget = 2000;
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		store.used('a');
		await store.keep(saved('c', 1000));
		expect(keys('runs')).toEqual(['engine-a/a', 'engine-a/c']);
		// Written down, for the next session too; at most once a minute a run.
		await fake.idle();
		const written = (fake.records(DB, 'index').get('engine-a/a') as StoredRunInfo).lastUsed;
		store.used('a');
		await fake.idle();
		expect((fake.records(DB, 'index').get('engine-a/a') as StoredRunInfo).lastUsed).toBe(written);
		store.used('nothing stored');
	});

	it('keeps a run the use of which survives the session', async () => {
		budget = 2000;
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		await store.read('a');
		await fake.idle();
		store.close();
		store = make();
		await store.keep(saved('c', 1000));
		expect(keys('runs')).toEqual(['engine-a/a', 'engine-a/c']);
	});
});

describe('RunStore — whether a run is worth putting back', () => {
	const info = (
		bytes: number,
		preambleMs: number,
	): Pick<StoredRunInfo, 'bytes' | 'rawBytes' | 'preambleMs' | 'saveMs'> => ({
		bytes,
		rawBytes: bytes * 3,
		preambleMs,
		saveMs: 0,
	});

	it('is when reading and restoring it costs less than its preamble took', () => {
		expect(store.worth(info(MIB, 1000))).toBe(true);
		expect(store.worth(info(MIB, 2))).toBe(false);
	});

	it('neither keeps nor sends a run that is not', async () => {
		await store.keep(saved('cheap', MIB, { preambleMs: 1, saveMs: 1 }));
		expect(keys('runs')).toEqual([]);
	});

	it('leans on what putting runs back took on this device', () => {
		const run = { bytes: MIB, rawBytes: 3 * MIB };
		const before = store.estimateMs(run);
		for (let i = 0; i < 20; i++) store.measured(run, 100, 300);
		expect(store.estimateMs(run)).toBeGreaterThan(before * 10);
		expect(store.worth(info(MIB, 200))).toBe(false);
	});

	it('moves by at most 1.75 times on one slow sample', () => {
		// tikz-cd's run, 0.40 MiB stored and 1.26 raw, read in 300 ms behind something else.
		const tikzcd = { bytes: 0.4 * MIB, rawBytes: 1.26 * MIB };
		// circuitikz's, 2.83 and 8.88 MiB.
		const circuitikz = { bytes: 2.83 * MIB, rawBytes: 8.88 * MIB };
		const before = store.estimateMs(circuitikz) - 12;
		store.measured(tikzcd, 300, 1000);
		expect(store.estimateMs(circuitikz) - 12).toBeCloseTo(before * 1.75, 5);
		expect(store.worth({ ...circuitikz, preambleMs: 300, saveMs: 40 })).toBe(true);
	});

	it('goes back towards the figures it started from for each run it does not send', async () => {
		await store.keep(saved('big', 2 * MIB, { preambleMs: 100, saveMs: 0 }));
		const run = { bytes: 2 * MIB, rawBytes: 6 * MIB };
		for (let i = 0; i < 20; i++) store.measured(run, 400, 1000);
		// Not sent, and says why.
		expect(await store.read('big')).toBe('not-worth');
		let tries = 1;
		while ((await store.read('big')) === 'not-worth' && tries < 50) tries++;
		expect(tries).toBeGreaterThan(1);
		expect(tries).toBeLessThan(50);
	});

	it('keeps a run worth putting back by the figures a session starts from, however slow it was here', async () => {
		const run = { bytes: MIB, rawBytes: 3 * MIB };
		for (let i = 0; i < 20; i++) store.measured(run, 1000, 3000);
		await store.keep(saved('r1', MIB, { preambleMs: 200, saveMs: 10 }));
		expect(keys('runs')).toEqual(['engine-a/r1']);
	});
});

/*
 * The maintainer's iPhone said of circuitikz's diagram "preamble saved in 3 ms, not kept: no room",
 * and nothing said whether its run reached the store, nor what the store made of it: the store now
 * counts what it kept this session and what it refused, by why (internal/DECISIONS.md D39).
 */
describe('RunStore — what it says it kept and refused', () => {
	const refused = () => store.stats().refused;

	it('counts each run kept, and each refused with why', async () => {
		budget = 3000;
		await store.keep(saved('heavy', 1000, { preambleMs: 300 }));
		await store.keep(saved('mid', 1000, { preambleMs: 100 }));
		await store.keep(saved('next', 1000, { preambleMs: 60 }));
		// Larger than the whole budget.
		await store.keep(saved('big', 4000));
		// Not worth putting back.
		await store.keep(saved('cheap', 1000, { preambleMs: 1, saveMs: 1 }));
		// Would itself go before the runs it would make room from.
		await store.keep(saved('light', 1000, { preambleMs: 15 }));
		expect(store.stats().kept).toBe(3);
		expect(refused()).toEqual({ 'too-large': 1, 'not-worth': 1, 'goes-first': 1 });
	});

	it('counts a run saved before a clear and handed over after it', async () => {
		await store.load();
		await store.clear();
		await store.keep(saved('before', 1000, { epoch: 0 }));
		expect(refused()).toEqual({ cleared: 1 });
	});

	it('counts the runs storage had no room for, and those it refused otherwise', async () => {
		await store.keep(saved('a', 1000));
		fake.failNextWrite(DB, 'index', new DOMException('refused', 'DataError'));
		await store.keep(saved('b', 1000));
		fake.failNextWrite(DB, 'runs', new DOMException('full', 'QuotaExceededError'));
		await store.keep(saved('big', 2000));
		// Out of room for the session: every run after it too.
		await store.keep(saved('c', 1000));
		expect(store.stats().kept).toBe(1);
		expect(refused()).toEqual({ failed: 1, full: 2 });
	});

	it('counts the runs handed over while storage will not open', async () => {
		fake.failOpens(DB);
		await store.keep(saved('r1', 1000));
		expect(refused()).toEqual({ unavailable: 1 });
	});

	it('says a read that failed is why a stored run was not sent', async () => {
		await store.keep(saved('r1', 1000));
		(store as unknown as { run: () => Promise<never> }).run = () => Promise.reject(new Error('gone'));
		expect(await store.read('r1')).toBe('read-failed');
		expect(store.stats().errors).toBe(1);
	});
});

describe('RunStore — clearing', () => {
	it('deletes every run: saved preambles turned off, or the cache cleared', async () => {
		await store.keep(saved('a', 1000));
		await store.keep(saved('b', 1000));
		await store.clear();
		expect(keys('runs')).toEqual([]);
		expect(keys('index')).toEqual([]);
		expect(store.stats().runs).toBe(0);
		expect(await store.read('a')).toBeUndefined();
	});

	it('keeps no run saved before a clear and handed over after it', async () => {
		await store.load();
		await store.clear();
		expect(store.epoch).toBe(1);
		await store.keep(saved('before', 1000, { epoch: 0 }));
		await store.keep(saved('after', 1000, { epoch: store.epoch }));
		expect(keys('runs')).toEqual(['engine-a/after']);
	});

	it('lets nothing kept while it clears come back after it', async () => {
		await store.load();
		const keeping = store.keep(saved('a', 1000));
		const clearing = store.clear();
		await Promise.all([keeping, clearing]);
		await fake.idle();
		expect(keys('runs')).toEqual([]);
		expect(store.stats().runs).toBe(0);
	});

	it('creates no database for a vault that never kept any (discard)', async () => {
		await store.discard();
		expect(fake.opens.get(DB) ?? 0).toBe(0);
	});

	it('deletes what a vault kept when saved preambles are found off at load (discard)', async () => {
		await store.keep(saved('a', 1000));
		store.close();
		store = make();
		await store.discard();
		expect(keys('runs')).toEqual([]);
	});
});
