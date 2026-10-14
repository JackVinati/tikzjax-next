/**
 * Saved runs: TeX as a diagram's first pass left it at the end of its \begin{document}, so that a
 * later diagram whose input starts with the same text up to there starts from it and compiles only
 * its body (internal/DECISIONS.md D32).
 *
 * The engine's \tikzjaxsnapshot, which the format runs at the end of every \begin{document}
 * (engine-build/changes/snapshot.ch), calls the host with TeX's memory as it stands there. A saved
 * run is kept as the stretches of TeX's globals that differ from the core dump, which every run
 * starts from anyway (./core-dump, ./reset), with the host's table of files: a run that resumes from
 * it gets the dump, then these.
 *
 * A module of its own so that it can be tested without booting an engine.
 */
import type { CoreDump } from './core-dump';
import type { HostState } from './library';
import { writtenSpans, type MemoryLayout, type RunMarks, type Span } from './reset';

/** One stretch of a saved run: where it goes in the memory, and its bytes. */
export interface Stretch {
	offset: number;
	bytes: Uint8Array;
}

/**
 * How finely a saved run is cut out of the memory. A block in which a byte differs from the dump is
 * kept whole, and blocks side by side are one stretch: smaller blocks keep fewer bytes and make
 * more stretches. A multiple of 8, so that a block is whole words of TeX's memory and of the dump's
 * runs, which the build lays out on 8 bytes (scripts/engine-assets.mjs packCoreDump).
 */
export const BLOCK = 256;

/**
 * The parts of TeX's globals a run can have written by now, rounded out to whole blocks: what a save
 * compares with the dump. The reset's own reckoning (./reset writtenSpans), from TeX's counters, the
 * engine's marks so far and what the host wrote, less what lies above the globals: the string
 * literals, which instantiating the engine writes afresh, and the stack, whose frames belong to
 * calls a run that resumes does not return to, as no procedure of TeX's reads a local before it
 * sets it. Undefined when the reset could not account for the memory, and nothing is saved.
 */
export function saveSpans(
	memory: Uint8Array,
	layout: MemoryLayout,
	marks: RunMarks,
	host: readonly Span[],
): Span[] | undefined {
	const spans = writtenSpans(memory, layout, marks, host);
	if (spans === undefined) return undefined;
	const out: [number, number][] = [];
	for (const [a, b] of spans) {
		const from = a - (a % BLOCK);
		const to = Math.min(layout.globalsEnd + ((BLOCK - (layout.globalsEnd % BLOCK)) % BLOCK), b);
		if (to <= from) continue;
		const end = to + ((BLOCK - (to % BLOCK)) % BLOCK);
		const last = out[out.length - 1];
		if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], end);
		else out.push([from, end]);
	}
	return out;
}

/**
 * The stretches of `pieces`, each the content of the memory from its offset on, that differ from the
 * dump, cut in blocks of BLOCK bytes: a block in which any byte differs is kept whole, and blocks
 * side by side are one stretch. Each stretch's bytes are a copy, so neither the memory nor a copy of
 * it is kept alive by a saved run.
 *
 * The pieces start on a block, as saveSpans gives them, and the dump's runs on 8 bytes, as the
 * build packs them, so both sides are read a word at a time. A run that is not, from a dump packed
 * some other way, is read a byte at a time, and so are the bytes of a word that lies partly in it
 * and partly in the zeros beside it, which gives the same stretches more slowly.
 */
export function diffAgainstDump(pieces: readonly Stretch[], dump: CoreDump): Stretch[] {
	const runs = dump.runs;
	const words = runs.map((run) =>
		run.offset % 4 === 0 && run.bytes.byteOffset % 4 === 0 && run.bytes.length % 4 === 0
			? new Int32Array(run.bytes.buffer, run.bytes.byteOffset, run.bytes.length >>> 2)
			: null,
	);
	const out: Stretch[] = [];
	let r = 0;
	for (const piece of pieces) {
		const src = piece.bytes;
		const base = piece.offset;
		if (base % BLOCK !== 0 || src.byteOffset % 4 !== 0 || src.length % BLOCK !== 0)
			throw new Error('a piece of the memory that is not whole blocks');
		const m = new Int32Array(src.buffer, src.byteOffset, src.length >>> 2);
		let open = -1;
		for (let s = 0; s < src.length; s += BLOCK) {
			const at = base + s;
			while (r < runs.length && runs[r]!.offset + runs[r]!.bytes.length <= at) r++;
			if (blockDiffers(src, m, s, at, runs, words, r)) {
				if (open < 0) open = s;
			} else if (open >= 0) {
				out.push({ offset: base + open, bytes: src.slice(open, s) });
				open = -1;
			}
		}
		if (open >= 0) out.push({ offset: base + open, bytes: src.slice(open) });
		// The next piece may begin before where this one's runs left off only if pieces overlap,
		// which saveSpans does not give; start the runs over to be right whatever is passed.
		r = 0;
	}
	return out;
}

