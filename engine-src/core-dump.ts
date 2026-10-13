/**
 * The core dump, and the memory every TeX run starts from.
 *
 * The dump is the engine's whole WebAssembly.Memory, 2500 pages, as it stood once the LaTeX format
 * was loaded (internal/DECISIONS.md D12). Each run gets a fresh Memory with the dump in it, because
 * a run leaves its own state all over the one it had. Upstream copies the whole 156.25 MiB into
 * every one: about 29 ms a render on the desktop (V8), and every page of the new Memory written,
 * so it all counts against the worker's footprint until the collector frees it.
 *
 * 134 MiB of the dump is zero — TeX's arrays are sized for the largest document it will take, and
 * a diagram fills a corner of them — and a fresh Memory is zero already: the WebAssembly spec fills
 * new pages with zeros. So only the stretches that are not zero are written: 22.3 MiB, about 5 ms,
 * and the pages TeX never touches are never touched at all. The build cuts the dump into those
 * stretches and ships nothing else (scripts/engine-assets.mjs `packCoreDump`).
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

/** How many bytes the runs hold between them: `runs` is an offset and a length for each, flat. */
export function packedLength(runs: readonly number[]): number {
	let total = 0;
	for (let r = 1; r < runs.length; r += 2) total += runs[r] ?? 0;
	return total;
}

/**
 * The dump the build packed: `size` bytes, zero but for `runs`, whose bytes lie back to back in
 * `bytes`. The runs are views of `bytes`, not copies.
 *
 * Checked rather than trusted, because nothing downstream could tell. A run past the end of the
 * memory would throw at the first render instead of at boot, and runs that overlap or leave bytes
 * over would start every run from a dump that is not the one the format left.
 */
export function unpackCoreDump(size: number, runs: readonly number[], bytes: Uint8Array): CoreDump {
	if (runs.length % 2 !== 0) throw new Error('the core dump has a run without a length');
	const unpacked: DumpRun[] = [];
	let end = 0;
	let at = 0;
	for (let r = 0; r < runs.length; r += 2) {
		const offset = runs[r] ?? -1;
		const length = runs[r + 1] ?? -1;
		if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < end || length < 1)
			throw new Error(`the core dump's run at ${offset} is out of order or empty`);
		if (offset + length > size || at + length > bytes.length)
			throw new Error(`the core dump's run at ${offset} runs past its end`);
		unpacked.push({ offset, bytes: bytes.subarray(at, at + length) });
		end = offset + length;
		at += length;
	}
	if (at !== bytes.length) throw new Error(`the core dump's runs hold ${at} B of ${bytes.length}`);
	return { size, runs: unpacked };
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
 * Whether the dump fills a memory of `pages` pages exactly, which it must. A dump shorter than the
 * memory would leave live TeX state at zero, a corruption that would surface much later as garbage
 * output rather than as an error.
 */
export function checkCoreDump(dump: CoreDump, pages: number): void {
	const size = pages * 65536;
	if (dump.size !== size) throw new Error(`the core dump is ${dump.size} B, the memory ${size} B`);
}

/** A new Memory of `pages` pages holding the dump: what a TeX run starts from. */
export function startingMemory(dump: CoreDump, pages: number): WebAssembly.Memory {
	checkCoreDump(dump, pages);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
	restoreCoreDump(memory.buffer, dump);
	return memory;
}
