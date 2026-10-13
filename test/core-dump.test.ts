import { describe, expect, it } from 'vitest';
import { nonZeroRuns, restoreCoreDump, startingMemory } from '../engine-src/core-dump';
import { readCoreDump } from '../scripts/engine-assets.mjs';

/*
 * Every TeX run starts from the core dump: the whole 2500-page WebAssembly.Memory as it stood once
 * the format was loaded. The worker used to copy all 156.25 MiB of it into each run's fresh Memory,
 * 27 ms a render on the desktop. 134 MiB of it is zero, and a fresh Memory is zero already (the
 * WebAssembly spec fills new pages with zeros), so only the stretches that are not zero need
 * writing. These hold the memory a job starts from to the dump, byte for byte.
 */

/** Relative to the project root, which is where vitest runs (vitest.config.ts lives there). */
const ROOT = '.';

const PAGE = 65536;

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

/** What a job would start from: a fresh Memory with the dump's runs set into it. */
function started(dump: Uint8Array, gap?: number): Uint8Array {
	const pages = dump.length / PAGE;
	return new Uint8Array(startingMemory(nonZeroRuns(dump, gap), pages).buffer);
}

const spans = (dump: Uint8Array, gap?: number): [number, number][] =>
	nonZeroRuns(dump, gap).runs.map((run) => [run.offset, run.offset + run.bytes.length]);

describe('the memory a job starts from', () => {
	it('is the committed core dump, byte for byte', () => {
		const dump = readCoreDump(ROOT);
		expect(dump.length).toBe(2500 * PAGE);
		const memory = started(dump);
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
		}
	});
});

describe('the runs the dump is cut into', () => {
	it('are exact at both ends: from a non-zero byte to the byte after the last one', () => {
		const dump = dumpWith(1, { 10: 1, 20: 2 });
		expect(spans(dump, 4)).toEqual([
			[10, 11],
			[20, 21],
		]);
	});

	it('split at a gap of `gap` zeros, and run on through a shorter one', () => {
		// Zeros at 11..14 are a gap of four: split. Zeros at 22..24 are three: one run.
		const dump = dumpWith(1, { 10: 1, 15: 2, 21: 3, 25: 4 });
		expect(spans(dump, 4)).toEqual([
			[10, 11],
			[15, 16],
			[21, 26],
		]);
		expect(spans(dump, 5)).toEqual([
			[10, 16],
			[21, 26],
		]);
	});

	it('reach the end of the dump when its last byte is not zero, and start at 0 when its first is not', () => {
		const dump = dumpWith(1, { 0: 1, [PAGE - 1]: 2 });
		expect(spans(dump, 8)).toEqual([
			[0, 1],
			[PAGE - 1, PAGE],
		]);
		expect(spans(dump, PAGE)).toEqual([[0, PAGE]]);
	});

	it('are views of the dump, not copies of it', () => {
		const dump = dumpWith(1, { 100: 7 });
		const [run] = nonZeroRuns(dump).runs;
		expect(run?.bytes.buffer).toBe(dump.buffer);
	});

	it('leave out most of the committed dump', () => {
		// 21.5 MiB of 156.25: what each render writes, and with the dump shipped as these runs, what
		// the worker inflates at boot.
		const { runs } = nonZeroRuns(readCoreDump(ROOT));
		const written = runs.reduce((n, run) => n + run.bytes.length, 0);
		expect(written).toBeLessThan(32 * 1048576);
		expect(runs.length).toBeLessThan(100);
	});
});

describe('restoreCoreDump', () => {
	it('writes the runs and nothing else, leaving the rest to the zeros a fresh Memory has', () => {
		const dump = dumpWith(1, { 10: 1, 11: 2, 4000: 3 });
		const target = new Uint8Array(PAGE).fill(0xaa);
		restoreCoreDump(target.buffer, nonZeroRuns(dump, 16));
		expect([...target.subarray(8, 14)]).toEqual([0xaa, 0xaa, 1, 2, 0xaa, 0xaa]);
		expect(target[4000]).toBe(3);
		expect(target.filter((byte) => byte === 0xaa).length).toBe(PAGE - 3);
	});

	it('refuses a dump that is not the size of the memory', () => {
		const dump = nonZeroRuns(new Uint8Array(PAGE));
		expect(() => startingMemory(dump, 2)).toThrow(`the core dump is ${PAGE} B, the memory ${2 * PAGE} B`);
	});
});
