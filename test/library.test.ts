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
	it('settles when TeX returns from its main program', async () => {
		let ran = false;
		await expect(library.executeAsync({ main: () => (ran = true) })).resolves.toBeUndefined();
		expect(ran).toBe(true);
	});

	it('settles when TeX jumps out to its end, and keeps the line TeX was printing', async () => {
		const log: string[] = [];
		library.setLogSink((line) => log.push(line));
		library.setShowConsole();
		const main = () => {
			print('! TeX capacity exceeded, sorry [input stack size=5000].\nl.3 \\a');
			library.jumpOut();
			print('\nTeX carried on past the jump');
		};
		await expect(library.executeAsync({ main })).resolves.toBeUndefined();
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

describe('the committed engine', () => {
	const engine = new WebAssembly.Module(ungzip(readBytes('engine-build/out/tex.wasm.gz')));

	it('exports what web2js gives every program, and none of asyncify', () => {
		// The stack pointer's accessors (web2js's pascal/stack.js), the main program, and the
		// memory it was handed. asyncify added five functions of its own to these.
		expect(WebAssembly.Module.exports(engine).map((e) => `${e.kind} ${e.name}`)).toEqual([
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
