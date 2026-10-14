import { beforeAll, describe, expect, it } from 'vitest';
import { unpackCoreDump, type CoreDump } from '../engine-src/core-dump';
import type { HostState } from '../engine-src/library';
import type { MemoryLayout, RunMarks, Span } from '../engine-src/reset';
import {
	BLOCK,
	diffAgainstDump,
	saveSpans,
	SnapshotCache,
	stretchSpans,
	unionSpans,
	writeStretches,
	type SavedRun,
	type Stretch,
} from '../engine-src/snapshot';
import { packCoreDump, readCoreDump, readMemoryLayout } from '../scripts/engine-assets.mjs';

/*
 * A saved run is TeX's globals where they differ from the core dump, as a first pass left them at the
 * end of its \begin{document}, and later diagrams with the same preamble start from it
 * (engine-src/snapshot.ts, internal/DECISIONS.md D32). These hold its parts to what they promise, on
 * the committed engine's dump and layout where it matters: what a save compares, what it keeps, and
 * which saved runs are kept. scripts/verify-snapshot.mjs holds the whole to a run from the start,
 * byte for byte.
 */

let dumpBytes: Uint8Array;
let dump: CoreDump;
let layout: MemoryLayout;
let top: number;

beforeAll(() => {
	dumpBytes = readCoreDump('.');
	const packed = packCoreDump(dumpBytes);
	dump = unpackCoreDump(packed.size, packed.runs, packed.bytes);
	layout = readMemoryLayout('.');
	top = layout.pages * 65536;
}, 120_000);

const int = (memory: Uint8Array, name: string): number =>
	new DataView(memory.buffer, memory.byteOffset, memory.length).getInt32(
		layout.variables[name]!.offset,
		true,
	);

/** Marks as a run that moved nothing would leave them. */
const still = (memory: Uint8Array): RunMarks => ({
	poolPtrHigh: int(memory, 'pool_ptr'),
	strPtrHigh: int(memory, 'str_ptr'),
	stackLow: top - 64,
});

const pieces = (memory: Uint8Array, spans: readonly Span[]): Stretch[] =>
	spans.map(([a, b]) => ({ offset: a, bytes: memory.subarray(a, b) }));

describe('what a save compares', () => {
	it("is TeX's globals that a run can have written, in whole blocks, and nothing above them", () => {
		const spans = saveSpans(dumpBytes, layout, still(dumpBytes), [])!;
		expect(spans.length).toBeGreaterThan(0);
		for (let i = 0; i < spans.length; i++) {
			const [a, b] = spans[i]!;
			expect(a % BLOCK).toBe(0);
			expect(b % BLOCK).toBe(0);
			expect(b).toBeGreaterThan(a);
			if (i > 0) expect(a).toBeGreaterThan(spans[i - 1]![1]);
		}
		// Not the string literals' far end, and not the stack: what is on it belongs to calls a run that
		// resumes does not return to.
		expect(spans[spans.length - 1]![1]).toBeLessThanOrEqual(layout.globalsEnd + BLOCK);
		const total = spans.reduce((n, [a, b]) => n + b - a, 0);
		// About 26.5 MiB on the committed dump, as for the reset.
		expect(total).toBeGreaterThan(20 * 1048576);
		expect(total).toBeLessThan(32 * 1048576);
		const eqtb = layout.variables.eqtb!.offset;
		expect(spans.some(([a, b]) => a <= eqtb && eqtb < b)).toBe(true);
	});

	it('is not given for a memory the reset cannot account for', () => {
		const bent = new Uint8Array(dumpBytes);
		new DataView(bent.buffer).setInt32(layout.variables.pool_ptr!.offset, 7_000_000, true);
		expect(saveSpans(bent, layout, still(dumpBytes), [])).toBeUndefined();
	});
});

