import { beforeAll, describe, expect, it } from 'vitest';
import {
	packedLength,
	restoreCoreDump,
	startingMemory,
	unpackCoreDump,
	type CoreDump,
} from '../engine-src/core-dump';
import { inflateExactly } from '../engine-src/inflate';
import { encodeCoreDump, packCoreDump, readCoreDump } from '../scripts/engine-assets.mjs';

/*
 * Every TeX run starts from the core dump: the whole 2500-page WebAssembly.Memory as it stood once
 * the format was loaded. The worker used to copy all 156.25 MiB of it into each run's fresh Memory,
 * 27 ms a render on the desktop, and to inflate all of it at every boot. 134 MiB of it is zero, and
 * a fresh Memory is zero already (the WebAssembly spec fills new pages with zeros), so the build
 * ships only the stretches that are not zero and the worker writes only those. These hold the
 * memory a job starts from to the dump, byte for byte, through the build's packing and the
 * worker's unpacking both.
 */

/** Relative to the project root, which is where vitest runs (vitest.config.ts lives there). */
const ROOT = '.';

const PAGE = 65536;

// Packing the committed dump is the build's own work, done as the build does it: 156.25 MiB cut into
// runs and gzipped by pako at level 9, in JavaScript. That is about 3 s on the desktop, and five
// times as long under coverage, which slows every line of JavaScript it runs, so it is done once,
// here, with a limit to match. encodeCoreDump keeps the result for the tests that read it.
beforeAll(() => {
	encodeCoreDump(ROOT);
}, 120_000);

/** The index of the first byte at which `a` and `b` differ, or -1. Faster than `toEqual` on 156 MiB. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
	if (a.length !== b.length) return Math.min(a.length, b.length);
	const words = a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 ? a.length >> 2 : 0;
	const wa = new Uint32Array(a.buffer, a.byteOffset, words);
	const wb = new Uint32Array(b.buffer, b.byteOffset, words);
	let i = 0;
	while (i < words && wa[i] === wb[i]) i++;
	for (let j = i << 2; j < a.length; j++) if (a[j] !== b[j]) return j;
	return -1;
}

/** A dump of `pages` pages, zero except for `set`: offset -> byte. */
function dumpWith(pages: number, set: Record<number, number>): Uint8Array {
	const dump = new Uint8Array(pages * PAGE);
	for (const [offset, byte] of Object.entries(set)) dump[Number(offset)] = byte;
	return dump;
}

/** The dump as the build packs it and the worker unpacks it, its runs on `align` bytes. */
function shipped(dump: Uint8Array, gap?: number, align?: number): CoreDump {
	const packed = packCoreDump(dump, gap, align);
	return unpackCoreDump(packed.size, packed.runs, packed.bytes);
}

/** What a job would start from: a fresh Memory with the dump's runs set into it. */
function started(dump: Uint8Array, gap?: number): Uint8Array {
	return new Uint8Array(startingMemory(shipped(dump, gap), dump.length / PAGE).buffer);
}

const spans = (dump: Uint8Array, gap?: number, align?: number): [number, number][] =>
	shipped(dump, gap, align).runs.map((run) => [run.offset, run.offset + run.bytes.length]);

