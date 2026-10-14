import { describe, expect, it } from 'vitest';
import { readCoreDump } from '../scripts/engine-assets.mjs';
import { sha256Hex } from '../src/cache/sha256';
import { readText } from './support/read-text';

/*
 * TeX's hash table, as the engine is built with it (engine-build/build-engine.sh, D15).
 *
 * TeX hashes a control sequence's name to one of hash_prime slots and chains a name whose slot is
 * taken into a free one elsewhere in the table. web2js sized the table for 600,000 names and left
 * hash_prime at tex.web's 1777, so the 33,822 names in the dump hung in chains 19 long. The build
 * raises it. The engine is a committed artifact, so the value the build script sets has to be the
 * one the committed engine says it was built with, or the script describes an engine nobody built.
 */

const HASH_SIZE = 600000;

const field = (manifest: string, name: string): string | undefined =>
	new RegExp(`^${name} +(.+)$`, 'm').exec(manifest)?.[1];

const isPrime = (n: number): boolean => {
	if (n < 2) return false;
	for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
	return true;
};

describe("TeX's hash table", () => {
	const script = readText('engine-build/build-engine.sh');
	const manifest = readText('engine-build/out/BUILD-MANIFEST.txt');
	const set = Number(/^HASH_PRIME=(\d+)$/m.exec(script)?.[1]);

	it('is hashed into by a prime that fits the table and spreads the dump over many slots', () => {
		expect(isPrime(set)).toBe(true);
		expect(set).toBeLessThanOrEqual(HASH_SIZE);
		// At least twice the names the largest fixture ends with, circuitikz's 51,463.
		expect(set).toBeGreaterThan(2 * 51463);
	});

	it('is what the committed engine was built with', () => {
		expect(field(manifest, 'hash_prime')).toBe(`${set} (hash_size ${HASH_SIZE})`);
	});
});

/*
 * The code generator TeX is compiled with (D27). Three files of web2js's compiler are replaced by
 * ours, in engine-build/web2js-codegen, and the build stops unless web2js's own copies are the ones
 * ours were written against. The engine is committed, so the files here have to be the ones the
 * committed engine was built with: an edit to one of them without a rebuild fails this.
 */
describe('the code generator TeX is compiled with', () => {
	const script = readText('engine-build/build-engine.sh');
	const manifest = readText('engine-build/out/BUILD-MANIFEST.txt');
	const files = ['function-declaration.js', 'function-evaluation.js', 'memory.js'];

	it('replaces three files of web2js, each against the sha256 of the one it replaces', () => {
		expect(/^CODEGEN=\(([^)]*)\)$/m.exec(script)?.[1]).toBe(files.join(' '));
		const sums = (/<<'SUMS'\n([\s\S]*?)\nSUMS\n/.exec(script)?.[1] ?? '').split('\n');
		expect(sums.map((line) => line.split(' ')[1])).toEqual(files);
		for (const line of sums) expect(line).toMatch(/^[0-9a-f]{64} \S+$/);
	});

	it('is the one the committed engine was built with', () => {
		const hash = sha256Hex(files.map((f) => readText(`engine-build/web2js-codegen/${f}`)).join('')).slice(
			0,
			16,
		);
		expect(field(manifest, 'web2js codegen')).toBe(
			`${files.join(' ')} (engine-build/web2js-codegen, sha256 ${hash})`,
		);
	});

	it('optimises with the binaryen the image pins by its published integrity', () => {
		const dockerfile = readText('engine-build/Dockerfile');
		const version = /^ARG BINARYEN_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(dockerfile).toMatch(/^ARG BINARYEN_INTEGRITY=sha512-[A-Za-z0-9+/]{86}==$/m);
		expect(field(manifest, 'wasm-opt')).toBe(`--mvp-features -O4 (binaryen ${version}), no asyncify`);
	});
});

/*
 * memory-layout.json, which the build writes as web2js lays TeX's globals out: where each lies in the
 * memory, and for an array its index range. It is what lets the worker find the parts of the memory a
 * run can have written, by TeX's own counters, so the offsets must be the engine's. Read against the
 * committed core dump, each counter has to hold a value TeX could have left in it there, which an
 * offset off by even one variable would not.
 */