describe('what a save keeps', () => {
	it('is nothing for a memory that is the dump', () => {
		const spans = saveSpans(dumpBytes, layout, still(dumpBytes), [])!;
		expect(diffAgainstDump(pieces(dumpBytes, spans), dump)).toEqual([]);
	});

	it('is every block in which a byte differs, whole, those side by side as one, as copies', () => {
		const memory = new Uint8Array(dumpBytes);
		const spans = saveSpans(memory, layout, still(memory), [])!;
		const eqtb = layout.variables.eqtb!.offset;
		const hi = layout.variables.mem!.offset + int(memory, 'hi_mem_min') * 8;
		// One byte in eqtb, where the dump has bytes; two in blocks side by side in mem; one in a
		// stretch the dump has zero.
		const lone = eqtb + 1000;
		memory[lone] = memory[lone]! ^ 0xff;
		const pair = hi + 4 * BLOCK + 10;
		memory[pair] = memory[pair]! ^ 1;
		memory[pair + BLOCK] = memory[pair + BLOCK]! ^ 1;
		// The first byte the save compares that the dump has zero, in a block of its own.
		const blockOf = (i: number) => i - (i % BLOCK);
		let zero = -1;
		for (const [a, b] of spans)
			for (let i = a; i < b && zero < 0; i++)
				if (dumpBytes[i] === 0 && ![lone, pair, pair + BLOCK].some((j) => blockOf(j) === blockOf(i)))
					zero = i;
		expect(zero).toBeGreaterThanOrEqual(0);
		memory[zero] = 7;
		const stretches = diffAgainstDump(pieces(memory, spans), dump);
		expect(stretches.map((s) => [s.offset, s.bytes.length])).toEqual(
			[
				[blockOf(zero), BLOCK],
				[blockOf(lone), BLOCK],
				[blockOf(pair), 2 * BLOCK],
			].sort((x, y) => x[0]! - y[0]!),
		);
		for (const s of stretches)
			expect(s.bytes).toEqual(memory.subarray(s.offset, s.offset + s.bytes.length));
		// Copies: TeX goes on writing into the memory after the save.
		const before = stretches[0]!.bytes[0];
		memory[stretches[0]!.offset] = memory[stretches[0]!.offset]! ^ 0xff;
		expect(stretches[0]!.bytes[0]).toBe(before);
	});

	it('is the same with the dump packed at any alignment, read a byte at a time', () => {
		const size = 8 * BLOCK;
		const image = new Uint8Array(size);
		for (let i = 300; i < 900; i++) image[i] = (i * 13) & 255 || 1;
		for (let i = 1500; i < 1503; i++) image[i] = 9;
		const memory = new Uint8Array(image);
		memory[310] = memory[310]! ^ 1;
		memory[1501] = 0;
		memory[2047] = 3;
		const spans: Span[] = [[0, size]];
		const aligned = packCoreDump(image, 16);
		const byWords = diffAgainstDump(
			pieces(memory, spans),
			unpackCoreDump(size, aligned.runs, aligned.bytes),
		);
		// Runs that start and end anywhere, as the build packed the dump before the snapshot.
		const odd: CoreDump = {
			size,
			runs: [
				{ offset: 299, bytes: image.slice(299, 901) },
				{ offset: 1499, bytes: image.slice(1499, 1503) },
			],
		};
		expect(diffAgainstDump(pieces(memory, spans), odd)).toEqual(byWords);
		expect(byWords.map((s) => s.offset)).toEqual([256, 1280, 1792]);
	});

	it('reads the bytes of a word cut by either end of a run of the dump one by one', () => {
		const size = 4 * BLOCK;
		const spans: Span[] = [[0, size]];
		/** The dump of one run of 7s over [from, to), and what a save keeps of it with `changed` set. */
		const kept = (from: number, to: number, changed: number | null): number[] => {
			const image = new Uint8Array(size);
			image.fill(7, from, to);
			const one: CoreDump = { size, runs: [{ offset: from, bytes: image.slice(from, to) }] };
			const memory = new Uint8Array(image);
			if (changed !== null) memory[changed] = 5;
			return diffAgainstDump(pieces(memory, spans), one).map((s) => s.offset);
		};
		// A run that starts off a word: a byte changed in the zeros of the word it starts in is kept.
		expect(kept(299, 400, null)).toEqual([]);
		expect(kept(299, 400, 297)).toEqual([256]);
		expect(kept(299, 400, 298)).toEqual([256]);
		// One that ends off a word: the word it ends in is not taken for a change, and a byte changed
		// in the zeros after it is kept.
		expect(kept(300, 401, null)).toEqual([]);
		expect(kept(300, 401, 401)).toEqual([256]);
		expect(kept(300, 401, 403)).toEqual([256]);
	});

	it('is refused for a piece that is not whole blocks', () => {
		expect(() => diffAgainstDump([{ offset: 10, bytes: new Uint8Array(BLOCK) }], dump)).toThrow();
	});
});

describe('starting from a saved run', () => {
	it('writes its stretches over the dump, and says where, for the reset after it', () => {
		const memory = new Uint8Array(4 * BLOCK);
		const stretches: Stretch[] = [
			{ offset: 0, bytes: new Uint8Array(BLOCK).fill(1) },
			{ offset: BLOCK, bytes: new Uint8Array(BLOCK).fill(2) },
			{ offset: 3 * BLOCK, bytes: new Uint8Array(BLOCK).fill(3) },
		];
		writeStretches(memory, stretches);
		expect([memory[0], memory[BLOCK], memory[2 * BLOCK], memory[3 * BLOCK]]).toEqual([1, 2, 0, 3]);
		expect(stretchSpans(stretches)).toEqual([
			[0, 2 * BLOCK],
			[3 * BLOCK, 4 * BLOCK],
		]);
	});

	it('has the reset put back what the run wrote and what the stretches did', () => {
		expect(
			unionSpans(
				[
					[0, 10],
					[50, 60],
				],
				[
					[5, 20],
					[60, 70],
					[100, 110],
				],
			),
		).toEqual([
			[0, 20],
			[50, 70],
			[100, 110],
		]);
	});
});

