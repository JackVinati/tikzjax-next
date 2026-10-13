/**
 * The core dump, and the memory every TeX run starts from.
 *
 * The dump is the engine's whole WebAssembly.Memory, 2500 pages, as it stood once the LaTeX format
 * was loaded (internal/DECISIONS.md D12). Each run gets a fresh Memory with the dump in it, because
 * a run leaves its own state all over the one it had. Upstream copies the whole 156.25 MiB into
 * every one: 27 ms a render on the desktop (V8), and every page of the new Memory written, so it all
 * counts against the worker's footprint until the collector frees it.
 *
 * 134 MiB of the dump is zero — TeX's arrays are sized for the largest document it will take, and
 * a diagram fills a corner of them — and a fresh Memory is zero already: the WebAssembly spec fills
 * new pages with zeros. So the dump is kept as the stretches of it that are not zero, and only those
 * are written: 21.5 MiB, about 5 ms, and the pages TeX never touches are never touched at all.
 *
 * A module of its own so the reset can be tested against the dump without booting an engine.
 */

/** One stretch of the dump that is not all zeros: where it goes in the memory, and its bytes. */
export interface DumpRun {
	offset: number;
	bytes: Uint8Array;
}

export interface CoreDump {
	/** The whole dump's length: the memory it fills, zeros included. */
	size: number;
	/** In order, apart from one another, and within `size`. */
	runs: readonly DumpRun[];
}

/**
 * A run of zeros at least this long ends a run; a shorter one stays inside it.
 *
 * Splitting at every zero byte would cut the dump into thousands of runs to save writing a few
 * zeros. With 4 KiB the committed dump is 28 runs and 21.5 MiB, against 10.9 MiB of bytes that are
 * literally not zero: TeX's arrays are full of short zero stretches.
 */
export const DUMP_GAP = 4096;

/**
 * The dump's non-zero runs, as views of `dump` itself. Each starts at a byte that is not zero and
 * ends after the last byte that is not, so nothing outside them is anything but zero.
 */
export function nonZeroRuns(dump: Uint8Array, gap = DUMP_GAP): CoreDump {
	const runs: DumpRun[] = [];
	const n = dump.length;
	let i = 0;
	while (i < n) {
		while (i < n && dump[i] === 0) i++;
		if (i === n) break;

		const start = i;
		let end: number;
		for (;;) {
			while (i < n && dump[i] !== 0) i++;
			end = i;
			while (i < n && dump[i] === 0 && i - end < gap) i++;
			// The end of the dump, or a gap long enough to end the run on.
			if (i === n || i - end >= gap) break;
		}
		runs.push({ offset: start, bytes: dump.subarray(start, end) });
	}
	return { size: n, runs };
}

/**
 * Write the dump's runs into `target`, which must be zero everywhere else already — as a new
 * WebAssembly.Memory is.
 */
export function restoreCoreDump(target: ArrayBuffer, dump: CoreDump): void {
	const view = new Uint8Array(target);
	for (const run of dump.runs) view.set(run.bytes, run.offset);
}

/**
 * A new Memory of `pages` pages holding the dump: what a TeX run starts from.
 *
 * The size is checked rather than trusted. A dump shorter than the memory would leave live TeX
 * state at zero, a corruption that would surface much later as garbage output rather than here.
 */
export function startingMemory(dump: CoreDump, pages: number): WebAssembly.Memory {
	const size = pages * 65536;
	if (dump.size !== size) throw new Error(`the core dump is ${dump.size} B, the memory ${size} B`);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
	restoreCoreDump(memory.buffer, dump);
	return memory;
}
