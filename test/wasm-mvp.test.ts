import { ungzip } from 'pako';
import { describe, expect, it } from 'vitest';
import { nonMvpFeatures } from '../scripts/wasm-mvp.mjs';
import { readBytes } from './support/read-bytes';

/*
 * The engine is held to WebAssembly 1.0, the MVP: one instruction from a later proposal and the
 * engine does not compile in an older WebView minAppVersion 1.7.2 admits, iOS 14.5's or Chromium
 * 106's, while every desktop it is tested on runs it. The build asks for the MVP (`wasm-opt
 * --mvp-features` in engine-build/build-engine.sh); this checks what was committed.
 *
 * The small modules below are each valid WebAssembly, which the first assertion of each case
 * confirms, so the scanner is shown to find a real use of a feature rather than a malformed byte.
 */

/** An unsigned LEB128. */
const leb = (n: number): number[] => {
	const out: number[] = [];
	do {
		const b = n & 0x7f;
		n >>>= 7;
		out.push(n ? b | 0x80 : b);
	} while (n);
	return out;
};
const section = (id: number, contents: number[]): number[] => [id, ...leb(contents.length), ...contents];
const vec = (items: number[][]): number[] => [...leb(items.length), ...items.flat()];

const I32 = 0x7f;

/** `\0asm`, then version 1. */
const PREAMBLE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/**
 * A module of one function, `() -> results`, with one page of memory and whatever extra sections
 * a case needs, placed in section order.
 */
function module(
	body: number[],
	{
		results = [I32],
		globals = [] as number[][],
		exports = [] as number[][],
		dataCount = false,
		data = [] as number[][],
	} = {},
): Uint8Array<ArrayBuffer> {
	const code = [0x00, ...body, 0x0b]; // no locals, the instructions, end
	return Uint8Array.from([
		...PREAMBLE,
		...section(1, vec([[0x60, 0x00, ...vec(results.map((r) => [r]))]])),
		...section(3, vec([[0x00]])),
		...section(5, vec([[0x00, 0x01]])),
		...(globals.length ? section(6, vec(globals)) : []),
		...(exports.length ? section(7, vec(exports)) : []),
		...(dataCount ? section(12, leb(data.length)) : []),
		...section(10, vec([[...leb(code.length), ...code]])),
		...(data.length ? section(11, vec(data)) : []),
	]);
}

const features = (bytes: Uint8Array) => nonMvpFeatures(bytes).map((f) => f.feature);

describe('nonMvpFeatures', () => {
	it('passes a module of MVP instructions, a 0xc0 inside a constant included', () => {
		// i32.const 64 is encoded 41 c0 00: the byte that is i32.extend8_s as an instruction.
		const bytes = module([0x41, 0xc0, 0x00, 0x41, 0x01, 0x6a]);
		expect(WebAssembly.validate(bytes)).toBe(true);
		expect(nonMvpFeatures(bytes)).toEqual([]);
	});

	it('finds sign extension', () => {
		const bytes = module([0x41, 0x7f, 0xc0]); // i32.const -1, i32.extend8_s
		expect(WebAssembly.validate(bytes)).toBe(true);
		expect(features(bytes)).toEqual(['sign-ext']);
	});

	it('finds bulk memory, as an instruction, a data count section and a passive segment', () => {
		// memory.fill(0, 0, 0), then i32.const 0
		const fill = module([0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00, 0x41, 0x00]);
		expect(WebAssembly.validate(fill)).toBe(true);
		expect(features(fill)).toEqual(['bulk-memory']);

		const passive = module([0x41, 0x00], { dataCount: true, data: [[0x01, ...leb(1), 0x2a]] });
		expect(WebAssembly.validate(passive)).toBe(true);
		expect(features(passive)).toEqual(['bulk-memory', 'bulk-memory']);
	});

	it('finds the saturating conversions, SIMD and several results', () => {
		const sat = module([0x43, 0x00, 0x00, 0x00, 0x00, 0xfc, 0x00]); // f32.const 0, i32.trunc_sat_f32_s
		expect(WebAssembly.validate(sat)).toBe(true);
		expect(features(sat)).toEqual(['nontrapping-float-to-int']);

		// v128.const 0, i32x4.extract_lane 0
		const simd = module([0xfd, 0x0c, ...Array.from({ length: 16 }, () => 0), 0xfd, 0x1b, 0x00]);
		expect(WebAssembly.validate(simd)).toBe(true);
		expect(features(simd)).toEqual(['simd']);

		const two = module([0x41, 0x01, 0x41, 0x02], { results: [I32, I32] });
		expect(WebAssembly.validate(two)).toBe(true);
		expect(features(two)).toEqual(['multivalue']);
	});

	it('finds a mutable global exported', () => {
		const bytes = module([0x41, 0x00], {
			globals: [[I32, 0x01, 0x41, 0x00, 0x0b]],
			exports: [[...leb(1), 0x67, 0x03, 0x00]], // "g", a global, index 0
		});
		expect(WebAssembly.validate(bytes)).toBe(true);
		expect(features(bytes)).toEqual(['mutable-globals']);
	});

	it('refuses what it cannot decode rather than passing it', () => {
		const bytes = module([0x41, 0x01]);
		expect(() => nonMvpFeatures(bytes.subarray(0, bytes.length - 3))).toThrow();
		expect(() => nonMvpFeatures(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(
			'not a WebAssembly module',
		);
		// 0x27 is no instruction at all.
		expect(() => nonMvpFeatures(module([0x27]))).toThrow('unknown opcode 0x27');
	});
});

describe('the committed engine', () => {
	it('is WebAssembly 1.0 and nothing later', () => {
		const wasm = ungzip(readBytes('engine-build/out/tex.wasm.gz'));
		expect(WebAssembly.validate(wasm)).toBe(true);
		expect(nonMvpFeatures(wasm)).toEqual([]);
	});
});