describe('the saved runs a worker keeps', () => {
	const host: HostState = { files: [], filesystem: {}, inputBuffer: null, consoleBuffer: '' };
	const run = (prefix: string, bytes: number, logging = true): SavedRun => ({
		prefix,
		logging,
		route: prefix,
		stretches: [],
		spans: [],
		host,
		log: [],
		missing: [],
		bytes,
	});

	it('are found by the longest text an input starts with, for the same logging', () => {
		const cache = new SnapshotCache(100);
		cache.tick();
		expect(cache.set(run('\\a\n', 10))).toBe(true);
		expect(cache.set(run('\\a\n\\b\n', 10))).toBe(true);
		expect(cache.set(run('\\a\n\\b\n', 10, false))).toBe(true);
		expect(cache.find('\\a\n\\b\n\\c', true)?.prefix).toBe('\\a\n\\b\n');
		expect(cache.find('\\a\n\\c', true)?.prefix).toBe('\\a\n');
		expect(cache.find('\\a\n\\b\n\\c', false)?.logging).toBe(false);
		expect(cache.find('\\c', true)).toBeUndefined();
		expect(cache.size).toBe(3);
		expect(cache.bytes).toBe(30);
		expect(cache.routes().sort()).toEqual(['\\a\n', '\\a\n\\b\n', '\\a\n\\b\n']);
	});

	/** A render as the worker makes it: resumed, saved, not saved, or refused after the save. */
	const render = (cache: SnapshotCache, name: string, bytes = 10): string => {
		cache.tick();
		if (cache.find(`${name}\nbody`, true) !== undefined) return 'resumed';
		if (!cache.wants()) return 'plain';
		return cache.set(run(`${name}\n`, bytes)) ? 'saved' : 'refused';
	};

	it('stay within the budget, the least recently used going first', () => {
		const cache = new SnapshotCache(30);
		expect(['a', 'b', 'c'].map((name) => render(cache, name))).toEqual(['saved', 'saved', 'saved']);
		expect(render(cache, 'a')).toBe('resumed');
		// Full: d goes in place of b, the least recently used of those not resumed from; a was
		// resumed from just now, and stays.
		expect(render(cache, 'd')).toBe('saved');
		expect(cache.find('b\nbody', true)).toBeUndefined();
		expect(cache.find('a\nbody', true)).toBeDefined();
		expect(cache.bytes).toBeLessThanOrEqual(30);
		expect(cache.set(run('big\n', 31))).toBe(false);
	});

	it('keep the runs resumed from lately when they are full, and save again once one has been idle', () => {
		// Two diagrams of each preamble in turn, as a note of diagrams that share theirs draws.
		const cache = new SnapshotCache(30);
		const drawn = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd'].map((name) => render(cache, name));
		expect(drawn).toEqual(['saved', 'resumed', 'saved', 'resumed', 'saved', 'resumed', 'plain', 'plain']);
		// Sixteen renders later, a, the least recently used, goes for e.
		for (let i = 0; i < 16; i++) cache.tick();
		expect(['e', 'e'].map((name) => render(cache, name))).toEqual(['saved', 'resumed']);
		expect(cache.find('a\nbody', true)).toBeUndefined();
	});

	it('never evict a run in use, nor one resumed from lately, and say when nothing could go', () => {
		const cache = new SnapshotCache(20, 4);
		render(cache, 'a');
		render(cache, 'b');
		const a = cache.find('a\n', true)!;
		cache.find('b\n', true);
		cache.pin(a);
		// Both resumed from within the last 4 renders: a new run does not fit, and is not kept.
		expect(cache.wants()).toBe(false);
		expect(cache.set(run('c\n', 10))).toBe(false);
		for (let i = 0; i < 5; i++) cache.tick();
		// b has not been used for longer than that, and goes; a is in use, and stays.
		expect(cache.wants()).toBe(true);
		expect(cache.set(run('c\n', 10))).toBe(true);
		expect(cache.find('a\n', true)).toBeDefined();
		expect(cache.find('b\n', true)).toBeUndefined();
		// A run in use is not replaced either.
		expect(cache.set(run('a\n', 5))).toBe(false);
		// Turned off, the cache lets every run go but the one in use, and saves nothing.
		cache.setBudget(0);
		expect(cache.size).toBe(1);
		expect(cache.wants()).toBe(false);
		cache.unpin(a);
		cache.setBudget(0);
		expect(cache.size).toBe(0);
		expect(cache.bytes).toBe(0);
	});

	it('hold a smaller budget at once when it shrinks, as on a phone', () => {
		const cache = new SnapshotCache(32);
		cache.tick();
		for (const name of ['a', 'b', 'c']) cache.set(run(`${name}\n`, 10));
		cache.setBudget(12);
		expect(cache.bytes).toBeLessThanOrEqual(12);
		expect(cache.find('c\n', true)).toBeDefined();
	});
});
