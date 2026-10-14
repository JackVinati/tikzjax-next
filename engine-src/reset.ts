/**
 * One Memory per worker, reset before each run over only what the run before it can have written.
 *
 * Every run used to get a new WebAssembly.Memory, 156.25 MiB, with the core dump's non-zero runs
 * written into it (./core-dump). When the old ones are freed is the collector's business, and until
 * it gets to them each one counts in full against the memory the process has committed, several at
 * a time in WebKit, the engine of every iPhone, and in V8 (internal/DECISIONS.md D31 has the
 * figures). A worker now keeps the Memory of its last run, and before the next one writes the
 * dump's bytes back over the parts of it that run can have written:
 *
 *  - every global variable of TeX's, whole, except the arrays below;
 *  - of TeX's big arrays, the part its own counters say is in use, as TeX itself never writes past
 *    them: `mem` up to lo_mem_max and from hi_mem_min to mem_end, `font_info` up to fmem_ptr, the
 *    hash table's primary slots and the overflow slots from hash_used up, `save_stack` up to the
 *    highest it has been;
 *  - `str_pool` and `str_start` up to the highest pool_ptr and str_ptr reached in the run, which the
 *    engine marks (engine-build/web2js-codegen): a string made and then flushed leaves its
 *    characters past where pool_ptr ends the run;
 *  - the pattern arrays not at all, since TeX refuses `\patterns` once a format is loaded;
 *  - the string literals after the globals, which nothing writes, whole, as a guard;
 *  - the shadow stack from the lowest the engine marked it reaching to the top of the memory;
 *  - whatever the host wrote into the memory (library.ts `hostWrites`), which is TeX's buffer and
 *    its file variables, among the globals already.
 *
 * The layout comes from the engine build (engine-build/out/memory-layout.json). A run that did not
 * end normally, a counter that is not where TeX keeps it, or anything else this cannot account for,
 * and the worker takes a new Memory instead (worker.ts). scripts/verify-reset.mjs holds the result
 * to a fresh Memory, byte for byte, after every run of every fixture in five orders.
 */
import type { CoreDump } from './core-dump';

/** A stretch of the memory, [start, end) in bytes. */
export type Span = readonly [start: number, end: number];

/** A global of TeX's as the build laid it out: an array also has its index range and entry size. */
export interface LayoutVariable {
	offset: number;
	bytes: number;
	min?: number;
	max?: number;
	entry?: number;
}

/** What of engine-build/out/memory-layout.json the reset reads. */
export interface MemoryLayout {
	pages: number;
	/** Where the last global ends. The string literals follow, then free memory, then the stack. */
	globalsEnd: number;
	/** Where the string literals end. */
	dataEnd: number;
	/** The slots a name can hash to, from the hash table's first entry. */
	hashPrime: number;
	variables: Readonly<Record<string, LayoutVariable>>;
}

/** What the engine marked during the run (engine-build/web2js-codegen). */
export interface RunMarks {
	/** The highest value pool_ptr held. */
	poolPtrHigh: number;
	/** The highest value str_ptr held. */
	strPtrHigh: number;
	/** The lowest the shadow stack pointer went. */
	stackLow: number;
}

/** A counter's value, read from the memory. */
type Read = (name: string) => number;

/**
 * Each array that is not reset whole, with the indexes of it a run can have written, as inclusive
 * [first, last] pairs. An entry or two of slack where TeX writes just past a counter it then moves.
 */
const PARTS: Readonly<
	Record<string, (read: Read, marks: RunMarks, layout: MemoryLayout) => [number, number][]>
> = {
	// Variable-size nodes grow up from the bottom to lo_mem_max, one-word nodes down from mem_end
	// to hi_mem_min, and nothing is ever written between; all three only ever move outwards.
	mem: (read) => [
		[0, read('lo_mem_max') + 1],
		[read('hi_mem_min'), read('mem_end')],
	],
	// Characters are appended at pool_ptr, which comes back down when a string is flushed: the
	// highest it reached bounds what was written.
	str_pool: (read, marks) => [[0, Math.max(read('pool_ptr'), marks.poolPtrHigh) + 1]],
	str_start: (read, marks) => [[0, Math.max(read('str_ptr'), marks.strPtrHigh) + 1]],
	// A font is loaded at fmem_ptr, which is moved past it once it has loaded; the fonts are the
	// engine's own, so none stops loading half-way.
	font_info: (read) => [[0, read('fmem_ptr')]],
	trie: (read) => [[0, read('trie_max')]],
	// A name goes to its slot among the hash_prime from the first entry, or, if that is taken, to
	// the next free slot below hash_used, which only moves down; above that are the frozen ones.
	hash: (read, _marks, layout) => {
		const first = layout.variables.hash?.min ?? 0;
		return [
			[first, first + layout.hashPrime - 1],
			[read('hash_used'), layout.variables.hash?.max ?? 0],
		];
	},
	// max_save_stack is the highest save_ptr checked for room, and TeX writes up to seven entries
	// past a check before the next one.
	save_stack: (read) => [[0, read('max_save_stack') + 8]],
	// Written only while patterns are read, which TeX refuses once a format is loaded.
	trie_c: () => [],
	trie_o: () => [],
	trie_l: () => [],
	trie_r: () => [],
	trie_hash: () => [],
	trie_taken: () => [],
	trie_op_hash: () => [],
};

