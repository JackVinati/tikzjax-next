import { ungzip } from 'pako';
import { afterEach, describe, expect, it } from 'vitest';
import * as library from '../engine-src/library';
import { readBytes } from './support/read-bytes';

/*
 * How a TeX run ends, as the engine's host sees it.
 *
 * TeX ends in one of two ways. Normally its main program runs to the end and returns. On a fatal
 * error, a capacity overflow or a hundredth error, its `jump_out` does `goto end_of_TEX`, a jump out
 * of every procedure at once, which WebAssembly has no instruction for. The engine used to make
 * that jump with asyncify, unwinding the stack back to the host, and the host then waited for a
 * `tex_final_end` that the jump had skipped: the run never ended, and the diagram waited for the
 * plugin's timeout instead of failing with TeX's message. Without asyncify the jump is a call to
 * the host's `jumpOut`, which ends the run where it is.
 */

afterEach(() => {
	library.deleteEverything();
	library.setLogSink(null);
});

/** What TeX prints to the terminal, character by character, as its print_char does. */
const print = (text: string) => {
	for (const c of text) library.printChar(-1, c.charCodeAt(0));
};

describe('executeAsync', () => {
	it('settles when TeX returns from its main program, and says it ended', async () => {
		let ran = false;
		await expect(library.executeAsync({ main: () => (ran = true) })).resolves.toBe('end');
		expect(ran).toBe(true);
	});

	it('settles when TeX jumps out to its end, says it jumped, and keeps the line TeX was printing', async () => {
		const log: string[] = [];
		library.setLogSink((line) => log.push(line));
		library.setShowConsole();
		const main = () => {
			print('! TeX capacity exceeded, sorry [input stack size=5000].\nl.3 \\a');
			library.jumpOut();
			print('\nTeX carried on past the jump');
		};
		await expect(library.executeAsync({ main })).resolves.toBe('jump');
		expect(log).toEqual(['! TeX capacity exceeded, sorry [input stack size=5000].', 'l.3 \\a']);
	});

	it('fails when the engine traps', async () => {
		const trap = new WebAssembly.RuntimeError('unreachable');
		const main = () => {
			throw trap;
		};
		await expect(library.executeAsync({ main })).rejects.toBe(trap);
	});
});

describe('where the host writes into the memory', () => {
	it('is where inputln put the line and moved last, and where get put the byte it read', () => {
		const memory = new ArrayBuffer(1 << 20);
		library.setMemory(memory);
		expect(library.hostWrites()).toEqual([]);
		new Uint8Array(memory).set(new TextEncoder().encode('in.tex'), 0);
		library.writeFileSync('in.tex', new TextEncoder().encode('a line\n'));
		const descriptor = library.reset(6, 0);
		// buffer at 1024, 256 long; first at 64 holds 10; last at 68.
		new DataView(memory).setUint32(64, 10, true);
		expect(library.inputln(descriptor, 0, 1024, 64, 68, 0, 256)).toBe(true);
		expect(library.hostWrites()).toEqual([[68, 1024 + 10 + 'a line'.length]]);
		library.get(descriptor, 2000, 1);
		expect(library.hostWrites()).toEqual([[68, 2001]]);
		// Far from those, a stretch of its own: the reset must not write everything between.
		library.get(descriptor, 900_000, 1);
		expect(library.hostWrites()).toEqual([
			[68, 2001],
			[900_000, 900_001],
		]);
		// A new run's memory starts with nothing written.
		library.setMemory(new ArrayBuffer(4096));
		expect(library.hostWrites()).toEqual([]);
	});
});

