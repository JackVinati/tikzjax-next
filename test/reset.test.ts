import { beforeAll, describe, expect, it } from 'vitest';
import type { CoreDump } from '../engine-src/core-dump';
import {
	LAYOUT_NAMES,
	restoreSpans,
	writtenSpans,
	type MemoryLayout,
	type RunMarks,
	type Span,
} from '../engine-src/reset';
import { readCoreDump, readMemoryLayout, RESET_NAMES } from '../scripts/engine-assets.mjs';

/*
 * The worker keeps one Memory and, before each run, writes the core dump back over only the parts
 * the run before can have written (engine-src/reset.ts, internal/DECISIONS.md D31). These hold the
 * two halves to what they promise, on the committed engine's layout and dump: which parts, and the
 * writing back. scripts/verify-reset.mjs holds the whole to a new Memory, byte for byte, over every
 * fixture in five orders.
 */

let dump: Uint8Array;
let layout: MemoryLayout;
let top: number;

beforeAll(() => {
	dump = readCoreDump('.');
	layout = readMemoryLayout('.');
	top = layout.pages * 65536;
}, 120_000);

const int = (memory: Uint8Array, name: string): number =>
	new DataView(memory.buffer, memory.byteOffset, memory.length).getInt32(
		layout.variables[name]!.offset,
		true,
	);

/** Marks as a run that moved nothing would leave them: its counters where the dump has them. */
const still = (memory: Uint8Array): RunMarks => ({
	poolPtrHigh: int(memory, 'pool_ptr'),
	strPtrHigh: int(memory, 'str_ptr'),
	stackLow: top - 64,
});

/** Where two memories of the same length first differ, a word at a time, or -1. */
const firstDifference = (x: Uint8Array, y: Uint8Array): number => {
	const a = new Uint32Array(x.buffer, x.byteOffset, x.length >>> 2);
	const b = new Uint32Array(y.buffer, y.byteOffset, y.length >>> 2);
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i * 4;
	return -1;
};

const total = (spans: readonly Span[]) => spans.reduce((n, [a, b]) => n + b - a, 0);

const covers = (spans: readonly Span[], from: number, to: number) =>
	spans.some(([a, b]) => a <= from && to <= b);

/** Byte `i` of TeX's array `name`'s entry `index`. */
const at = (name: string, index: number): number => {
	const v = layout.variables[name]!;
	return v.offset + (index - (v.min ?? 0)) * (v.entry ?? 1);
};

describe('the parts of the memory a run can have written', () => {
	it('are in order and apart, and every global but the arrays TeX fills from one end is among them', () => {
		const spans = writtenSpans(dump, layout, still(dump))!;
		expect(spans).toBeDefined();
		for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThan(spans[i - 1]![1]);
		for (const name of ['eqtb', 'buffer', 'input_stack', 'xeq_level', 'hyph_word', 'term_in', 'dvi_buf'])
			expect(
				covers(spans, layout.variables[name]!.offset, layout.variables[name]!.offset + 1),
				name,
			).toBe(true);
		// The string literals, as a guard, and the stack from where it went down to the top.
		expect(covers(spans, layout.globalsEnd, layout.dataEnd)).toBe(true);
		expect(covers(spans, top - 64, top)).toBe(true);
		// About 26.5 MiB on the committed dump, of the 156.25 a new Memory would be.
		expect(total(spans)).toBeGreaterThan(20 * 1048576);
		expect(total(spans)).toBeLessThan(32 * 1048576);
	});

	it("follow TeX's counters into its big arrays, and no further", () => {
		const spans = writtenSpans(dump, layout, still(dump))!;
		const lo = int(dump, 'lo_mem_max');
		const hi = int(dump, 'hi_mem_min');
		expect(covers(spans, at('mem', 0), at('mem', lo + 1))).toBe(true);
		expect(covers(spans, at('mem', hi), at('mem', int(dump, 'mem_end')))).toBe(true);
		expect(covers(spans, at('mem', (lo + hi) >> 1), at('mem', (lo + hi) >> 1) + 8)).toBe(false);
		const fmem = int(dump, 'fmem_ptr');
		expect(covers(spans, at('font_info', fmem - 1), at('font_info', fmem))).toBe(true);
		expect(covers(spans, at('font_info', fmem + 64), at('font_info', fmem + 65))).toBe(false);
		// The pattern arrays are never written once a format is loaded.
		expect(covers(spans, at('trie_c', 100), at('trie_c', 101))).toBe(false);
	});

	it('reach as far into the string pool as pool_ptr went in the run, not where it ended', () => {
		const pool = int(dump, 'pool_ptr');
		const ended = writtenSpans(dump, layout, still(dump))!;
		expect(covers(ended, at('str_pool', pool + 40_000), at('str_pool', pool + 40_001))).toBe(false);
		const went = writtenSpans(dump, layout, { ...still(dump), poolPtrHigh: pool + 40_228 })!;
		expect(covers(went, at('str_pool', 0), at('str_pool', pool + 40_228))).toBe(true);
		const strings = int(dump, 'str_ptr');
		const made = writtenSpans(dump, layout, { ...still(dump), strPtrHigh: strings + 5000 })!;
		expect(covers(made, at('str_start', 0), at('str_start', strings + 5000) + 4)).toBe(true);
	});

	it('reach as far down the stack as it went', () => {
		const spans = writtenSpans(dump, layout, { ...still(dump), stackLow: top - 3297 })!;
		expect(covers(spans, top - 3297, top)).toBe(true);
		expect(covers(spans, top - 3298, top - 3297)).toBe(false);
	});

	it('take in what the host wrote', () => {
		const far = layout.dataEnd + 1_000_000;
		const spans = writtenSpans(dump, layout, still(dump), [[far, far + 10]])!;
		expect(covers(spans, far, far + 10)).toBe(true);
	});

	it('are not given for a memory that is not this engine’s after a run of TeX', () => {
		const marks = still(dump);
		// A counter outside the array it counts.
		const bent = new Uint8Array(dump);
		new DataView(bent.buffer).setInt32(layout.variables.pool_ptr!.offset, 7_000_000, true);
		expect(writtenSpans(bent, layout, marks)).toBeUndefined();
		// The stack below the string literals, a mark the engine did not give, a layout short of
		// what the reset reads, a memory of another size.
		expect(writtenSpans(dump, layout, { ...marks, stackLow: layout.dataEnd - 1 })).toBeUndefined();
		expect(writtenSpans(dump, layout, { ...marks, poolPtrHigh: -1 })).toBeUndefined();
		const { hash_used: _gone, ...rest } = layout.variables;
		expect(writtenSpans(dump, { ...layout, variables: rest }, marks)).toBeUndefined();
		expect(writtenSpans(dump.subarray(0, dump.length - 65536), layout, marks)).toBeUndefined();
	});
});

