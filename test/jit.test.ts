import { describe, expect, it } from 'vitest';
import {
	compileProbe,
	compileProbeAsync,
	PROBE_ATTEMPTS,
	PROBE_CALLS,
	PROBE_SLOW_MS,
	PROBE_STEPS,
	PROBE_WASM,
	probeJit,
	type Spin,
} from '../engine-src/jit';
import { nonMvpFeatures } from '../scripts/wasm-mvp.mjs';

/*
 * Whether WebAssembly runs with a JIT, probably (internal/DECISIONS.md D33): the worker times a loop
 * of known cost at the end of its start. Without a JIT, as in Lockdown Mode on an iPhone, TeX is
 * about twenty times slower, and the diagnostics view says why. A probe that cried "no JIT" on a
 * computer that has one would send someone after a setting that is not there, so the cases below
 * hold it to taking the JIT to be off only when every attempt was slow.
 */

/** The steps of the generator the module takes, in JavaScript. */
function lcg(n: number, x: number): number {
	for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
	return x;
}

/**
 * A clock and a stand-in for the module, in which `nsPerStep` is what a step costs: the clock moves
 * only when the loop runs, but for `stall`, which moves it once, by that much, at the n-th call.
 */
function simulated(nsPerStep: number, stall?: { atCall: number; ms: number }) {
	let ms = 0;
	const calls: { n: number; x: number }[] = [];
	const spin: Spin = (n, x) => {
		calls.push({ n, x });
		if (stall !== undefined && calls.length === stall.atCall) ms += stall.ms;
		ms += (n * nsPerStep) / 1e6;
		return lcg(n, x);
	};
	return { now: () => ms, spin, calls };
}

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
		expect(probeJit(undefined, spin)).toMatchObject({ on: true });
	});
});

describe('probeJit', () => {
	it('takes the JIT to be on when the loop runs as compiled code, in one attempt', () => {
		// What the desktop measured with a JIT: 0.77 to 0.87 ns a step.
		const { now, spin, calls } = simulated(0.8);
		const probe = probeJit(now, spin);
		expect(probe).toMatchObject({ on: true, attempts: 1 });
		expect(probe?.fastestMs).toBeCloseTo(0.5, 1);
		// The warm-up call, then the attempt's calls, each from the last one's result.
		expect(calls.map((c) => c.n)).toEqual([
			2000,
			...Array<number>(PROBE_CALLS).fill(PROBE_STEPS / PROBE_CALLS),
		]);
		for (let i = 1; i < calls.length; i++)
			expect(calls[i]?.x).toBe(lcg(calls[i - 1]!.n, calls[i - 1]!.x));
	});

	it('takes it to be off only when every attempt is slow, and stops each once it is', () => {
		// What JavaScriptCore without its JIT measured: 13.75 to 15 ns a step.
		const { now, spin, calls } = simulated(13.75);
		const probe = probeJit(now, spin);
		expect(probe).toMatchObject({ on: false, attempts: PROBE_ATTEMPTS });
		expect(probe?.fastestMs).toBeGreaterThanOrEqual(PROBE_SLOW_MS);
		// Each attempt stops at the first call that takes it past the threshold: 75,000 steps are
		// 1.03 ms here, so three calls, not eight.
		expect(calls.length).toBe(1 + PROBE_ATTEMPTS * 3);
		expect(probe?.spentMs).toBeLessThan(PROBE_ATTEMPTS * (PROBE_SLOW_MS + 1.1));
	});

	it('takes it to be on when an attempt the system interrupted is followed by one that is not slow', () => {
		// The thread taken away for 20 ms in the middle of the first attempt, as on a loaded computer.
		const { now, spin } = simulated(0.8, { atCall: 4, ms: 20 });
		expect(probeJit(now, spin)).toMatchObject({ on: true, attempts: 2 });

		// And in the middle of the first two: the third decides.
		let ms = 0;
		let call = 0;
		const twice: Spin = (n, x) => {
			call++;
			if (call === 3 || call === 10) ms += 20;
			ms += (n * 0.8) / 1e6;
			return lcg(n, x);
		};
		expect(probeJit(() => ms, twice)).toMatchObject({ on: true, attempts: 3 });
	});

	it('says the JIT is off for a loop just slower than the threshold, and on for one just faster', () => {
		// 5 ns a step is 3 ms an attempt.
		expect(probeJit(...pair(5.2))).toMatchObject({ on: false });
		expect(probeJit(...pair(4.8))).toMatchObject({ on: true });
	});

	it('says nothing when the loop cannot run', () => {
		const refused: Spin = () => {
			throw new Error('WebAssembly refused');
		};
		expect(probeJit(() => 0, refused)).toBeUndefined();
	});

	it('finds the JIT on in Node, which has one, without being told how to run the module', () => {
		// The real module and clock: the test runner's other threads busy beside it, as on a computer
		// doing other things.
		expect(probeJit()).toMatchObject({ on: true });
	});
});

function pair(nsPerStep: number): [() => number, Spin] {
	const { now, spin } = simulated(nsPerStep);
	return [now, spin];
}