/**
 * Whether the block of `src` at `s`, which lies at `at` in the memory, differs from the dump there.
 * `r` is the first of the dump's runs that ends past `at`.
 */
function blockDiffers(
	src: Uint8Array,
	m: Int32Array,
	s: number,
	at: number,
	runs: CoreDump['runs'],
	words: readonly (Int32Array | null)[],
	r: number,
): boolean {
	const end = at + BLOCK;
	let p = at;
	let k = r;
	while (p < end) {
		const run = runs[k];
		if (run === undefined || run.offset >= end) return anyByteNonZero(src, m, s + p - at, s + BLOCK);
		if (run.offset > p) {
			// Zero in the dump up to the run.
			if (anyByteNonZero(src, m, s + p - at, s + run.offset - at)) return true;
			p = run.offset;
		}
		const q = Math.min(end, run.offset + run.bytes.length);
		const d = words[k];
		if (d !== null && d !== undefined) {
			let i = (s + p - at) >>> 2;
			let j = (p - run.offset) >>> 2;
			const last = (s + q - at) >>> 2;
			for (; i + 4 <= last; i += 4, j += 4)
				if (
					(m[i]! ^ d[j]!) |
					(m[i + 1]! ^ d[j + 1]!) |
					(m[i + 2]! ^ d[j + 2]!) |
					(m[i + 3]! ^ d[j + 3]!)
				)
					return true;
			for (; i < last; i++, j++) if (m[i] !== d[j]) return true;
		} else {
			const bytes = run.bytes;
			for (let i = p; i < q; i++) if (src[s + i - at] !== bytes[i - run.offset]) return true;
		}
		p = q;
		k++;
	}
	return false;
}

/**
 * Whether any of bytes [from, to) of `src` is not zero: the words that lie whole within them a word
 * at a time, `m` being `src` as words, and the bytes of a word cut by either end one by one. A word
 * cut by an end lies partly outside, in a run of the dump's where it starts or ends off a word, and
 * read whole it would be compared with zero there, or be left out.
 */
function anyByteNonZero(src: Uint8Array, m: Int32Array, from: number, to: number): boolean {
	let i = from;
	for (; i < to && (i & 3) !== 0; i++) if (src[i] !== 0) return true;
	const whole = to - (to & 3);
	if (i < whole) {
		if (anyNonZero(m, i >>> 2, whole >>> 2)) return true;
		i = whole;
	}
	for (; i < to; i++) if (src[i] !== 0) return true;
	return false;
}

/** Whether any of words [from, to) of `m` is not zero. */
function anyNonZero(m: Int32Array, from: number, to: number): boolean {
	let i = from;
	for (; i + 4 <= to; i += 4) if (m[i]! | m[i + 1]! | m[i + 2]! | m[i + 3]!) return true;
	for (; i < to; i++) if (m[i] !== 0) return true;
	return false;
}

/** Write a saved run's stretches into `memory`, which holds the dump: what a run resumes from. */
export function writeStretches(memory: Uint8Array, stretches: readonly Stretch[]): void {
	for (const stretch of stretches) memory.set(stretch.bytes, stretch.offset);
}

/** Where `stretches` lie, merged: what the reset after a run that resumed from them puts back too. */
export function stretchSpans(stretches: readonly Stretch[]): Span[] {
	const out: [number, number][] = [];
	for (const { offset, bytes } of stretches) {
		const last = out[out.length - 1];
		if (last !== undefined && offset <= last[1]) last[1] = Math.max(last[1], offset + bytes.length);
		else out.push([offset, offset + bytes.length]);
	}
	return out;
}

/** `a` and `b`, two lists of spans sorted and apart, as one. */
export function unionSpans(a: readonly Span[], b: readonly Span[]): Span[] {
	const all = [...a, ...b].sort((x, y) => x[0] - y[0]);
	const out: [number, number][] = [];
	for (const [from, to] of all) {
		const last = out[out.length - 1];
		if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
		else out.push([from, to]);
	}
	return out;
}

/** A first pass as it stood at \tikzjaxsnapshot, for later diagrams with the same input up to there. */
export interface SavedRun {
	/** The input it stands for: the text TeX had read, through the newline that ends the last line. */
	prefix: string;
	/** Whether the run kept TeX's terminal output, which a run resumed from it says again. */
	logging: boolean;
	/** A short name for `prefix` and `logging`, which the host routes diagrams by (./document). */
	route: string;
	/** TeX's globals where they differ from the dump. */
	stretches: Stretch[];
	/** Where the stretches lie (stretchSpans). */
	spans: Span[];
	/** The host's table of files and terminal. */
	host: HostState;
	/** What TeX had said on the terminal by then, and the files it had not found. */
	log: string[];
	missing: string[];
	/** What it holds, to keep the saved runs within their budget. */
	bytes: number;
}

