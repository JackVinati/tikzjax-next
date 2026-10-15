import type { JitProbe, JitState } from './protocol';

/**
 * Whether this WebView runs WebAssembly with a JIT compiler, probably (internal/DECISIONS.md D33, D38).
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
 * 0.7 to 0.9 ns a step compiled, in V8 and JavaScriptCore alike, and 12 to 15 ns a step interpreted,
 * in JavaScriptCore with its JIT turned off, as Lockdown Mode turns it off.
 *
 * An attempt is PROBE_STEPS steps, in PROBE_CALLS calls. One that is done before the worker's clock
 * reaches PROBE_SLOW_MS settles it: only compiled code runs the loop that fast. A processor slowed
 * down, warm or in Low Power Mode, can run it slower than that with its JIT, as the maintainer's
 * iPhone, apparently throttled, may have done once, so a slow attempt is not taken for a missing JIT
 * by itself, as it was until 0.2.1-beta.5. The first attempt stops at PROBE_SLOW_MS; once it has
 * been slow, the worker gives its thread up for a moment, which lets the platform finish compiling
 * the loop where no core was free to, and tries again, up to PROBE_ATTEMPTS in all, each run on to
 * PROBE_MEASURE_MS so that it says how slow the loop is. What a step took at the fastest of them (`nsPerStep`) is then weighed
 * against what the same start spent a byte in the platform's own inflate of the core dump, native
 * code that a slow processor slows as much as it slows the loop and a missing JIT hardly slows: 29 to
 * 43 ms with the JIT and 33 to 42 without, in fresh workers in WebKit on the desktop (`verdict`).
 *
 * What it costs the start: about half a millisecond with a JIT on the desktop, as it ends with the
 * first attempt, which is fast; 8 to 10 ms where the first was slow and the second, after the
 * pause, was not; without one, PROBE_SLOW_MS and three more attempts of PROBE_MEASURE_MS with the
 * pauses between them, 33 to 40 ms in WebKit on the desktop, where until 0.2.1-beta.5 it took 12 to
 * 16. Its module is compiled beside tex.wasm, off the worker's thread, which also pays there for
 * what the first WebAssembly module of a process costs in JavaScriptCore, about 5 ms, and it runs once
 * both are compiled (compileProbeAsync).
 *
 * One probe is one moment, and weighing it against the inflate cannot tell a loop that is not compiled
 * YET from one that never will be: on a phone three times slow, a loop still waiting for
 * JavaScriptCore's compile threads all through the probe reads as an interpreter does, and says off
 * (internal/DECISIONS.md D38). So a start whose probe did not find the JIT on takes it again
 * JIT_RECHECK_MS later, once no render is under way, with the same function, which those threads have
 * had all that time to compile, and that second probe is what the start says (src/ui/report.ts
 * jitOfStart). It costs a device without the JIT the probe once more, 33 to 40 ms in WebKit on the
 * desktop, between two diagrams; one with the JIT whose first probe was slow, about a millisecond.
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
 * An attempt done before the clock reaches this settles it: 5 ns a step, which compiled code would
 * have to run four times slower than the desktop does to reach, and no interpreter has come near.
 * JavaScriptCore's clock moves a millisecond at a time in a page that is not cross-origin isolated,
 * which Obsidian's is not, so it can read 3 for anything over 2 ms, 3.3 ns a step.
 */
export const PROBE_SLOW_MS = 3;

/**
 * How long an attempt after a slow one may run, so that it says how slow the loop is: a clock that
 * moves a millisecond at a time measures 6 ms to within a sixth, where 3 ms was within a third.
 */
export const PROBE_MEASURE_MS = 6;

/**
 * How long the worker gives its thread up for before each attempt after a slow one. JavaScriptCore
 * compiles a hot WebAssembly function on threads of its own, while the loop goes on uncompiled, and
 * where no core is free for them, the worker's thread and theirs take turns. On the desktop with WebKit held to one efficiency core, attempts that
 * did not pause took the JIT for off in 6 of 16 starts that had it, as 0.2.1-beta.4's did, and in 20
 * of 24 run on to PROBE_MEASURE_MS; a pause of 1 ms did no better, 22 of 24, and one of 2, 4 or 8 ms
 * left none of 24 slow each (internal/DECISIONS.md D38).
 */
export const PROBE_PAUSE_MS = 4;

/** Attempts, before it is weighed. */
export const PROBE_ATTEMPTS = 4;

/**
 * How many times slower than a byte of the platform's inflate a step of the loop has to be for the
 * JIT to be taken for off, and how many times at most for on. Measured on the desktop of D27 in fresh
 * workers, the loop's fastest call of 8 ms or more against the inflate of the same start: with the
 * JIT, 0.3 to 0.7 times in WebKit and Chromium, idle, held to one efficiency core or with Windows'
 * power throttling on, and 0.02 to 0.9 with every core busy; without it, in WebKit, 7.7 to 8.7 idle,
 * 7.3 to 26 held to one efficiency core, and 5 to 19 with every core busy and power throttling on
 * (internal/DECISIONS.md D38). A processor slowed down all over, as one hot or in Low Power Mode,
 * slows both alike and leaves this where it was.
 */