describe('the committed engine', () => {
	const engine = new WebAssembly.Module(ungzip(readBytes('engine-build/out/tex.wasm.gz')));

	it('exports what web2js gives every program, the marks a reset reads, and none of asyncify', () => {
		// The marks of how far the string pool and the shadow stack went (engine-build/web2js-codegen,
		// internal/DECISIONS.md D31), the stack pointer's accessors (web2js's pascal/stack.js), the
		// main program, and the memory it was handed. asyncify added five functions of its own.
		expect(WebAssembly.Module.exports(engine).map((e) => `${e.kind} ${e.name}`)).toEqual([
			'function getPoolPtrHigh',
			'function getStrPtrHigh',
			'function getStackLow',
			'function getStackPointer',
			'function setStackPointer',
			'function main',
			'memory 0',
		]);
	});

	it('imports a memory and functions the fork provides, and nothing else', () => {
		const host = library as unknown as Record<string, unknown>;
		for (const { module, name, kind } of WebAssembly.Module.imports(engine)) {
			if (module === 'env') expect(`${kind} ${name}`).toBe('memory memory');
			else {
				expect(`${kind} ${module}`).toBe('function library');
				expect(typeof host[name], `library.${name}`).toBe('function');
			}
		}
	});
});

/*
 * The calls TeX makes once a line and once a character (library.ts change 9) used to make views of
 * the memory, and an array of one byte, every time. They no longer do, and must answer exactly as
 * before: the same bytes in the same places, the same results, and a RangeError wherever a view of
 * the old kind would have refused, since a RangeError out of TeX is how the worker recognises a run
 * cut off by the engine's stack. Each case below runs the code as it was, kept here, beside the
 * code as it is.
 */
