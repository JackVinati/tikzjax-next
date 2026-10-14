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
 * cut off by the engine's stack. The one exception is a line that does not fit in what is left of
 * TeX's buffer, where `set` threw one: that is LineTooLong now (change 11), which the worker reports
 * as a line too long rather than as TeX nesting too deep. Each case below runs the code as it was,
 * kept here, beside the code as it is.
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
		// As it was, but for the error `set` threw for a line longer than its target: LineTooLong now.
		const line = content.subarray(file.position2, endOfLine);
		const rest = buffer.subarray(first[0]);
		if (line.length > rest.length) throw new library.LineTooLong(bufSize);
		rest.set(line);
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
			result =
				error instanceof library.LineTooLong
					? `LineTooLong ${error.bufSize}`
					: error instanceof RangeError
						? 'RangeError'
						: `other: ${String(error)}`;
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

	it('inputln refuses a line longer than what is left of the buffer with LineTooLong, not a RangeError', () => {
		const memory = new ArrayBuffer(256);
		library.setMemory(memory);
		const descriptor = open(memory, 'long.tex', text(`${'x'.repeat(21)}\nshort`), 'r');
		new DataView(memory).setUint32(32, 0, true);
		let thrown: unknown;
		try {
			library.inputln(descriptor, 0, 64, 32, 36, 0, 20);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(library.LineTooLong);
		expect(thrown).not.toBeInstanceOf(RangeError);
		expect((thrown as InstanceType<typeof library.LineTooLong>).bufSize).toBe(20);
		// Twenty bytes fit, from the buffer's start.
		library.deleteEverything();
		library.setMemory(memory);
		const fits = open(memory, 'fits.tex', text('y'.repeat(20)), 'r');
		expect(library.inputln(fits, 0, 64, 32, 36, 0, 20)).toBe(true);
	});

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

/*
 * A font's metrics are what TeX reads when it loads the font, and the bundled ones are inflated once
 * and kept for the worker's life. A diagram that opened one of those names to write was handed the
 * kept bytes and wrote into them, and every later diagram in the worker read the font from what it
 * wrote: "Bad metric (TFM) file", or a resumed run that drew what a run from the start no longer did
 * (internal/DECISIONS.md D35).
 */
describe('a font metric file opened to write', () => {
	const NAME_AT = 0;
	const name = (memory: ArrayBuffer, filename: string) => {
		new Uint8Array(memory).set(new TextEncoder().encode(filename.padEnd(32, ' ')), NAME_AT);
		return 32;
	};
	const metrics = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
	const read = (memory: ArrayBuffer, filename: string): number[] => {
		const descriptor = library.reset(name(memory, filename), NAME_AT);
		const out: number[] = [];
		for (let i = 0; i < 64; i++) {
			library.get(descriptor, 4096, 1);
			out.push(new Uint8Array(memory)[4096]!);
		}
		return out;
	};

	it('starts empty, and the bundled metrics are as they were for the next run', () => {
		library.setBundledFiles(new Map([['eufm10.tfm', metrics]]), (bytes: Uint8Array) => bytes);
		const memory = new ArrayBuffer(1 << 16);
		library.setMemory(memory);
		// A file opened first is read as at its end (library.ts get, upstream's descriptor 0).
		library.reset(name(memory, 'first.tex'), NAME_AT);
		const out = library.rewrite(name(memory, 'eufm10.tfm'), NAME_AT);
		expect(library.erstat(out)).toBe(0);
		for (const c of 'written') library.printChar(out, c.charCodeAt(0));
		expect(new TextDecoder().decode(library.readFileSync('eufm10.tfm'))).toBe('written');
		library.deleteEverything();

		library.setMemory(memory);
		library.reset(name(memory, 'first.tex'), NAME_AT);
		expect(read(memory, 'eufm10.tfm')).toEqual(Array.from(metrics));
	});

	it('opens for a name the engine has no metrics for, where it used to be refused', () => {
		library.setBundledFiles(new Map(), (bytes: Uint8Array) => bytes);
		const memory = new ArrayBuffer(1 << 16);
		library.setMemory(memory);
		const missing: string[] = [];
		library.setMissingFileSink((filename) => missing.push(filename));
		const out = library.rewrite(name(memory, 'nosuchfont.tfm'), NAME_AT);
		expect(library.erstat(out)).toBe(0);
		expect(missing).toEqual([]);
		// To read, it is not there.
		expect(library.erstat(library.reset(name(memory, 'nosuchfont9.tfm'), NAME_AT))).toBe(1);
		expect(missing).toEqual(['nosuchfont9.tfm']);
		library.setMissingFileSink(null);
	});
});

/*
 * A run is saved where \tikzjaxsnapshot stands, at the end of its \begin{document}, for later inputs
 * that start with the same text up to the line TeX has read (engine-src/snapshot.ts, D32). That holds
 * only while TeX knows of the job's own file what its main input read, a line at a time.
 */
describe('the job file a saved run stands for', () => {
	const NAME = 0;
	const BUFFER = 4096;
	const FIRST = 64;
	const LAST = 68;

	/** A memory with `input.tex` holding `text`, opened by TeX's main input as the job file. */
	const start = (text: string) => {
		const memory = new ArrayBuffer(1 << 16);
		library.setMemory(memory);
		new Uint8Array(memory).set(new TextEncoder().encode('input.tex'), NAME);
		library.writeFileSync('input.tex', new TextEncoder().encode(text));
		library.watchJobFile('input.tex');
		const descriptor = library.reset(9, NAME);
		const line = () => {
			new DataView(memory).setUint32(FIRST, 0, true);
			return library.inputln(descriptor, 1, BUFFER, FIRST, LAST, 0, 1024);
		};
		return { memory, line };
	};

	it('is the text through the newline of the line TeX read last', () => {
		const { line } = start('a\nbb\nccc\n');
		line();
		expect(library.jobFileRead()).toBe(2);
		line();
		expect(library.jobFileRead()).toBe(5);
	});

	it('is nothing once TeX has asked the size of the job file, or opened it again', () => {
		const sized = start('a\nbb\n');
		sized.line();
		// Another file's size, or another file opened, says nothing of the job's.
		new Uint8Array(sized.memory).set(new TextEncoder().encode('other.tex'), 100);
		library.getfilesize(9, 100);
		expect(library.jobFileRead()).toBe(2);
		library.getfilesize(9, NAME);
		expect(library.jobFileRead()).toBeUndefined();

		library.deleteEverything();
		const opened = start('a\nbb\n');
		opened.line();
		library.reset(9, NAME);
		expect(library.jobFileRead()).toBeUndefined();
	});

	it('is nothing at the end of the file, at a last line with no newline, or with no file watched', () => {
		const ended = start('a\n');
		ended.line();
		ended.line();
		expect(library.jobFileRead()).toBeUndefined();

		library.deleteEverything();
		const open = start('a\nb');
		open.line();
		open.line();
		expect(library.jobFileRead()).toBeUndefined();

		library.deleteEverything();
		const unwatched = start('a\nb\n');
		unwatched.line();
		library.watchJobFile(null);
		expect(library.jobFileRead()).toBeUndefined();
	});

	it('goes on, in a run that resumes, with the new text and the files as they were', () => {
		const { memory, line } = start('pre\nbody one\n');
		line();
		new Uint8Array(memory).set(new TextEncoder().encode('input.log'), 200);
		const log = library.rewrite(9, 200);
		for (const c of 'so far') library.printChar(log, c.charCodeAt(0));
		const state = library.captureHostState();
		expect(library.hostStateBytes(state)).toBe('so far'.length);
		// Not the job's own text, which a run that resumes is always given anew: kept, it was the
		// saving diagram's whole input twice, outside what the budget counts.
		expect(state.filesystem['input.tex']).toEqual(new Uint8Array(0));
		expect(state.files.find((f) => f.filename === 'input.tex')?.content).toEqual(new Uint8Array(0));
		expect(state.files.find((f) => f.filename === 'input.tex')?.position2).toBe('pre'.length);
		// The run that saved goes on writing; what was saved does not change.
		for (const c of ', and on') library.printChar(log, c.charCodeAt(0));
		library.deleteEverything();

		library.setMemory(memory);
		library.restoreHostState(state, { 'input.tex': new TextEncoder().encode('pre\nbody two\n') });
		expect(new TextDecoder().decode(library.readFileSync('input.log'))).toBe('so far');
		new DataView(memory).setUint32(FIRST, 0, true);
		const main = state.files.findIndex((f) => f.filename === 'input.tex');
		expect(library.inputln(main, 1, BUFFER, FIRST, LAST, 0, 1024)).toBe(true);
		const last = new DataView(memory).getUint32(LAST, true);
		expect(new TextDecoder().decode(new Uint8Array(memory, BUFFER, last))).toBe('body two');
		// And a second resume starts from the state as saved, not as the first left it.
		for (const c of '!') library.printChar(log, c.charCodeAt(0));
		library.restoreHostState(state, { 'input.tex': new TextEncoder().encode('pre\nbody three\n') });
		expect(new TextDecoder().decode(library.readFileSync('input.log'))).toBe('so far');
	});

	it('calls the hook at the snapshot point, and nothing the hook throws reaches TeX', () => {
		expect(() => library.snapshotPoint()).not.toThrow();
		let called = 0;
		library.setSnapshotHook(() => {
			called++;
			throw new RangeError('out of memory');
		});
		expect(() => library.snapshotPoint()).not.toThrow();
		expect(called).toBe(1);
		library.deleteEverything();
		library.snapshotPoint();
		expect(called).toBe(1);
	});
});

/*
 * A saved run written out as bytes names the files of the worker's own rather than copying them, and
 * a run read back finds the bytes of a closed one only if asked (engine-src/stored-run.ts, change 14).
 */
describe('the files of a saved run, as bytes', () => {
	const NAME_AT = 0;
	const name = (memory: ArrayBuffer, filename: string) => {
		new Uint8Array(memory).set(new TextEncoder().encode(filename.padEnd(32, ' ')), NAME_AT);
		return 32;
	};

	it('are the bundled file TeX was handed, or dvi2html’s metrics for a font, and nothing else', () => {
		const sty = new Uint8Array([1, 2, 3]);
		library.setBundledFiles(new Map([['pgf.sty', sty]]), (bytes: Uint8Array) => bytes);
		const memory = new ArrayBuffer(1 << 16);
		library.setMemory(memory);
		library.reset(name(memory, 'first.tex'), NAME_AT);
		library.reset(name(memory, 'pgf.sty'), NAME_AT);
		library.reset(name(memory, 'cmr10.tfm'), NAME_AT);
		const [, pgf, cmr] = library.captureHostState().files;
		expect(library.storedOriginOf('pgf.sty', pgf!.content!)).toBe('bundled');
		expect(library.storedOriginOf('pgf.sty', sty.slice())).toBeUndefined();
		expect(library.storedOriginOf('cmr10.tfm', cmr!.content!)).toBe('metrics');
		expect(library.storedOriginOf('cmr10.tfm', new Uint8Array(cmr!.content!.length))).toBeUndefined();
		expect(library.storedOriginOf('first.tex', new Uint8Array(0))).toBeUndefined();
		expect(library.storedContentOf('pgf.sty', 'bundled')).toBe(sty);
		expect(library.storedContentOf('cmr10.tfm', 'metrics')).toEqual(cmr!.content);
		expect(library.storedContentOf('nosuch.sty', 'bundled')).toBeUndefined();
	});

	it('say which TeX closed, and a run that resumes shares those whole', () => {
		library.setBundledFiles(new Map([['pgf.sty', new Uint8Array([1])]]), (bytes: Uint8Array) => bytes);
		const memory = new ArrayBuffer(1 << 16);
		library.setMemory(memory);
		library.reset(name(memory, 'first.tex'), NAME_AT);
		const pgf = library.reset(name(memory, 'pgf.sty'), NAME_AT);
		const open = library.reset(name(memory, 'pgf.sty'), NAME_AT);
		library.close(pgf);
		const state = library.captureHostState();
		expect(state.files[pgf]?.closed).toBe(true);
		expect(state.files[open]?.closed).toBeUndefined();
		library.deleteEverything();
		library.setMemory(memory);
		library.restoreHostState(state, {});
		const again = library.captureHostState();
		expect(again.files[pgf]).toBe(state.files[pgf]);
		expect(again.files[open]).not.toBe(state.files[open]);
	});
});