describe('the layout the worker carries', () => {
	it('is the place of every global the reset reads, and of no other', () => {
		expect([...RESET_NAMES].sort()).toEqual([...LAYOUT_NAMES].sort());
	});
});

describe('writing the dump back', () => {
	/** A small dump: zeros but for three runs. */
	const small: CoreDump = {
		size: 4096,
		runs: [
			{ offset: 100, bytes: Uint8Array.from({ length: 50 }, (_, i) => i + 1) },
			{ offset: 1000, bytes: Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255 || 9) },
			{ offset: 3000, bytes: Uint8Array.from({ length: 10 }, () => 200) },
		],
	};
	const image = (() => {
		const out = new Uint8Array(small.size);
		for (const run of small.runs) out.set(run.bytes, run.offset);
		return out;
	})();

	it('puts the dump back over the spans, runs and zeros alike, and leaves the rest alone', () => {
		const memory = new Uint8Array(small.size).fill(0xee);
		const spans: Span[] = [
			[0, 120],
			[140, 1100],
			[1250, 1260],
			[2990, 3005],
			[4000, 4096],
		];
		expect(restoreSpans(memory, small, spans)).toBe(total(spans));
		for (let i = 0; i < small.size; i++) {
			const inside = spans.some(([a, b]) => a <= i && i < b);
			expect(memory[i], `byte ${i}`).toBe(inside ? image[i] : 0xee);
		}
	});

	it('makes the whole memory the dump again when the spans cover it, from any dirt', () => {
		let seed = 7;
		const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 255;
		for (let round = 0; round < 20; round++) {
			const memory = Uint8Array.from({ length: small.size }, random);
			const cuts = [
				...new Set([0, small.size, ...Array.from({ length: 6 }, () => (random() * 16) % small.size)]),
			].sort((a, b) => a - b);
			const spans: Span[] = [];
			for (let i = 1; i < cuts.length; i++) spans.push([cuts[i - 1]!, cuts[i]!]);
			restoreSpans(memory, small, spans);
			expect(memory).toEqual(image);
		}
	});

	it('restores the committed dump exactly, over what writtenSpans gives for it', () => {
		const memory = new Uint8Array(dump);
		const spans = writtenSpans(memory, layout, { ...still(memory), stackLow: top - 4096 })!;
		for (const [a, b] of spans) memory.fill(0x5a, a, Math.min(b, a + 4096));
		const runs: CoreDump = { size: dump.length, runs: [{ offset: 0, bytes: dump }] };
		restoreSpans(memory, runs, spans);
		expect(firstDifference(memory, dump)).toBe(-1);
	});
});