export const OFF_RATIO = 4;
export const ON_RATIO = 2;

/**
 * However the two compare, the loop is not taken for compiled code at this many ns a step or more:
 * the fastest interpreter measured, JavaScriptCore's on the desktop's fastest core, took 12 to 13.
 * With all 32 of the desktop's threads busy with other work at normal priority, the inflate shared
 * its core more than the loop did, and without the JIT the loop came out at 0.74 times its time a
 * byte, and the shipped probe's at 0.86, which this leaves unclear rather than on.
 */
export const ON_MAX_NS = 10;

/**
 * A step this slow is taken for no JIT even with no native inflate to weigh it against, which is
 * how it is where the platform has no DecompressionStream, iOS before 16.4, and pako inflated the
 * dump: pako is JavaScript, and slows without a JIT as the loop does. Compiled code would have to run
 * the loop twenty times slower than the desktop does; slower than PROBE_SLOW_MS and faster than this
 * is unclear, as WebKit without the JIT and without the platform's decoders was on the desktop, at 11
 * to 16 ns a step.
 */
export const OFF_NS_ALONE = 20;

/**
 * How long after `ready` a start whose probe did not find the JIT on takes it again, once no render
 * is under way (worker.ts recheckJit). JavaScriptCore compiles a hot function on threads of its own,
 * which the probe's first attempts make the loop; a second gives them about eighty times what the
 * probe's own pauses give them, 12 ms in all.
 */
export const JIT_RECHECK_MS = 1000;

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
 * What a loop that took `nsPerStep` a step, none of whose attempts was fast enough to settle it,
 * says of the JIT, against the platform's inflate of the core dump in the same start, at
 * `inflateNsPerByte` a byte, where the platform inflated it: see the top of this file.
 */
export function verdict(nsPerStep: number, inflateNsPerByte: number | undefined): JitState {
	if (!(nsPerStep > 0) || !Number.isFinite(nsPerStep)) return 'unclear';
	if (inflateNsPerByte === undefined || !(inflateNsPerByte > 0) || !Number.isFinite(inflateNsPerByte))
		return nsPerStep >= OFF_NS_ALONE ? 'off' : 'unclear';
	const ratio = nsPerStep / inflateNsPerByte;
	if (ratio >= OFF_RATIO) return 'off';
	if (ratio <= ON_RATIO && nsPerStep < ON_MAX_NS) return 'on';
	return 'unclear';
}

/**
 * Gives the thread up for `ms`: the worker's own timer, which the worker passes (worker.ts `sleep`).
 * Without one the attempts follow each other at once.
 */
export type Pause = (ms: number) => Promise<void>;

const noPause: Pause = () => Promise.resolve();

/**
 * Time the loop, and say what it makes of the JIT: see the top of this file. `inflateNsPerByte` is
 * what the platform's own inflate of the core dump took in this start, a byte; undefined where it
 * did not inflate it, and `pause` gives the thread up between attempts. Undefined when the loop
 * could not be timed, where the platform refuses the module, which a WebView that runs TeX does not.
 */
export async function probeJit(
	now: () => number = () => performance.now(),
	spin?: Spin,
	inflateNsPerByte?: number,
	pause: Pause = noPause,
): Promise<JitProbe | undefined> {
	try {
		const started = now();
		const run = spin ?? compileProbe();
		let x = run(2000, 1);
		const steps = PROBE_STEPS / PROBE_CALLS;
		let fastest = Infinity;
		let nsPerStep = Infinity;
		let attempts = 0;
		let fast = false;
		while (attempts < PROBE_ATTEMPTS && !fast) {
			if (attempts > 0) await pause(PROBE_PAUSE_MS);
			const limit = attempts === 0 ? PROBE_SLOW_MS : PROBE_MEASURE_MS;
			attempts++;
			const from = now();
			let took = 0;
			let calls = 0;
			while (calls < PROBE_CALLS && took < limit) {
				x = run(steps, x);
				calls++;
				took = now() - from;
			}
			fast = calls === PROBE_CALLS && took < PROBE_SLOW_MS;
			fastest = Math.min(fastest, took);
			if (took > 0) nsPerStep = Math.min(nsPerStep, (took * 1e6) / (calls * steps));
		}
		// Each call takes the last one's result, and none can be left out as unused: nothing outside
		// WebAssembly knows what a call into it does.
		const weighed = !fast && Number.isFinite(nsPerStep);
		return {
			state: fast ? 'on' : verdict(nsPerStep, inflateNsPerByte),
			fastestMs: tenths(fastest),
			attempts,
			spentMs: tenths(now() - started),
			...(weighed ? { nsPerStep: hundredths(nsPerStep) } : {}),
			...(inflateNsPerByte === undefined ? {} : { inflateNsPerByte: hundredths(inflateNsPerByte) }),
		};
	} catch {
		return undefined;
	}
}

const tenths = (ms: number): number => Math.round(ms * 10) / 10;
const hundredths = (x: number): number => Math.round(x * 100) / 100;