describe('the host calls TeX makes per line and per character', () => {
	interface OldFile {
		content: Uint8Array;
		position2: number;
		eof: boolean;
		eoln: boolean;
	}

	/** inputln as it was before change 9, for a file that is not the terminal. */
	const oldInputln = (
		memory: ArrayBuffer,
		file: OldFile,
		bypassEoln: number,
		bufferp: number,
		firstp: number,
		lastp: number,
		bufSize: number,
	): boolean => {
		const content = file.content;
		const buffer = new Uint8Array(memory, bufferp, bufSize);
		const first = new Uint32Array(memory, firstp, 4);
		const last = new Uint32Array(memory, lastp, 4);
		last[0] = first[0]!;
		if (bypassEoln && !file.eof && file.eoln) file.position2 = file.position2 + 1;
		if (file.eof) return false;
		let endOfLine = content.indexOf(10, file.position2);
		if (endOfLine < 0) endOfLine = content.length;
		if (file.position2 >= content.length) {
			file.eof = true;
			return false;
		}
		buffer.subarray(first[0]).set(content.subarray(file.position2, endOfLine));
		last[0] = first[0]! + endOfLine - file.position2;
		while (buffer[last[0] - 1] === 32) last[0] = last[0] - 1;
		file.position2 = endOfLine;
		file.eoln = true;
		return true;
	};

	const NAME_AT = 0;
	/** A file in the host's table, opened by name as TeX opens one: the name is read out of memory. */
	const open = (memory: ArrayBuffer, name: string, text: Uint8Array, mode: 'r' | 'w'): number => {
		new Uint8Array(memory).set(new TextEncoder().encode(name), NAME_AT);
		if (mode === 'r') {
			library.writeFileSync(name, text);
			return library.reset(name.length, NAME_AT);
		}
		return library.rewrite(name.length, NAME_AT);
	};

	/** What a call did: its result or the class of what it threw, and the memory after it. */
	const outcome = (call: () => boolean, memory: ArrayBuffer) => {
		let result: string;
		try {
			result = String(call());
		} catch (error) {
			result = error instanceof RangeError ? 'RangeError' : `other: ${String(error)}`;
		}
		return { result, memory: Array.from(new Uint8Array(memory)) };
	};

	const text = (s: string) => new TextEncoder().encode(s);
	const long = `${'x'.repeat(70)}   `;
	const contents = [
		'',
		'a',
		'one\ntwo  \n\nthree   ',
		'   \n  ',
		'\nafter an empty line',
		`${long}\n${long}`,
		'line that is longer than the buffer\nshort',
	];
	// [bufferp, bufSize, firstp, lastp, first]: the buffer's place and size, where `first` and `last`
	// live, and what `first` holds.
	const layouts: [number, number, number, number, number][] = [
		[64, 120, 32, 36, 0],
		[64, 120, 32, 36, 5],
		[64, 120, 32, 32, 3], // first and last are one variable
		[64, 20, 32, 36, 0], // a buffer too small for some lines
		[64, 20, 32, 36, 20], // first at the buffer's end
		[64, 20, 32, 36, 25], // first past it
		[64, 120, 34, 36, 0], // first misaligned
		[64, 120, 32, 38, 0], // last misaligned
		[200, 100, 32, 36, 0], // the buffer past the memory's end
		[64, 120, 250, 36, 0], // first's view past the memory's end
		[-4, 120, 32, 36, 0],
	];

	for (const content of contents) {
		it(`inputln reads ${JSON.stringify(content).slice(0, 30)} as it did, in every layout`, () => {
			for (const [bufferp, bufSize, firstp, lastp, first] of layouts) {
				for (const bypass of [0, 1]) {
					const oldMemory = new ArrayBuffer(256);
					const newMemory = new ArrayBuffer(256);
					if (firstp >= 0 && firstp + 4 <= 256)
						new DataView(newMemory).setUint32(firstp, first, true);
					library.deleteEverything();
					library.setMemory(newMemory);
					const descriptor = open(newMemory, 'lines.tex', text(content), 'r');
					new Uint8Array(oldMemory).set(new Uint8Array(newMemory));
					const file: OldFile = { content: text(content), position2: 0, eof: false, eoln: false };
					const where = `[${bufferp}, ${bufSize}] first=${first} at ${firstp}, last at ${lastp}, bypass ${bypass}`;

					// Line after line until both say the file has ended, or one throws.
					for (let call = 0; call < 6; call++) {
						const was = outcome(
							() => oldInputln(oldMemory, file, bypass, bufferp, firstp, lastp, bufSize),
							oldMemory,
						);
						const is = outcome(
							() => library.inputln(descriptor, bypass, bufferp, firstp, lastp, 0, bufSize),
							newMemory,
						);
						expect(is, `${where}, call ${call + 1}`).toEqual(was);
						if (was.result !== 'true') break;
					}
				}
			}
		});
	}

	it('printChar to the terminal gives the lines it gave', () => {
		const chars = [...'a line\n\n\nanother\nunfinished']
			.map((c) => c.charCodeAt(0))
			.concat([0, 13, 10, 300]);
		const lines: string[] = [];
		library.setLogSink((line) => lines.push(line));
		library.setShowConsole();
		library.setMemory(new ArrayBuffer(64));
		for (const c of chars) library.printChar(-1, c);
		// writeToConsole, as printChar called it with each character.
		const expected: string[] = [];
		let pending = '';
		for (const c of chars) {
			pending += String.fromCharCode(c);
			if (pending.includes('\n')) {
				const parts = pending.split('\n');
				pending = parts.pop() ?? '';
				for (const part of parts) if (part.length) expected.push(part);
			}
		}
		expect(lines).toEqual(expected);
		// What is left is printed at the end of the run, as before.
		library.tex_final_end();
		expect(lines).toEqual(pending.length ? [...expected, pending] : expected);
	});

	it('printChar to a file writes the byte it wrote, growing the file as before', () => {
		const memory = new ArrayBuffer(64);
		library.setMemory(memory);
		const descriptor = open(memory, 'out.log', new Uint8Array(), 'w');
		const chars = Array.from({ length: 300 }, (_, i) => (i * 37) % 600);
		for (const c of chars) library.printChar(descriptor, c);
		expect(Array.from(library.readFileSync('out.log'))).toEqual(chars.map((c) => c & 255));
	});

	it('nothing silent without the terminal on', () => {
		const lines: string[] = [];
		library.setLogSink((line) => lines.push(line));
		library.setMemory(new ArrayBuffer(64));
		for (const c of 'quiet\n') library.printChar(-1, c.charCodeAt(0));
		expect(lines).toEqual([]);
	});
});
