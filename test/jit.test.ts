import { describe, expect, it } from 'vitest';
import {
	compileProbe,
	compileProbeAsync,
	OFF_NS_ALONE,
	OFF_RATIO,
	ON_MAX_NS,
	ON_RATIO,
	PROBE_ATTEMPTS,
	PROBE_CALLS,
	PROBE_MEASURE_MS,
	PROBE_PAUSE_MS,
	PROBE_SLOW_MS,
	PROBE_STEPS,
	PROBE_WASM,
	probeJit,
	verdict,
	type Pause,
	type Spin,
} from '../engine-src/jit';
import { nonMvpFeatures } from '../scripts/wasm-mvp.mjs';

/*
 * Whether WebAssembly runs with a JIT, probably (internal/DECISIONS.md D33): the worker times a loop
 * of known cost at the end of its start. Without a JIT, as in Lockdown Mode on an iPhone, TeX is
 * about twenty times slower, and the diagnostics view says why. A probe that cried "no JIT" on a
 * device that has one sends someone after a setting that is not there, as 0.2.1-beta.4's did on the
 * maintainer's iPhone when it was hot: so a slow loop is weighed against the platform's own inflate
 * of the core dump in the same start, which a slow processor slows as much and a missing JIT not at
 * all, and the cases below hold it to that, with timings recorded on the desktop and the phone.
 */

/** The steps of the generator the module takes, in JavaScript. */
function lcg(n: number, x: number): number {
	for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
	return x;
}

/** The core dump's non-zero runs, inflated, which the inflate is timed over: 22.1 MiB. */
const DUMP_BYTES = 23_166_888;

/** ns a byte, for an inflate of the dump that took `ms`. */
const inflated = (ms: number): number => (ms * 1e6) / DUMP_BYTES;

/**
 * A clock and a stand-in for the module, in which `nsPerStep` is what a step costs: the clock moves
 * only when the loop runs or the thread is given up, but for `stall`, which moves it once, by that
 * much, at the n-th call. `tickMs` rounds what the clock says down to its ticks, as WebKit's moves a
 * millisecond at a time in a page that is not cross-origin isolated.
 */
function simulated(
	nsPerStep: number,
	options: { stall?: { atCall: number; ms: number }; tickMs?: number } = {},
) {
	let ms = 0.37;
	const calls: { n: number; x: number }[] = [];
	const pauses: number[] = [];
	const spin: Spin = (n, x) => {
		calls.push({ n, x });
		if (options.stall !== undefined && calls.length === options.stall.atCall) ms += options.stall.ms;
		ms += (n * nsPerStep) / 1e6;
		return lcg(n, x);
	};
	const pause: Pause = (wait) => {
		pauses.push(wait);
		ms += wait;
		return Promise.resolve();
	};
	const tick = options.tickMs;
	const now = () => (tick === undefined ? ms : Math.floor(ms / tick) * tick);
	return { now, spin, calls, pauses, pause };
}

const probe = (
	nsPerStep: number,
	inflateNsPerByte: number | undefined,
	options?: Parameters<typeof simulated>[1],
) => {
	const sim = simulated(nsPerStep, options);
	return probeJit(sim.now, sim.spin, inflateNsPerByte, sim.pause);
};

describe('the module the probe times', () => {
	const bytes = Uint8Array.from(PROBE_WASM);

	it('is WebAssembly 1.0, and nothing later, as the engine is', () => {
		expect(bytes.length).toBe(68);
		expect(WebAssembly.validate(bytes)).toBe(true);
		expect(nonMvpFeatures(bytes)).toEqual([]);
	});

	it('takes n steps of the generator from x, and returns where they end', () => {
		const spin = compileProbe();
		for (const [n, x] of [
			[1, 1],
			[10, 1],
			[2000, 1],
			[75_000, -123_456],
		] as const) {
			expect(spin(n, x), `${n} from ${x}`).toBe(lcg(n, x));
		}
	});

	it('compiles off the thread to the same function, as the worker starts it beside tex.wasm', async () => {
		const spin = await compileProbeAsync();
		expect(spin?.(75_000, -123_456)).toBe(lcg(75_000, -123_456));
		expect(await probeJit(undefined, spin)).toMatchObject({ state: 'on' });
	});
});