/** The counters PARTS reads, each with the array it indexes and how far past its last index it may be. */
const COUNTERS: Readonly<Record<string, readonly [array: string, slack: number]>> = {
	lo_mem_max: ['mem', 0],
	hi_mem_min: ['mem', 0],
	mem_end: ['mem', 0],
	pool_ptr: ['str_pool', 1],
	str_ptr: ['str_start', 0],
	fmem_ptr: ['font_info', 1],
	trie_max: ['trie', 0],
	hash_used: ['hash', 1],
	max_save_stack: ['save_stack', 0],
};

/** The names of the globals the reset reads, for the build to carry of the layout and no more. */
export const LAYOUT_NAMES: readonly string[] = [...Object.keys(PARTS), ...Object.keys(COUNTERS)];

/** Gaps narrower than this between two stretches are written too: fewer calls, the same bytes. */
const GAP = 4096;

/**
 * The stretches of `memory` a run can have written, sorted, apart and merged, or undefined when the
 * memory does not look like this engine's after a run of TeX: a counter outside the array it
 * counts, a layout without what the reset reads, or a stack that went below the string literals.
 */
export function writtenSpans(
	memory: Uint8Array,
	layout: MemoryLayout,
	marks: RunMarks,
	host: readonly Span[] = [],
): Span[] | undefined {
	const top = layout.pages * 65536;
	if (memory.length !== top) return undefined;
	const view = new DataView(memory.buffer, memory.byteOffset, memory.length);
	let bad = false;
	const read: Read = (name) => {
		const v = layout.variables[name];
		if (v === undefined || v.bytes !== 4) {
			bad = true;
			return 0;
		}
		return view.getInt32(v.offset, true);
	};
	for (const [counter, [array, slack]] of Object.entries(COUNTERS)) {
		const value = read(counter);
		const v = layout.variables[array];
		if (bad || v?.min === undefined || v.max === undefined || value < v.min || value > v.max + slack)
			return undefined;
	}
	for (const mark of [marks.poolPtrHigh, marks.strPtrHigh, marks.stackLow])
		if (!Number.isInteger(mark) || mark < 0) return undefined;
	if (marks.stackLow < layout.dataEnd || marks.stackLow > top) return undefined;

	const cut: [number, number][] = [];
	const spans: [number, number][] = [];
	for (const [name, parts] of Object.entries(PARTS)) {
		const v = layout.variables[name];
		if (v?.min === undefined || v.max === undefined || v.entry === undefined) return undefined;
		cut.push([v.offset, v.offset + v.bytes]);
		for (const [lo, hi] of parts(read, marks, layout)) {
			const a = Math.max(lo, v.min);
			const b = Math.min(hi, v.max);
			if (b < a) continue;
			spans.push([v.offset + (a - v.min) * v.entry, v.offset + (b - v.min + 1) * v.entry]);
		}
	}
	if (bad) return undefined;
	cut.sort((x, y) => x[0] - y[0]);
	let at = 0;
	for (const [a, b] of cut) {
		if (a > at) spans.push([at, a]);
		at = Math.max(at, b);
	}
	if (at < layout.globalsEnd) spans.push([at, layout.globalsEnd]);
	spans.push([layout.globalsEnd, layout.dataEnd]);
	spans.push([marks.stackLow, top]);
	for (const [a, b] of host) if (b > a) spans.push([Math.max(0, a), Math.min(top, b)]);

	spans.sort((x, y) => x[0] - y[0]);
	const merged: [number, number][] = [];
	for (const [a, b] of spans) {
		const last = merged[merged.length - 1];
		if (last !== undefined && a <= last[1] + GAP) last[1] = Math.max(last[1], b);
		else merged.push([a, b]);
	}
	return merged;
}

/**
 * Write the dump's bytes back over `spans` of `memory`: its runs where they lie, and zeros between
 * them, which is what the dump holds there. `spans` sorted and apart, as writtenSpans gives them.
 * Returns how many bytes it wrote.
 */
export function restoreSpans(memory: Uint8Array, dump: CoreDump, spans: readonly Span[]): number {
	const runs = dump.runs;
	let written = 0;
	let r = 0;
	for (const [a, b] of spans) {
		// The first run that ends past `a`. Spans and runs are both in order, so this only moves on.
		while (r < runs.length && runs[r]!.offset + runs[r]!.bytes.length <= a) r++;
		let at = a;
		for (let k = r; at < b; k++) {
			const run = runs[k];
			if (run === undefined || run.offset >= b) {
				memory.fill(0, at, b);
				break;
			}
			if (run.offset > at) memory.fill(0, at, run.offset);
			const from = Math.max(at, run.offset);
			const to = Math.min(b, run.offset + run.bytes.length);
			memory.set(run.bytes.subarray(from - run.offset, to - run.offset), from);
			at = to;
		}
		written += b - a;
	}
	return written;
}