describe('the memory layout', () => {
	interface Variable {
		name: string;
		offset: number;
		bytes: number;
		min?: number;
		max?: number;
		entry?: number;
	}
	const layout = JSON.parse(readText('engine-build/out/memory-layout.json')) as {
		pages: number;
		hashPrime: number;
		globalsEnd: number;
		dataEnd: number;
		variables: Variable[];
	};
	const byName = new Map(layout.variables.map((v) => [v.name, v]));
	const array = (name: string): Required<Variable> => {
		const v = byName.get(name);
		if (v?.min === undefined || v.max === undefined || v.entry === undefined)
			throw new Error(`no array ${name}`);
		return v as Required<Variable>;
	};

	it('belongs to the committed engine, as its CHECKSUMS and manifest say', () => {
		const checksums = readText('engine-build/out/CHECKSUMS');
		const manifest = readText('engine-build/out/BUILD-MANIFEST.txt');
		expect(checksums).toContain(
			`${sha256Hex(readText('engine-build/out/memory-layout.json'))}  memory-layout.json`,
		);
		expect(field(manifest, 'memory pages')).toMatch(new RegExp(`^${layout.pages} `));
		expect(field(manifest, 'hash_prime')).toBe(`${layout.hashPrime} (hash_size ${HASH_SIZE})`);
	});

	it('has the globals one after another, below the string literals and the stack', () => {
		let end = 0;
		for (const v of layout.variables) {
			expect(v.offset % 4, v.name).toBe(0);
			expect(v.offset, v.name).toBeGreaterThanOrEqual(end);
			if (v.min !== undefined) expect(v.bytes, v.name).toBe((v.max! - v.min + 1) * v.entry!);
			end = v.offset + v.bytes;
		}
		expect(end).toBeLessThanOrEqual(layout.globalsEnd);
		expect(layout.globalsEnd).toBeLessThanOrEqual(layout.dataEnd);
		expect(layout.dataEnd).toBeLessThan(layout.pages * 65536);
	});

	it('finds in the core dump counters that fit the arrays they count', () => {
		const dump = readCoreDump('.');
		expect(dump.length).toBe(layout.pages * 65536);
		const view = new DataView(dump.buffer, dump.byteOffset, dump.length);
		const int = (name: string): number => {
			const v = byName.get(name);
			if (v?.bytes !== 4) throw new Error(`no counter ${name}`);
			return view.getInt32(v.offset, true);
		};

		// Variable-size nodes grow up from the bottom of mem to lo_mem_max, one-word nodes down from
		// mem_end to hi_mem_min, and nothing lies between.
		const mem = array('mem');
		expect(int('lo_mem_max')).toBeGreaterThan(mem.min);
		expect(int('lo_mem_max')).toBeLessThan(int('hi_mem_min'));
		expect(int('hi_mem_min')).toBeLessThanOrEqual(int('mem_end'));
		expect(int('mem_end')).toBeLessThanOrEqual(mem.max);
		// The format's strings, and their starts.
		expect(int('pool_ptr')).toBeGreaterThan(0);
		expect(int('pool_ptr')).toBeLessThanOrEqual(array('str_pool').max);
		expect(int('str_ptr')).toBeGreaterThan(256);
		expect(int('str_ptr')).toBeLessThanOrEqual(array('str_start').max);
		// The fonts the format loaded, the hyphenation trie it packed, and where the hash table's
		// names chained out of their slots.
		expect(int('fmem_ptr')).toBeGreaterThan(0);
		expect(int('fmem_ptr')).toBeLessThanOrEqual(array('font_info').max + 1);
		expect(int('trie_max')).toBeGreaterThan(0);
		expect(int('trie_max')).toBeLessThanOrEqual(array('trie').max);
		const hash = array('hash');
		expect(hash.max - hash.min + 1).toBeGreaterThanOrEqual(layout.hashPrime);
		expect(int('hash_used')).toBeGreaterThan(hash.min + layout.hashPrime - 1);
		expect(int('hash_used')).toBeLessThanOrEqual(hash.max + 1);
		// The save stack, as deep as it has been and as deep as it is.
		expect(int('save_ptr')).toBeGreaterThanOrEqual(0);
		expect(int('save_ptr')).toBeLessThanOrEqual(int('max_save_stack'));
		expect(int('max_save_stack')).toBeLessThanOrEqual(array('save_stack').max);
		expect(byName.has('eqtb')).toBe(true);
		array('eqtb');
	}, 60_000);
});