describe('the memory a job starts from', () => {
	it('is the committed core dump, byte for byte, from what the worker string carries', () => {
		const dump = readCoreDump(ROOT);
		expect(dump.length).toBe(2500 * PAGE);

		// The gzip the build puts into the worker, inflated and unpacked as the worker boots.
		const encoded = encodeCoreDump(ROOT);
		const bytes = inflateExactly(encoded.gz, packedLength(encoded.runs));
		const memory = new Uint8Array(
			startingMemory(unpackCoreDump(encoded.size, encoded.runs, bytes), 2500).buffer,
		);
		expect(memory.length).toBe(dump.length);
		expect(firstDifference(memory, dump)).toBe(-1);
	});

	it('is a dump whose first byte and last page are not zero', () => {
		const dump = dumpWith(3, { 0: 1, [PAGE - 1]: 2, [PAGE]: 3, [3 * PAGE - 1]: 4 });
		dump.fill(5, 2 * PAGE, 3 * PAGE - 1);
		const memory = started(dump);
		expect(firstDifference(memory, dump)).toBe(-1);
		expect(memory[0]).toBe(1);
		expect(memory[3 * PAGE - 1]).toBe(4);
	});

	it('is a dump with no zero byte in it at all, and one with nothing but zeros', () => {
		const full = new Uint8Array(2 * PAGE).fill(0xff);
		expect(firstDifference(started(full), full)).toBe(-1);
		expect(spans(full)).toEqual([[0, 2 * PAGE]]);

		const empty = new Uint8Array(2 * PAGE);
		expect(firstDifference(started(empty), empty)).toBe(-1);
		expect(spans(empty)).toEqual([]);
	});

	it('is a dump with runs on either side of the page boundaries, whatever the gap', () => {
		const dump = dumpWith(4, {
			[PAGE - 1]: 1,
			[PAGE]: 2,
			[2 * PAGE - 2]: 3,
			[2 * PAGE + 1]: 4,
			[3 * PAGE]: 5,
			[4 * PAGE - 1]: 6,
		});
		for (const gap of [1, 2, 3, 4096, PAGE, 4 * PAGE]) {
			expect(firstDifference(started(dump, gap), dump), `gap ${gap}`).toBe(-1);
			for (const align of [1, 8, 4096]) {
				const memory = new Uint8Array(startingMemory(shipped(dump, gap, align), 4).buffer);
				expect(firstDifference(memory, dump), `gap ${gap}, align ${align}`).toBe(-1);
			}
		}
	});
});