/** How many bytes a saved run's log lines take, near enough: two a character, and a little a line. */
export const logBytes = (lines: readonly string[]): number =>
	lines.reduce((n, line) => n + 2 * line.length + 16, 0);

/**
 * Saved runs, by the input they stand for and whether the log was kept, within a budget of bytes.
 *
 * Least recently used goes first, with two exceptions. A run in use, the one the render under way
 * resumed from, is never evicted. And plain least-recently-used eviction thrashes when diagrams
 * cycle through more preambles than the budget holds: every render misses, saves, and evicts the
 * run the next one needed, so each pays the save and none resumes. So a run that has been resumed
 * from, and was used within the last `idle` renders, is not evicted to make room either; a new run
 * that does not fit without evicting one is not kept, and `wants` says so before the work of saving
 * it is done.
 */
export class SnapshotCache {
	private readonly entries = new Map<string, { run: SavedRun; hits: number; used: number }>();
	private readonly pinned = new Set<string>();
	private held = 0;
	private now = 0;
	private budget: number;
	private readonly idle: number;

	constructor(budget: number, idle = 16) {
		this.budget = Math.max(0, budget);
		this.idle = idle;
	}

	private static keyOf(prefix: string, logging: boolean): string {
		return `${logging ? '1' : '0'}${prefix}`;
	}

	/** A render begins; idleness is counted in renders. */
	tick(): void {
		this.now++;
	}

	/**
	 * The saved run with the longest prefix that `text` starts with, for the same logging, marked as
	 * used; or undefined.
	 */
	find(text: string, logging: boolean): SavedRun | undefined {
		let best: { run: SavedRun; hits: number; used: number } | undefined;
		for (const entry of this.entries.values()) {
			const { run } = entry;
			if (run.logging !== logging || run.prefix.length > text.length) continue;
			if (best !== undefined && run.prefix.length <= best.run.prefix.length) continue;
			if (text.startsWith(run.prefix)) best = entry;
		}
		if (best === undefined) return undefined;
		best.hits++;
		best.used = this.now;
		// Most recently used last.
		const key = SnapshotCache.keyOf(best.run.prefix, best.run.logging);
		this.entries.delete(key);
		this.entries.set(key, best);
		return best.run;
	}

	/** Keep `run` from being evicted until it is unpinned: the render under way resumed from it. */
	pin(run: SavedRun): void {
		this.pinned.add(SnapshotCache.keyOf(run.prefix, run.logging));
	}

	unpin(run: SavedRun): void {
		this.pinned.delete(SnapshotCache.keyOf(run.prefix, run.logging));
	}

	private evictable(key: string, entry: { hits: number; used: number }): boolean {
		if (this.pinned.has(key)) return false;
		return entry.hits === 0 || this.now - entry.used > this.idle;
	}

	/** Whether a new run could be kept: there is room, or something that may go to make room. */
	wants(): boolean {
		if (this.budget <= 0) return false;
		if (this.held < this.budget) return true;
		for (const [key, entry] of this.entries) if (this.evictable(key, entry)) return true;
		return false;
	}

	/** Keep `run`, making room from the least recently used that may go. False if it was not kept. */
	set(run: SavedRun): boolean {
		if (run.bytes > this.budget) return false;
		const key = SnapshotCache.keyOf(run.prefix, run.logging);
		const old = this.entries.get(key);
		if (old !== undefined) {
			if (this.pinned.has(key)) return false;
			this.held -= old.run.bytes;
			this.entries.delete(key);
		}
		this.makeRoom(run.bytes);
		if (this.held + run.bytes > this.budget) return false;
		this.entries.set(key, { run, hits: 0, used: this.now });
		this.held += run.bytes;
		return true;
	}

	/** Evict, least recently used first, what may go until `bytes` more fit. */
	private makeRoom(bytes: number): void {
		for (const [key, entry] of this.entries) {
			if (this.held + bytes <= this.budget) break;
			if (!this.evictable(key, entry)) continue;
			this.entries.delete(key);
			this.held -= entry.run.bytes;
		}
	}

	/**
	 * Hold at most `budget` bytes from now on: the platform's budget, or 0 when saving is turned
	 * off, which lets every run go but one in use.
	 */
	setBudget(budget: number): void {
		this.budget = Math.max(0, budget);
		if (this.held <= this.budget) return;
		for (const [key, entry] of this.entries) {
			if (this.held <= this.budget) break;
			if (this.pinned.has(key)) continue;
			this.entries.delete(key);
			this.held -= entry.run.bytes;
		}
	}

	/** The route of each run held, for the host to send diagrams by. */
	routes(): string[] {
		return [...this.entries.values()].map((entry) => entry.run.route);
	}

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.held;
	}
}