describe('probeJit', () => {
	it('takes the JIT to be on when the loop runs as compiled code, in one attempt and no pause', async () => {
		// What the desktop measured with a JIT: 0.7 to 0.9 ns a step.
		const sim = simulated(0.8);
		const found = await probeJit(sim.now, sim.spin, inflated(25), sim.pause);
		expect(found).toMatchObject({ state: 'on', attempts: 1 });
		expect(found?.fastestMs).toBeCloseTo(0.5, 1);
		// Settled by its speed alone: it is not weighed, and says no speed it did not measure.
		expect(found?.nsPerStep).toBeUndefined();
		expect(sim.pauses).toEqual([]);
		// The warm-up call, then the attempt's calls, each from the last one's result.
		expect(sim.calls.map((c) => c.n)).toEqual([
			2000,
			...Array<number>(PROBE_CALLS).fill(PROBE_STEPS / PROBE_CALLS),
		]);
		for (let i = 1; i < sim.calls.length; i++)
			expect(sim.calls[i]?.x).toBe(lcg(sim.calls[i - 1]!.n, sim.calls[i - 1]!.x));
	});

	it('takes it to be off when every attempt is slow and the loop far slower than the inflate', async () => {
		// What JavaScriptCore without its JIT measured: 12 to 15 ns a step, and an inflate of 34 ms.
		const sim = simulated(13.75);
		const found = await probeJit(sim.now, sim.spin, inflated(34), sim.pause);
		expect(found).toMatchObject({ state: 'off', attempts: PROBE_ATTEMPTS });
		expect(found?.nsPerStep).toBeGreaterThan(13);
		expect(found?.nsPerStep).toBeLessThan(15);
		expect(found?.inflateNsPerByte).toBeCloseTo(inflated(34), 2);
		// The first attempt stops at the first call past PROBE_SLOW_MS, 75,000 steps being 1.03 ms
		// here, so after three; each later one, after a pause, at the first past PROBE_MEASURE_MS.
		expect(sim.pauses).toEqual(Array<number>(PROBE_ATTEMPTS - 1).fill(PROBE_PAUSE_MS));
		expect(sim.calls.length).toBe(1 + 3 + (PROBE_ATTEMPTS - 1) * 6);
		expect(found?.spentMs).toBeLessThan(
			PROBE_SLOW_MS + 1.1 + (PROBE_ATTEMPTS - 1) * (PROBE_PAUSE_MS + PROBE_MEASURE_MS + 1.1),
		);
	});

	it('takes it to be on when an attempt the system interrupted is followed by one that is not slow', async () => {
		// The thread taken away for 20 ms in the middle of the first attempt, as on a loaded computer.
		expect(await probe(0.8, inflated(25), { stall: { atCall: 4, ms: 20 } })).toMatchObject({
			state: 'on',
			attempts: 2,
		});
	});

	/*
	 * The maintainer's iPhone 16 Pro, with Obsidian excluded from Lockdown Mode, read twice on
	 * 2026-10-15 with 0.2.1-beta.4 in the diagnostics view. Hot or in a low power state: the inflate
	 * took 86 ms where it took 26 the day before, 3.3 times as long, and every one of the four
	 * attempts reached 3 ms by WebKit's clock, a millisecond at a time, so that the loop ran at
	 * 3.3 ns a step or slower where it runs at about 1. Closed and opened again: an inflate of 39 to
	 * 47 ms, and a probe of 1 to 2 ms. Both had the JIT.
	 */
	it("finds the JIT on for the maintainer's iPhone, hot and not, as 0.2.1-beta.4 did not", async () => {
		for (const nsPerStep of [3.3, 4, 5, 6.6])
			expect(
				await probe(nsPerStep, inflated(86), { tickMs: 1 }),
				`${nsPerStep} ns a step`,
			).toMatchObject({
				state: 'on',
			});
		// Where every attempt was slow, as each of beta.4's four was, which made it say off: weighed.
		const hot = await probe(5.5, inflated(86), { tickMs: 1 });
		expect(hot).toMatchObject({ state: 'on', attempts: PROBE_ATTEMPTS });
		expect(hot?.nsPerStep).toBeGreaterThan(4.5);
		expect(hot?.nsPerStep).toBeLessThan(6.7);
		for (const ms of [39, 47])
			expect(await probe(1, inflated(ms), { tickMs: 1 })).toMatchObject({ state: 'on' });
	});

	it('finds a processor slowed down all over the JIT on, however slow, where the loop is compiled', async () => {
		// Compiled, the loop takes about 0.8 ns a step on the desktop, and the inflate 1.1 ns a byte;
		// a processor slower all over by `k` slows both alike.
		for (const k of [2, 3.3, 5, 8])
			expect(await probe(0.8 * k, inflated(25 * k), { tickMs: 1 }), `${k} times slower`).toMatchObject({
				state: 'on',
			});
		// And interpreted, however slow, off: 12.5 ns a step against 1.47 ns a byte on the desktop.
		for (const k of [0.6, 1, 2, 3.3])
			expect(await probe(12.5 * k, inflated(34 * k), { tickMs: 1 }), `${k} times slower`).toMatchObject(
				{
					state: 'off',
				},
			);
	});

	it('is unclear where the loop is slow and the inflate not slow enough to say why', async () => {
		// Three times the inflate's time a byte: neither compiled code nor an interpreter as measured.
		expect(await probe(6, inflated(37.4))).toMatchObject({ state: 'unclear' });
		// Interpreted, while the inflate shared its processor with other work: under twice its time a
		// byte, yet slower than compiled code is taken to run.
		expect(await probe(12, inflated(160))).toMatchObject({ state: 'unclear' });
	});

	it('without a native inflate to weigh it against, says off only for a loop slower than any compiled', async () => {
		// iOS before 16.4 has no DecompressionStream; pako inflated the dump, and is JavaScript.
		expect(await probe(0.8, undefined)).toMatchObject({ state: 'on' });
		expect(await probe(6, undefined)).toMatchObject({ state: 'unclear' });
		expect(await probe(13.75, undefined)).toMatchObject({ state: 'unclear' });
		expect(await probe(25, undefined)).toMatchObject({ state: 'off' });
		expect((await probe(25, undefined))?.inflateNsPerByte).toBeUndefined();
	});

	it('says nothing when the loop cannot run', async () => {
		const refused: Spin = () => {
			throw new Error('WebAssembly refused');
		};
		expect(await probeJit(() => 0, refused)).toBeUndefined();
	});

	it('finds the JIT on in Node, which has one, without being told how to run the module', async () => {
		// The real module and clock: the test runner's other threads busy beside it, as on a
		// computer doing other things, and no inflate to weigh it against.
		expect(await probeJit()).toMatchObject({ state: 'on' });
	});
});

