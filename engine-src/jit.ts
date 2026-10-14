import type { JitProbe } from './protocol';

/**
 * Whether this WebView runs WebAssembly with a JIT compiler, probably (internal/DECISIONS.md D33).
 *
 * Without one TeX is about twenty times slower: Lockdown Mode on an iPhone or iPad runs Obsidian's
 * web content that way, and a circuitikz diagram that took 0.27 s of TeX on the maintainer's
 * iPhone took 7.3 s with it on. Nothing in a WebView says whether it has a JIT, so the worker times
 * a loop it knows the cost of, once, at the end of its start, and the diagnostics view says what it
 * found, with what to do about it on iOS.
 *
 * The loop is the module below, 68 bytes of WebAssembly 1.0: one function that takes a step of a
 * linear congruential generator `n` times, a chain of dependent integer multiplies and adds that no
 * compiler can shorten, whose result it returns. On the desktop the engine is maintained on it takes
 * 0.77 to 0.87 ns a step compiled, in V8 and JavaScriptCore alike, and 13.75 to 15 ns a step
 * interpreted, in JavaScriptCore with its JIT turned off, as Lockdown Mode turns it off.
 *
 * An attempt is PROBE_STEPS steps, in PROBE_CALLS calls, and it is slow when the worker's clock
 * reaches PROBE_SLOW_MS before it is done, at which point it stops. The JIT is taken to be off when
 * each of PROBE_ATTEMPTS attempts is slow, so that an attempt the system took the thread away from
 * in the middle does not make a computer with a JIT look like one without. A short call comes first,
 * untimed, so that no attempt pays for the function's first compile.
 *
 * What it costs the start: about half a millisecond with a JIT on the desktop, as it ends with the
 * first attempt that is not slow, and about three milliseconds an attempt without one, as each stops
 * at PROBE_SLOW_MS. Its module is compiled beside tex.wasm, off the worker's thread, which also pays
 * there for what the first WebAssembly module of a process costs in JavaScriptCore, about 5 ms, and
 * it runs once both are compiled (compileProbeAsync).
 */

/**
 * `(func (export "spin") (param $n i32) (param $x i32) (result i32)
 *    (loop $again
 *      (local.set $x (i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223)))
 *      (br_if $again (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
 *    (local.get $x))`
 *
 * `n` has to be at least 1: the loop runs before it tests.
 */
const PROBE_PARTS: readonly (readonly number[])[] = [
	[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], // \0asm, version 1
	[0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f], // the types: one, (i32, i32) -> i32
	[0x03, 0x02, 0x01, 0x00], // the functions: one, of that type
	[0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00], // the exports: "spin", function 0
	[0x0a, 0x23, 0x01, 0x21, 0x00], // the code: one body of 33 bytes, with no locals of its own
	[0x03, 0x40], // loop
	[0x20, 0x01, 0x41, 0x8d, 0xcc, 0xe5, 0x00, 0x6c], // x * 1664525
	[0x41, 0xdf, 0xe6, 0xbb, 0xe3, 0x03, 0x6a, 0x21, 0x01], // + 1013904223, into x
	[0x20, 0x00, 0x41, 0x01, 0x6b, 0x22, 0x00, 0x0d, 0x00], // n - 1, into n; again while it is not 0
	[0x0b, 0x20, 0x01, 0x0b], // end of the loop; x; end of the function
];

/** The probe's module. */
export const PROBE_WASM: readonly number[] = PROBE_PARTS.flat();

/** The steps of one attempt: half a millisecond compiled and eight to nine interpreted, on the desktop. */
export const PROBE_STEPS = 600_000;

/** The calls an attempt is made of, so that a slow one can stop once it is known to be slow. */
export const PROBE_CALLS = 8;

/**
 * When an attempt is slow: 5 ns a step. JavaScriptCore's clock moves a millisecond at a time in a
 * page that is not cross-origin isolated, which Obsidian's is not, so it can read 3 for anything
 * over 2 ms, 3.3 ns a step. Compiled code would have to run the loop four times slower than the
 * desktop does to come near it, and an interpreter almost three times faster than the desktop's to
 * stay under it.
 */
export const PROBE_SLOW_MS = 3;

/** Attempts, before the JIT is taken to be off. */
export const PROBE_ATTEMPTS = 4;

/** The probe's function: `n` steps of the generator from `x`. */
export type Spin = (n: number, x: number) => number;

/** The probe's function, compiled. Synchronously: the module is 68 bytes, and this is a worker. */
export function compileProbe(): Spin {
	return spinOf(new WebAssembly.Module(Uint8Array.from(PROBE_WASM)));
}

/**
 * The probe's function, compiled off the worker's thread, as tex.wasm is: what the worker starts
 * beside tex.wasm's compile, so that only the warm-up call and the attempts run on its thread before
 * `ready`. Compiled on it, with `new WebAssembly.Module`, the probe took WebKit's starts on a loaded
 * desktop a median of 13 ms and up to 242, though each of its attempts took a millisecond at most
 * (internal/DECISIONS.md D33). Undefined where the platform refuses the module.
 */
export function compileProbeAsync(): Promise<Spin | undefined> {
	return WebAssembly.compile(Uint8Array.from(PROBE_WASM))
		.then(spinOf)
		.catch(() => undefined);
}

const spinOf = (module: WebAssembly.Module): Spin =>
	(new WebAssembly.Instance(module).exports as { spin: Spin }).spin;

/**
 * Time the loop, and say whether it ran as compiled code runs: see the top of this file. Undefined
 * when it could not be timed, where the platform refuses the module, which a WebView that runs TeX
 * does not.
 */
export function probeJit(now: () => number = () => performance.now(), spin?: Spin): JitProbe | undefined {
	try {
		const started = now();
		const run = spin ?? compileProbe();
		let x = run(2000, 1);
		const steps = PROBE_STEPS / PROBE_CALLS;
		let fastest = Infinity;
		let attempts = 0;
		while (attempts < PROBE_ATTEMPTS && !(fastest < PROBE_SLOW_MS)) {
			attempts++;
			const from = now();
			let took = 0;
			for (let call = 0; call < PROBE_CALLS && took < PROBE_SLOW_MS; call++) {
				x = run(steps, x);
				took = now() - from;
			}
			fastest = Math.min(fastest, took);
		}
		// Each call takes the last one's result, and none can be left out as unused: nothing outside
		// WebAssembly knows what a call into it does.
		return {
			on: fastest < PROBE_SLOW_MS,
			fastestMs: tenths(fastest),
			attempts,
			spentMs: tenths(now() - started),
		};
	} catch {
		return undefined;
	}
}

const tenths = (ms: number): number => Math.round(ms * 10) / 10;