describe('the runs the build cuts the dump into', () => {
	it('are exact at both ends without alignment: from a non-zero byte to the byte after the last one', () => {
		const dump = dumpWith(1, { 10: 1, 20: 2 });
		expect(spans(dump, 4, 1)).toEqual([
			[10, 11],
			[20, 21],
		]);
	});

	it('start and end on 8 bytes, as the build packs them, and those that then touch are one', () => {
		// Each run's bytes then lie where it lies in the memory, give or take whole words, so a save
		// compares the memory with the dump a word at a time (engine-src/snapshot.ts).
		expect(spans(dumpWith(1, { 10: 1, 40: 2 }), 4)).toEqual([
			[8, 16],
			[40, 48],
		]);
		expect(spans(dumpWith(1, { 10: 1, 20: 2 }), 4)).toEqual([[8, 24]]);
		expect(spans(dumpWith(1, { [PAGE - 1]: 2 }), 4)).toEqual([[PAGE - 8, PAGE]]);
		const packed = packCoreDump(dumpWith(1, { 10: 1, 11: 2, 4000: 3 }), 16);
		expect(packed.runs).toEqual([8, 8, 4000, 8]);
		expect([...packed.bytes]).toEqual([0, 0, 1, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
	});

	it('of the committed dump are whole words, at their place in the memory', () => {
		const { runs } = encodeCoreDump(ROOT);
		for (let r = 0; r < runs.length; r += 2) {
			expect(runs[r]! % 8).toBe(0);
			expect(runs[r + 1]! % 8).toBe(0);
		}
	});

	it('split at a gap of `gap` zeros, and run on through a shorter one', () => {
		// Zeros at 11..14 are a gap of four: split. Zeros at 22..24 are three: one run.
		const dump = dumpWith(1, { 10: 1, 15: 2, 21: 3, 25: 4 });
		expect(spans(dump, 4, 1)).toEqual([
			[10, 11],
			[15, 16],
			[21, 26],
		]);
		expect(spans(dump, 5, 1)).toEqual([
			[10, 16],
			[21, 26],
		]);
	});

	it('reach the end of the dump when its last byte is not zero, and start at 0 when its first is not', () => {
		const dump = dumpWith(1, { 0: 1, [PAGE - 1]: 2 });
		expect(spans(dump, 8, 1)).toEqual([
			[0, 1],
			[PAGE - 1, PAGE],
		]);
		expect(spans(dump, PAGE)).toEqual([[0, PAGE]]);
	});

	it('hold their bytes back to back, and nothing else', () => {
		const packed = packCoreDump(dumpWith(1, { 10: 1, 11: 2, 4000: 3 }), 16, 1);
		expect(packed.runs).toEqual([10, 2, 4000, 1]);
		expect([...packed.bytes]).toEqual([1, 2, 3]);
		expect(packedLength(packed.runs)).toBe(3);
	});

	it('leave out most of the committed dump', () => {
		// 22.3 MiB of 156.25 on the 0.2.0 engine, and 21.5 on 0.1.5's: what the worker inflates at
		// boot and writes into each run's memory. Held to the point rather than to one engine's sizes,
		// which a rebuild moves, as the larger hash table of 0.2.0 did.
		const { size, runs } = encodeCoreDump(ROOT);
		expect(packedLength(runs)).toBeLessThan(size / 4);
		expect(runs.length / 2).toBeLessThan(1000);
	});
});

describe('unpackCoreDump', () => {
	it('makes views of the bytes it is given, not copies', () => {
		const bytes = Uint8Array.of(1, 2, 3);
		const dump = unpackCoreDump(PAGE, [10, 2, 4000, 1], bytes);
		expect(dump.runs.map((run) => [run.offset, [...run.bytes]])).toEqual([
			[10, [1, 2]],
			[4000, [3]],
		]);
		expect(dump.runs[0]?.bytes.buffer).toBe(bytes.buffer);
	});

	it('refuses runs that overlap, run backwards or are empty', () => {
		const bytes = new Uint8Array(4);
		expect(() => unpackCoreDump(PAGE, [10, 2, 11, 2], bytes)).toThrow('out of order');
		expect(() => unpackCoreDump(PAGE, [10, 2, 5, 2], bytes)).toThrow('out of order');
		expect(() => unpackCoreDump(PAGE, [10, 0, 20, 4], bytes)).toThrow('out of order');
		expect(() => unpackCoreDump(PAGE, [10, 2, 20], bytes)).toThrow('without a length');
	});

	it('refuses a run past the end of the dump, or of the bytes', () => {
		expect(() => unpackCoreDump(PAGE, [PAGE - 1, 2], new Uint8Array(2))).toThrow('past its end');
		expect(() => unpackCoreDump(PAGE, [0, 3], new Uint8Array(2))).toThrow('past its end');
	});

	it('refuses bytes the runs do not account for', () => {
		expect(() => unpackCoreDump(PAGE, [0, 2], new Uint8Array(3))).toThrow('hold 2 B of 3');
	});
});

describe('restoreCoreDump', () => {
	it('writes the runs and nothing else, leaving the rest to the zeros a fresh Memory has', () => {
		const dump = dumpWith(1, { 10: 1, 11: 2, 4000: 3 });
		const target = new Uint8Array(PAGE).fill(0xaa);
		restoreCoreDump(target.buffer, shipped(dump, 16, 1));
		expect([...target.subarray(8, 14)]).toEqual([0xaa, 0xaa, 1, 2, 0xaa, 0xaa]);
		expect(target[4000]).toBe(3);
		expect(target.filter((byte) => byte === 0xaa).length).toBe(PAGE - 3);
		// On 8 bytes, the runs take in the zeros around their bytes, and write those too.
		const aligned = new Uint8Array(PAGE).fill(0xaa);
		restoreCoreDump(aligned.buffer, shipped(dump, 16));
		expect([...aligned.subarray(6, 18)]).toEqual([0xaa, 0xaa, 0, 0, 1, 2, 0, 0, 0, 0, 0xaa, 0xaa]);
		expect(aligned.filter((byte) => byte === 0xaa).length).toBe(PAGE - 16);
	});

	it('refuses a dump that is not the size of the memory', () => {
		const dump = shipped(new Uint8Array(PAGE));
		expect(() => startingMemory(dump, 2)).toThrow(`the core dump is ${PAGE} B, the memory ${2 * PAGE} B`);
	});
});