describe('verdict', () => {
	it('weighs a slow loop against the inflate, at the thresholds', () => {
		expect(verdict(OFF_RATIO * 1.5, 1.5)).toBe('off');
		expect(verdict(OFF_RATIO * 1.5 - 0.01, 1.5)).toBe('unclear');
		expect(verdict(ON_RATIO * 1.5, 1.5)).toBe('on');
		expect(verdict(ON_RATIO * 1.5 + 0.01, 1.5)).toBe('unclear');
		// Never on at ON_MAX_NS or slower, however slow the inflate.
		expect(verdict(ON_MAX_NS - 0.01, 9)).toBe('on');
		expect(verdict(ON_MAX_NS, 9)).toBe('unclear');
		expect(verdict(OFF_NS_ALONE, undefined)).toBe('off');
		expect(verdict(OFF_NS_ALONE - 0.01, undefined)).toBe('unclear');
	});

	it('says nothing it has no figures for', () => {
		expect(verdict(Infinity, 1)).toBe('unclear');
		expect(verdict(Number.NaN, 1)).toBe('unclear');
		expect(verdict(14, 0)).toBe('unclear');
		expect(verdict(14, Number.NaN)).toBe('unclear');
	});

	/*
	 * Starts recorded on the desktop of D27 on 2026-10-15 (Windows 11, i9-13900K; Playwright 1.63's
	 * WebKit 26.6 and Chromium 153): in each, the loop's ns a step at the fastest attempt as the
	 * shipped probe takes it, and the inflate's ns a byte, of a fresh worker started as the plugin
	 * starts one (DECISIONS.md D33 has the campaign). Under each condition, the slowest and fastest
	 * recorded.
	 */
	it('says what each recorded start had', () => {
		for (const [ns, inflate, expected, where] of RECORDED)
			expect(verdict(ns, inflate), `${where}: ${ns} ns a step, ${inflate} ns a byte`).toBe(expected);
	});
});

/** [ns a step, inflate ns a byte, what it is, where it was recorded]: see the test that reads it. */
const RECORDED: readonly [number, number, 'on' | 'off' | 'unclear', string][] = [
	// With the JIT, slowed down all over: Chromium's worker with its clock run 8 times fast, so that
	// every step it timed, the inflate's included, read 8 times as long.
	[5.33, 13.81, 'on', 'Chromium 153, clock ×8'],
	[6.67, 12.16, 'on', 'Chromium 153, clock ×8'],
	// Without it, JSC_useJIT=false, as Lockdown Mode runs WebKit.
	[13.33, 2.12, 'off', 'WebKit 26.6 without the JIT, idle'],
	[16, 1.86, 'off', 'WebKit 26.6 without the JIT, idle'],
	[20, 2.68, 'off', 'WebKit 26.6 without the JIT, one efficiency core'],
	[31.11, 2.55, 'off', 'WebKit 26.6 without the JIT, one efficiency core'],
	[44, 7.12, 'off', 'WebKit 26.6 without the JIT, clock ×3.3'],
	[106.67, 17.96, 'off', 'WebKit 26.6 without the JIT, clock ×8'],
	[13.33, 1.51, 'off', 'WebKit 26.6, WebAssembly interpreted (JSC_useBBQJIT=false)'],
	// Without it, every core busy with 48 processes: the inflate shared its core, the loop less so.
	[20, 2.63, 'off', 'WebKit 26.6 without the JIT, loaded'],
	[23.33, 27.28, 'unclear', 'WebKit 26.6 without the JIT, loaded'],
];
