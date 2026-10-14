import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	BootTimings,
	EngineInventory,
	OkMessage,
	SavedRunMessage,
	StoredRun,
	WorkerRequest,
	WorkerResponse,
} from '../engine-src/protocol';

// The real module is the worker string and its 9.7 MB payload, produced by the build; a payload of
// three short strings stands in for it.
vi.mock('virtual:engine', () => ({
	WORKER_SOURCE: '',
	ENGINE_ASSETS: { wasm: 'd2FzbQ==', dump: 'ZHVtcA==', files: { 'pgf.sty': 'c3R5' } },
	ENGINE_ID: 'test-engine',
	ENGINE_INVENTORY: null,
}));

import { buildInput, routeOf } from '../engine-src/document';
import { NO_WEBASSEMBLY } from '../src/engine/hints';
import { pickEngine } from '../src/engine/route';
import { WorkerHost, type StoredRuns } from '../src/engine/worker-host';
import { QueueError } from '../src/queue/queue';
import { InterruptedError, TexError, type TexResult } from '../src/types';

// ------------------------------------------------------------------------------------------
// Harness
//
// A Worker that does nothing on its own: the test boots it, answers its jobs and crashes it by
// hand, which is what makes the orderings below — a kill during boot, a reply racing an abort —
// reproducible in Node.

const INVENTORY: EngineInventory = {
	engineId: 'test-engine',
	engine: 'test',
	packages: {},
	files: [],
	capabilities: { expl3: true, twoPass: false },
};

class FakeWorker {
	static spawned: FakeWorker[] = [];

	readonly url: string;
	readonly posted: WorkerRequest[] = [];
	terminated = false;
	onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWorker.spawned.push(this);
	}

	postMessage(message: WorkerRequest): void {
		this.posted.push(message);
	}

	terminate(): void {
		this.terminated = true;
	}

	/** Render requests this worker has been handed, in order. */
	get renders(): number[] {
		return this.posted.flatMap((m) => (m.type === 'boot' ? [] : [m.id]));
	}

	boot(timings?: BootTimings): void {
		this.emit({ type: 'ready', engineId: 'test-engine', inventory: INVENTORY, boot: timings });
	}

	reply(id: number, svg = '<svg/>'): void {
		this.emit({ type: 'ok', id, svg, log: [], missing: [], durationMs: 1 });
	}

	crash(message: string): void {
		this.onerror?.({ message } as ErrorEvent);
	}

	emit(message: WorkerResponse): void {
		this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
	}
}

class FakeTimers {
	private nextId = 1;
	readonly scheduled = new Map<number, { at: number; fn: () => void }>();
	private now = 0;

	setTimeout = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.scheduled.set(id, { at: this.now + ms, fn });
		return id;
	};

	clearTimeout = (id: number): void => {
		this.scheduled.delete(id);
	};

	advance(ms: number): void {
		this.now += ms;
		for (const [id, t] of this.scheduled) {
			if (t.at > this.now) continue;
			this.scheduled.delete(id);
			t.fn();
		}
	}
}

async function tick(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Tracked {
	status: 'pending' | 'fulfilled' | 'rejected';
	value: TexResult | undefined;
	error: unknown;
}

function track(promise: Promise<TexResult>): Tracked {
	const state: Tracked = { status: 'pending', value: undefined, error: undefined };
	promise.then(
		(value) => {
			state.status = 'fulfilled';
			state.value = value;
		},
		(error: unknown) => {
			state.status = 'rejected';
			state.error = error;
		},
	);
	return state;
}

function job(key: string) {
	return { key, source: `\\draw (0,0) -- (1,1); % ${key}`, options: {}, timeoutMs: 1000 };
}

let realWorker: unknown;

beforeEach(() => {
	FakeWorker.spawned = [];
	realWorker = (globalThis as { Worker?: unknown }).Worker;
	(globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(() => {
	(globalThis as { Worker?: unknown }).Worker = realWorker;
});

function worker(n: number): FakeWorker {
	const w = FakeWorker.spawned[n];
	if (!w) throw new Error(`no worker #${n} was spawned`);
	return w;
}

/** Render a job, recording when the host says it reached the worker. */
function render(host: WorkerHost, key: string, signal = new AbortController().signal) {
	const running = { at: false };
	const result = track(host.render(job(key), signal, () => (running.at = true)));
	return { result, running };
}

// ------------------------------------------------------------------------------------------

describe('one job in the worker at a time', () => {
	/**
	 * TeX runs a job to completion inside one message task, so two jobs posted together do not run
	 * side by side: the second waits. Posting both at once is what let the queue run job B's clock
	 * all through job A, and what let A's timeout take B down with the worker.
	 */
	it('holds the second job until the first has replied', async () => {
		const host = new WorkerHost();
		const a = render(host, 'a');
		const b = render(host, 'b');
		worker(0).boot();

		expect(worker(0).renders).toHaveLength(1);
		expect(a.running.at).toBe(true);
		expect(b.running.at).toBe(false);

		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		expect(a.result.status).toBe('fulfilled');
		expect(worker(0).renders).toHaveLength(2);
		expect(b.running.at).toBe(true);
	});

	it('says a job is running only once the booted worker has it', () => {
		const host = new WorkerHost();
		const a = render(host, 'a');
		// The boot is the host's cost, not the diagram's: no clock may start while it runs.
		expect(a.running.at).toBe(false);
		expect(worker(0).renders).toHaveLength(0);

		worker(0).boot();
		expect(a.running.at).toBe(true);
		expect(worker(0).renders).toHaveLength(1);
	});
});

describe('kill()', () => {
	it('rejects a render still waiting for the boot at once, rather than never', async () => {
		const host = new WorkerHost();
		const a = render(host, 'a');

		host.kill('background');
		await tick();

		expect(a.result.status).toBe('rejected');
		expect(a.result.error).toBeInstanceOf(InterruptedError);
		expect(worker(0).terminated).toBe(true);
	});

	it('interrupts the running job and the waiting ones — it never blames them with a timeout', async () => {
		const host = new WorkerHost();
		const a = render(host, 'a');
		const b = render(host, 'b');
		worker(0).boot();

		host.kill('restart');
		await tick();

		for (const r of [a, b]) {
			expect(r.result.error).toBeInstanceOf(InterruptedError);
			expect(r.result.error).not.toBeInstanceOf(TexError);
			expect((r.result.error as Error).message).toBe('the engine was restarted');
		}
	});

	it('boots a fresh worker for the next render', async () => {
		const host = new WorkerHost();
		render(host, 'a');
		worker(0).boot();
		host.kill();
		await tick();

		const b = render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(2);
		worker(1).boot();
		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(b.result.status).toBe('fulfilled');
	});
});

describe('an abandoned job', () => {
	it('takes down only the worker it is running in; the next job runs on a fresh one', async () => {
		const host = new WorkerHost();
		const controller = new AbortController();
		const wedged = render(host, 'wedged', controller.signal);
		const next = render(host, 'next');
		worker(0).boot();

		controller.abort();
		await tick();

		expect(wedged.result.status).toBe('rejected');
		expect(worker(0).terminated).toBe(true);
		// Not collateral: it never ran in the wedged worker, so it is simply given another.
		expect(next.result.status).toBe('pending');
		expect(FakeWorker.spawned).toHaveLength(2);
		worker(1).boot();
		expect(next.running.at).toBe(true);
		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(next.result.status).toBe('fulfilled');
	});

	it('stops a boot that the only job waiting for it has given up on', async () => {
		const host = new WorkerHost();
		const controller = new AbortController();
		const a = render(host, 'a', controller.signal);

		controller.abort();
		await tick();

		expect(a.result.status).toBe('rejected');
		expect(worker(0).terminated).toBe(true);
		render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(2);
	});

	it('keeps the start going when the queue cancelled the only job waiting for it', async () => {
		// Its block went away, a note switched away from on a cold engine: that says nothing about
		// the start, and the next note's diagram takes the engine once it is up.
		const host = new WorkerHost();
		host.ready().catch(() => undefined);
		const controller = new AbortController();
		const a = render(host, 'a', controller.signal);

		controller.abort(new QueueError('cancelled', 'a'));
		await tick();
		expect((a.result.error as TexError).kind).toBe('aborted');
		expect(worker(0).terminated).toBe(false);

		const b = render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(1);
		worker(0).boot();
		expect(b.running.at).toBe(true);
	});

	it('stops a start the only job waiting for it gave up on as stalled', async () => {
		const host = new WorkerHost();
		host.ready().catch(() => undefined);
		const controller = new AbortController();
		render(host, 'a', controller.signal);

		controller.abort(new QueueError('stalled', 'a'));
		await tick();
		expect(worker(0).terminated).toBe(true);
		expect(host.report().lastStop).toBe('error');
	});

	it('ignores the reply that arrives after it was abandoned', async () => {
		const host = new WorkerHost();
		const controller = new AbortController();
		const a = render(host, 'a', controller.signal);
		worker(0).boot();
		const id = worker(0).renders[0] ?? -1;
		controller.abort();
		await tick();

		expect(() => worker(0).reply(id)).not.toThrow();
		await tick();
		expect(a.result.status).toBe('rejected');
	});
});

describe('the payload the engine starts from', () => {
	it('is the first thing a new worker is sent, once, before any job', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		render(host, 'a');
		render(host, 'b');
		for (const w of FakeWorker.spawned) {
			expect(w.posted).toEqual([
				{
					type: 'boot',
					assets: { wasm: 'd2FzbQ==', dump: 'ZHVtcA==', files: { 'pgf.sty': 'c3R5' } },
				},
			]);
		}
		worker(0).boot();
		await tick();
		expect(worker(0).posted.map((m) => m.type)).toEqual(['boot', 'render']);
	});

	it('fails the jobs waiting for a worker that could not start from it, rather than leaving them waiting', async () => {
		// A payload that does not inflate to what the build recorded: the worker throws, and that is
		// its error event (engine-src/worker.ts).
		const host = new WorkerHost();
		const a = render(host, 'a');
		const started = host.ready();
		started.catch(() => undefined);
		worker(0).crash('Error: inflated to 4096 B, expected 23379108 B');
		await tick();
		expect((a.result.error as TexError).kind).toBe('engine-unavailable');
		expect((a.result.error as TexError).message).toContain('inflated to 4096 B');
		await expect(started).rejects.toBeInstanceOf(TexError);
		expect(host.report().lives).toEqual([{ startMs: null, boot: null, snapshots: null, stop: 'error' }]);
	});
});

describe('a worker that crashes', () => {
	it('fails every render waiting on a boot that crashed, and does not respawn behind them', async () => {
		const host = new WorkerHost();
		const a = render(host, 'a');
		const b = render(host, 'b');

		worker(0).crash('out of memory');
		await tick();

		for (const r of [a, b]) {
			expect(r.result.error).toBeInstanceOf(TexError);
			expect((r.result.error as TexError).kind).toBe('engine-unavailable');
		}
		expect(FakeWorker.spawned).toHaveLength(1);
	});

	it('fails the running job, and gives the waiting one a fresh worker', async () => {
		const host = new WorkerHost();
		const a = render(host, 'a');
		const b = render(host, 'b');
		worker(0).boot();

		worker(0).crash('RuntimeError: unreachable');
		await tick();

		expect((a.result.error as TexError).kind).toBe('engine-unavailable');
		expect(b.result.status).toBe('pending');
		expect(FakeWorker.spawned).toHaveLength(2);
	});
});

describe('a platform with no WebAssembly', () => {
	/*
	 * As Lockdown Mode leaves some versions of iOS. The engine is WebAssembly, so no worker is started
	 * to fail on it, nor sent the payload, and the job fails with what the card explains
	 * (engine/hints.ts).
	 */
	it('starts no worker, and fails the job saying there is no WebAssembly', async () => {
		const real = globalThis.WebAssembly;
		(globalThis as { WebAssembly?: unknown }).WebAssembly = undefined;
		try {
			const host = new WorkerHost();
			const a = render(host, 'a');
			await tick();
			expect(FakeWorker.spawned).toHaveLength(0);
			expect((a.result.error as TexError).kind).toBe('engine-unavailable');
			expect((a.result.error as TexError).message).toBe(NO_WEBASSEMBLY);
			await expect(host.ready()).rejects.toThrow(NO_WEBASSEMBLY);
		} finally {
			globalThis.WebAssembly = real;
		}
	});
});

describe('idle teardown', () => {
	it('stops a worker with nothing to do, and boots again on demand', async () => {
		const timers = new FakeTimers();
		const host = new WorkerHost({ idleTeardownMs: 1000, timers });
		render(host, 'a');
		worker(0).boot();
		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();

		timers.advance(999);
		expect(worker(0).terminated).toBe(false);
		timers.advance(1);
		expect(worker(0).terminated).toBe(true);

		const b = render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(2);
		worker(1).boot();
		expect(b.running.at).toBe(true);
	});

	it('stops an engine started ahead of a job that never came', async () => {
		// The plugin starts the engine when a diagram misses the cache, before it is seen; one never
		// scrolled to leaves an engine nobody uses, which goes the way of any idle one.
		const timers = new FakeTimers();
		const host = new WorkerHost({ idleTeardownMs: 1000, timers });
		const ready = host.ready();
		worker(0).boot();
		await ready;

		timers.advance(1000);
		expect(worker(0).terminated).toBe(true);
		expect(host.report().lastStop).toBe('idle');
	});

	it('stops an engine started ahead of a job whose start never finishes', () => {
		// No job waits on it, so no startup allowance runs out to give up on it.
		const timers = new FakeTimers();
		const host = new WorkerHost({ idleTeardownMs: 1000, timers });
		host.ready().catch(() => undefined);

		timers.advance(999);
		expect(worker(0).terminated).toBe(false);
		timers.advance(1);
		expect(worker(0).terminated).toBe(true);
		expect(host.report().lives).toEqual([{ startMs: null, boot: null, snapshots: null, stop: 'idle' }]);
	});

	it('is called off by a job arriving for the engine still starting', () => {
		const timers = new FakeTimers();
		const host = new WorkerHost({ idleTeardownMs: 1000, timers });
		host.ready().catch(() => undefined);
		timers.advance(500);
		const a = render(host, 'a');
		timers.advance(5000);
		expect(worker(0).terminated).toBe(false);
		worker(0).boot();
		expect(a.running.at).toBe(true);
	});

	it('is called off by work arriving before it fires', async () => {
		const timers = new FakeTimers();
		const host = new WorkerHost({ idleTeardownMs: 1000, timers });
		render(host, 'a');
		worker(0).boot();
		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();

		timers.advance(500);
		render(host, 'b');
		timers.advance(5000);
		expect(worker(0).terminated).toBe(false);
		expect(worker(0).renders).toHaveLength(2);
	});
});

describe('dispose()', () => {
	it('interrupts what is in flight and refuses what comes after, without asking for a retry', async () => {
		const host = new WorkerHost();
		const a = render(host, 'a');
		worker(0).boot();

		host.dispose();
		await tick();
		expect(a.result.error).toBeInstanceOf(InterruptedError);

		// An interruption sends a block back to the queue; an unloaded plugin must not be asked
		// again and again, so what comes after is an ordinary failure.
		const late = render(host, 'late');
		await tick();
		expect(late.result.error).toBeInstanceOf(TexError);
		expect((late.result.error as TexError).kind).toBe('engine-unavailable');
		expect(FakeWorker.spawned).toHaveLength(1);
	});
});

describe('what the diagnostics view is told about the engine', () => {
	/**
	 * On a phone the engine stops after 30 s with nothing to do and whenever the app goes to the
	 * background, and the next diagram that is not cached pays for a new start. The view says how
	 * often that happened, how long each start took, and why each engine stopped.
	 */
	it('counts the starts, times each, and says why each one stopped', async () => {
		let now = 0;
		const timers = new FakeTimers();
		const host = new WorkerHost({ idleTeardownMs: 1000, timers, now: () => now });
		expect(host.report()).toEqual({ starts: 0, lives: [], lastStop: null, poolSize: 1 });

		render(host, 'a');
		now = 212;
		worker(0).boot();
		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		timers.advance(1000);

		const stop = new AbortController();
		render(host, 'b', stop.signal);
		now = 400;
		worker(1).boot();
		stop.abort();
		await tick();

		render(host, 'c');
		host.kill('background');
		await tick();

		render(host, 'd');
		worker(3).crash('out of memory');
		await tick();

		expect(host.report()).toEqual({
			starts: 4,
			lives: [
				{ startMs: 212, boot: null, snapshots: null, stop: 'idle' },
				{ startMs: 188, boot: null, snapshots: null, stop: 'timeout' },
				{ startMs: null, boot: null, snapshots: null, stop: 'background' },
				{ startMs: null, boot: null, snapshots: null, stop: 'error' },
			],
			lastStop: 'error',
			poolSize: 1,
		});
	});

	it('says an engine that is up is running, and a restart is a restart', async () => {
		const host = new WorkerHost({ now: () => 0 });
		void host.ready();
		worker(0).boot();
		await tick();
		expect(host.report().lives).toEqual([{ startMs: 0, boot: null, snapshots: null, stop: null }]);

		host.kill();
		expect(host.report()).toMatchObject({ lives: [{ stop: 'restart' }], lastStop: 'restart' });
		host.dispose();
		expect(host.report().lastStop).toBe('restart');
	});

	it('keeps where each start went inside the worker, as the worker said it', async () => {
		let now = 0;
		const host = new WorkerHost({ now: () => now });
		void host.ready();
		now = 86;
		const timings: BootTimings = {
			decodeMs: 3,
			inflateMs: 45,
			compileMs: 0,
			totalMs: 49,
			nativeInflate: true,
			nativeBase64: false,
		};
		worker(0).boot(timings);
		await tick();
		expect(host.report().lives).toEqual([{ startMs: 86, boot: timings, snapshots: null, stop: null }]);
	});

	it('tells the plugin each time an engine has started, with what the worker said of it', async () => {
		// The plugin tells someone on an iPhone without the JIT, once, why diagrams are slow
		// (main.ts, internal/DECISIONS.md D33): it hears of every start, the JIT probe with it.
		const started: (BootTimings | null)[] = [];
		const host = new WorkerHost({ poolSize: 2, onStarted: (boot) => started.push(boot) });
		const off: BootTimings = {
			decodeMs: 3,
			inflateMs: 45,
			compileMs: 0,
			totalMs: 61,
			nativeInflate: true,
			nativeBase64: true,
			jit: { on: false, fastestMs: 3, attempts: 4, spentMs: 12 },
		};
		void host.ready();
		worker(0).boot(off);
		await tick();
		expect(started).toEqual([off]);

		// A worker that says nothing of its start, and a listener that throws, change nothing else.
		host.kill();
		const throwing = new WorkerHost({
			onStarted: () => {
				throw new Error('the listener failed');
			},
		});
		const { result } = render(throwing, 'a');
		worker(1).boot();
		await tick();
		expect(worker(1).renders).toHaveLength(1);
		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(result.status).toBe('fulfilled');
		throwing.dispose();
	});

	it('keeps the last twenty, and counts them all', () => {
		const host = new WorkerHost();
		for (let i = 0; i < 25; i++) {
			// Each start is cut short, which is what `ready()` says, and nothing here asks.
			host.ready().catch(() => undefined);
			host.kill();
		}
		const report = host.report();
		expect(report.starts).toBe(25);
		expect(report.lives).toHaveLength(20);
	});
});

describe('the line TeX blamed', () => {
	/**
	 * TeX's `l.NN` counts the lines of the whole input, preamble files first, and the worker says
	 * on which of them the block starts. The host hands on the line of the BLOCK, numbered as
	 * pre-flight numbers it, so nothing past it has to know how the input was put together.
	 */
	it('is the line of the block, however long the preamble before it', async () => {
		const host = new WorkerHost();
		const failed = render(host, 'a');
		const recovered = render(host, 'b');
		worker(0).boot();

		// A three-line preamble puts the block's first line on line 4 of the input, so TeX's l.6 is
		// the block's line 3.
		worker(0).emit({
			type: 'error',
			id: worker(0).renders[0] ?? -1,
			kind: 'tex-error',
			message: 'Undefined control sequence.',
			firstError: 'Undefined control sequence.',
			line: 6,
			bodyLine: 4,
			log: [],
			missing: [],
			durationMs: 1,
		});
		await tick();
		worker(0).emit({
			type: 'ok',
			id: worker(0).renders[1] ?? -1,
			svg: '<svg/>',
			log: [],
			missing: [],
			durationMs: 1,
			firstError: 'Undefined control sequence.',
			line: 5,
			bodyLine: 4,
		});
		await tick();

		expect((failed.result.error as TexError).line).toBe(3);
		expect(recovered.result.value?.line).toBe(2);
	});

	it('is below 1 when TeX stopped in the preamble, counting up from the block', async () => {
		const host = new WorkerHost();
		const failed = render(host, 'a');
		worker(0).boot();

		// l.2 of an input whose block starts on line 4: two lines above the block's first.
		worker(0).emit({
			type: 'error',
			id: worker(0).renders[0] ?? -1,
			kind: 'tex-error',
			message: 'Undefined control sequence.',
			line: 2,
			bodyLine: 4,
			log: [],
			missing: [],
			durationMs: 1,
		});
		await tick();

		expect((failed.result.error as TexError).line).toBe(-1);
	});

	it('assumes the one-line preamble 0.1.4 did, should a worker not say', async () => {
		const host = new WorkerHost();
		const failed = render(host, 'a');
		worker(0).boot();

		worker(0).emit({
			type: 'error',
			id: worker(0).renders[0] ?? -1,
			kind: 'tex-error',
			message: 'Undefined control sequence.',
			line: 3,
			log: [],
			missing: [],
			durationMs: 1,
		});
		await tick();

		expect((failed.result.error as TexError).line).toBe(2);
	});
});

describe('where the time went', () => {
	/**
	 * The diagnostics view shows, for each diagram compiled, how long it waited and what each step
	 * took. The worker times its own steps; the host adds the one thing only it can see, how long
	 * the job waited for the engine to start.
	 */
	const TIMINGS = { resetMs: 5, texMs: 63, svgMs: 9, passes: 1 };

	function answer(w: FakeWorker, index: number): void {
		w.emit({
			type: 'ok',
			id: w.renders[index] ?? -1,
			svg: '<svg/>',
			log: [],
			missing: [],
			durationMs: 80,
			timings: TIMINGS,
		});
	}

	it("hands on the worker's own steps", async () => {
		const host = new WorkerHost();
		void host.ready();
		worker(0).boot();
		const a = render(host, 'a');
		answer(worker(0), 0);
		await tick();

		expect(a.result.value?.timings).toEqual(TIMINGS);
	});

	it('adds the start to the job that waited for the engine, and to no job after it', async () => {
		let now = 1000;
		const host = new WorkerHost({ now: () => now });
		const a = render(host, 'a');
		now = 1850;
		worker(0).boot();
		answer(worker(0), 0);
		await tick();

		now = 2000;
		const b = render(host, 'b');
		answer(worker(0), 1);
		await tick();

		expect(a.result.value?.timings).toEqual({ ...TIMINGS, startMs: 850 });
		expect(b.result.value?.timings).toEqual(TIMINGS);
	});

	it('counts only the part of the start a job was there for', async () => {
		let now = 1000;
		const host = new WorkerHost({ now: () => now });
		const a = render(host, 'a');
		now = 1400;
		const b = render(host, 'b');
		now = 1850;
		worker(0).boot();
		now = 1900;
		answer(worker(0), 0);
		await tick();
		answer(worker(0), 1);
		await tick();

		expect(a.result.value?.timings?.startMs).toBe(850);
		// Waiting behind `a` once the engine was up is not the engine starting.
		expect(b.result.value?.timings?.startMs).toBe(450);
	});

	it('says nothing of the steps a worker did not time', async () => {
		const host = new WorkerHost({ now: () => 0 });
		const a = render(host, 'a');
		worker(0).boot();
		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();

		expect(a.result.value?.timings).toBeUndefined();
	});
});

describe('a pool of workers', () => {
	it('starts a second worker only while a job waits that the first cannot take', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const a = render(host, 'a');
		expect(FakeWorker.spawned).toHaveLength(1);
		const b = render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(2);
		const c = render(host, 'c');
		// Never more than poolSize.
		expect(FakeWorker.spawned).toHaveLength(2);

		worker(1).boot();
		expect(worker(1).renders).toHaveLength(1);
		expect(a.running.at).toBe(true);
		worker(0).boot();
		expect(worker(0).renders).toHaveLength(1);
		expect(b.running.at).toBe(true);
		expect(c.running.at).toBe(false);

		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		expect(c.running.at).toBe(true);
		expect(worker(0).renders).toHaveLength(2);
	});

	it('does not start a second worker for a job the first can take as soon as it is up', () => {
		const host = new WorkerHost({ poolSize: 2 });
		// The plugin starts an engine when a diagram misses the cache, before its job arrives.
		host.ready().catch(() => undefined);
		render(host, 'a');
		expect(FakeWorker.spawned).toHaveLength(1);
	});

	it('takes down only the worker whose job timed out', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const stop = new AbortController();
		const a = render(host, 'a', stop.signal);
		const b = render(host, 'b');
		worker(0).boot();
		worker(1).boot();

		stop.abort();
		await tick();
		expect(a.result.status).toBe('rejected');
		expect(worker(0).terminated).toBe(true);
		expect(worker(1).terminated).toBe(false);

		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(b.result.status).toBe('fulfilled');
		expect(host.report().lives.map((life) => life.stop)).toEqual(['timeout', null]);
	});

	it('takes down only the worker that crashed, and the other carries on with its job', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const a = render(host, 'a');
		const b = render(host, 'b');
		worker(0).boot();
		worker(1).boot();

		worker(0).crash('RuntimeError: unreachable');
		await tick();
		expect((a.result.error as TexError).kind).toBe('engine-unavailable');
		expect(worker(1).terminated).toBe(false);
		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(b.result.status).toBe('fulfilled');
	});

	it('interrupts every worker on kill()', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const a = render(host, 'a');
		const b = render(host, 'b');
		const c = render(host, 'c');
		worker(0).boot();
		worker(1).boot();
		host.kill('background');
		await tick();
		for (const r of [a, b, c]) expect(r.result.error).toBeInstanceOf(InterruptedError);
		expect(worker(0).terminated && worker(1).terminated).toBe(true);
		expect(host.report().lives.map((life) => life.stop)).toEqual(['background', 'background']);
	});

	it('starts an engine on ready(), before any job, and only one', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const ready = host.ready();
		expect(FakeWorker.spawned).toHaveLength(1);
		host.ready().catch(() => undefined);
		expect(FakeWorker.spawned).toHaveLength(1);
		worker(0).boot();
		await ready;
		const a = render(host, 'a');
		expect(a.running.at).toBe(true);
		expect(FakeWorker.spawned).toHaveLength(1);
	});

	it('idles the workers down together, and not while one of them still has a job', async () => {
		const timers = new FakeTimers();
		const host = new WorkerHost({ poolSize: 2, idleTeardownMs: 1000, timers });
		render(host, 'a');
		render(host, 'b');
		worker(0).boot();
		worker(1).boot();

		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		timers.advance(5000);
		expect(worker(0).terminated).toBe(false);

		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		timers.advance(999);
		expect(worker(0).terminated || worker(1).terminated).toBe(false);
		timers.advance(1);
		expect(worker(0).terminated && worker(1).terminated).toBe(true);
		expect(host.report().lastStop).toBe('idle');
	});

	it('never runs more than one worker with a pool of one, as on a phone', async () => {
		const host = new WorkerHost({ poolSize: 1 });
		const jobs = ['a', 'b', 'c', 'd'].map((key) => render(host, key));
		host.ready().catch(() => undefined);
		worker(0).boot();
		for (let i = 0; i < jobs.length; i++) {
			expect(FakeWorker.spawned).toHaveLength(1);
			worker(0).reply(worker(0).renders[i] ?? -1);
			await tick();
		}
		for (const job of jobs) expect(job.result.status).toBe('fulfilled');
		expect(FakeWorker.spawned).toHaveLength(1);
	});

	it('lets the second worker go when the pool shrinks: at once if idle, after its job if busy', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		render(host, 'a');
		const b = render(host, 'b');
		worker(0).boot();
		worker(1).boot();

		// Both busy: neither is stopped under its job.
		host.setPoolSize(1);
		expect(worker(0).terminated || worker(1).terminated).toBe(false);

		// The first to finish goes; its job's result is delivered all the same.
		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(b.result.status).toBe('fulfilled');
		expect(worker(1).terminated).toBe(true);
		expect(worker(0).terminated).toBe(false);
		expect(host.report()).toMatchObject({ poolSize: 1, lastStop: 'settings' });

		// From now on one worker: a backlog starts no second.
		render(host, 'c');
		render(host, 'd');
		expect(FakeWorker.spawned).toHaveLength(2);
	});

	it('starts a second worker again for the next backlog once the pool grows', () => {
		const host = new WorkerHost({ poolSize: 1 });
		render(host, 'a');
		render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(1);
		host.setPoolSize(2);
		expect(FakeWorker.spawned).toHaveLength(2);
		expect(host.report().poolSize).toBe(2);
	});
});

describe('a pool whose second worker fails to start', () => {
	/**
	 * A computer short of memory that reports 8 GB or more, or no figure at all, gets two engines,
	 * and the second may fail to start, as an out-of-memory error at the worker's top level would
	 * make it. The pool then runs on the one that came up, until the workers next stop together.
	 */
	it('does not start it again behind the busy first worker, and runs the waiting job on that one', async () => {
		const sizes: number[] = [];
		const host = new WorkerHost({ poolSize: 2, onSize: (size) => sizes.push(size) });
		const a = render(host, 'a');
		worker(0).boot();
		const b = render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(2);

		worker(1).crash('RangeError: Array buffer allocation failed');
		await tick();
		// Not started again, however long the first worker stays busy.
		expect(FakeWorker.spawned).toHaveLength(2);
		expect(b.result.status).toBe('pending');
		// The queue is told to run one job at a time.
		expect(sizes).toEqual([1]);
		expect(host.report()).toMatchObject({ starts: 2, poolSize: 1 });

		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		expect(a.result.status).toBe('fulfilled');
		expect(b.running.at).toBe(true);
		expect(worker(0).renders).toHaveLength(2);
		render(host, 'c');
		render(host, 'd');
		expect(FakeWorker.spawned).toHaveLength(2);
	});

	it('hands the jobs to the other worker still starting, rather than failing them', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const a = render(host, 'a');
		const b = render(host, 'b');
		expect(FakeWorker.spawned).toHaveLength(2);

		worker(0).crash('RangeError: Array buffer allocation failed');
		await tick();
		expect(a.result.status).toBe('pending');
		expect(b.result.status).toBe('pending');
		expect(FakeWorker.spawned).toHaveLength(2);

		worker(1).boot();
		expect(a.running.at).toBe(true);
		worker(1).reply(worker(1).renders[0] ?? -1);
		await tick();
		expect(a.result.status).toBe('fulfilled');
		expect(b.running.at).toBe(true);
	});

	it('fails the waiting jobs when neither worker came up', async () => {
		const host = new WorkerHost({ poolSize: 2 });
		const a = render(host, 'a');
		const b = render(host, 'b');
		worker(0).crash('out of memory');
		worker(1).crash('out of memory');
		await tick();
		for (const r of [a, b]) expect((r.result.error as TexError).kind).toBe('engine-unavailable');
		expect(FakeWorker.spawned).toHaveLength(2);
	});

	it('is two again once the workers have stopped together', async () => {
		const sizes: number[] = [];
		const timers = new FakeTimers();
		const host = new WorkerHost({
			poolSize: 2,
			idleTeardownMs: 1000,
			timers,
			onSize: (size) => sizes.push(size),
		});
		render(host, 'a');
		worker(0).boot();
		render(host, 'b');
		worker(1).crash('out of memory');
		await tick();
		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		worker(0).reply(worker(0).renders[1] ?? -1);
		await tick();

		timers.advance(1000);
		expect(worker(0).terminated).toBe(true);
		expect(sizes).toEqual([1, 2]);
		render(host, 'c');
		render(host, 'd');
		expect(FakeWorker.spawned).toHaveLength(4);

		host.kill('restart');
		expect(host.report().poolSize).toBe(2);
	});
});

describe('saved preambles', () => {
	/**
	 * Each engine keeps the runs it saved at the end of a diagram's \begin{document}, and the host
	 * sends a diagram to the engine that holds its preamble's (internal/DECISIONS.md D32). A job's run
	 * is named as the worker names the runs it holds: here, by the package the preamble loads.
	 */
	const withPackage = (key: string, pkg: string) => ({
		key,
		source: '\\draw (0,0) -- (1,1);',
		options: { texPackages: { [pkg]: '' }, captureLog: true },
		timeoutMs: 1000,
	});
	const nameOf = (pkg: string) =>
		routeOf(
			buildInput('\\draw (0,0) -- (1,1);', { texPackages: { [pkg]: '' }, captureLog: true }).text,
			true,
		)!;
	const send = (host: WorkerHost, key: string, pkg: string) =>
		track(host.render(withPackage(key, pkg), new AbortController().signal));
	const holding = (w: FakeWorker, id: number, held: string[], failures = 0) =>
		w.emit({
			type: 'ok',
			id,
			svg: '<svg/>',
			log: [],
			missing: [],
			durationMs: 1,
			snapshots: { held, bytes: held.length * 1048576, failures },
		});
	const lastRender = (w: FakeWorker) => {
		const renders = w.posted.filter((m) => m.type === 'render');
		return renders[renders.length - 1];
	};

	it('are what the budget the host reads for each job says, and nothing without one', async () => {
		let budget = 32 * 1048576;
		const host = new WorkerHost({ snapshotBudget: () => budget });
		send(host, 'a', 'pgfplots');
		worker(0).boot();
		expect(lastRender(worker(0))).toMatchObject({ snapshots: 32 * 1048576 });
		worker(0).reply(worker(0).renders[0] ?? -1);
		await tick();
		budget = 0;
		send(host, 'b', 'pgfplots');
		expect(lastRender(worker(0))).toMatchObject({ snapshots: 0 });

		const plain = new WorkerHost();
		send(plain, 'c', 'pgfplots');
		worker(1).boot();
		expect(lastRender(worker(1))).toMatchObject({ snapshots: 0 });
	});

	it('send a job to the idle engine that holds its run, not to the first idle one', async () => {
		const host = new WorkerHost({ poolSize: 2, snapshotBudget: () => 32 * 1048576 });
		send(host, 'a', 'pgfplots');
		send(host, 'b', 'circuitikz');
		worker(0).boot();
		worker(1).boot();
		expect(worker(0).renders).toHaveLength(1);
		expect(worker(1).renders).toHaveLength(1);
		// The first engine saved pgfplots' preamble, the second circuitikz's.
		holding(worker(0), worker(0).renders[0]!, [nameOf('pgfplots')]);
		holding(worker(1), worker(1).renders[0]!, [nameOf('circuitikz')]);
		await tick();

		// Both idle: circuitikz's diagram goes to the second, though the first is idle too.
		send(host, 'c', 'circuitikz');
		expect(worker(1).renders).toHaveLength(2);
		expect(worker(0).renders).toHaveLength(1);
		send(host, 'd', 'pgfplots');
		expect(worker(0).renders).toHaveLength(2);
	});

	it('never keep a job waiting for a busy engine that holds its run while another is idle', async () => {
		const host = new WorkerHost({ poolSize: 2, snapshotBudget: () => 32 * 1048576 });
		send(host, 'a', 'pgfplots');
		send(host, 'b', 'circuitikz');
		worker(0).boot();
		worker(1).boot();
		holding(worker(1), worker(1).renders[0]!, [nameOf('circuitikz'), nameOf('pgfplots')]);
		await tick();
		// The second holds pgfplots' run but is busy again; the first is busy too, then idle.
		send(host, 'c', 'siunitx');
		expect(worker(1).renders).toHaveLength(2);
		holding(worker(0), worker(0).renders[0]!, []);
		await tick();
		send(host, 'd', 'pgfplots');
		expect(worker(0).renders).toHaveLength(2);
	});

	it('are said in the report: how many each engine holds, their bytes and its saves that failed', async () => {
		const host = new WorkerHost({ snapshotBudget: () => 32 * 1048576, now: () => 0 });
		send(host, 'a', 'pgfplots');
		worker(0).boot();
		holding(worker(0), worker(0).renders[0]!, [nameOf('pgfplots'), 'other'], 1);
		await tick();
		expect(host.report().lives).toEqual([
			{ startMs: 0, boot: null, snapshots: { runs: 2, bytes: 2 * 1048576, failures: 1 }, stop: null },
		]);
	});
});

describe('saved preambles kept across the engines’ stops', () => {
	/**
	 * Each run a worker saves is handed to the host and kept in IndexedDB (src/cache/runs.ts,
	 * internal/DECISIONS.md D36), and a job whose run no engine holds is sent with the run kept for it.
	 * The store is a fake here; test/runs.test.ts holds the real one.
	 */
	const source = '\\draw (0,0) -- (1,1);';
	const options = { texPackages: { pgfplots: '' }, captureLog: true };
	const route = routeOf(buildInput(source, options).text, true)!;
	const send = (host: WorkerHost, key: string) =>
		track(host.render({ key, source, options, timeoutMs: 1000 }, new AbortController().signal));
	const renders = (w: FakeWorker) =>
		w.posted.filter((m): m is Extract<WorkerRequest, { type: 'render' }> => m.type === 'render');
	const storedRun = (bytes = 64): StoredRun => ({
		route,
		data: new ArrayBuffer(bytes),
		compressed: true,
		rawBytes: bytes * 3,
	});

	class FakeRuns implements StoredRuns {
		readable = true;
		writable = true;
		epoch = 3;
		readonly stored = new Map<string, StoredRun>();
		readonly reads: string[] = [];
		readonly kept: SavedRunMessage[] = [];
		readonly forgotten: string[] = [];
		readonly measuredWith: [{ bytes: number; rawBytes: number }, number, number][] = [];
		loads = 0;
		/** Set to hold reads until released. */
		hold: Promise<void> | null = null;
		/** Reads of these names held until released, or for good. */
		readonly holdFor = new Map<string, Promise<void>>();
		/** Stored, but not worth sending: the read gives nothing. */
		worthless = false;
		load(): Promise<void> {
			this.loads++;
			return Promise.resolve();
		}
		has(name: string): boolean {
			return this.stored.has(name);
		}
		async read(name: string): Promise<StoredRun | undefined> {
			this.reads.push(name);
			if (this.hold !== null) await this.hold;
			const held = this.holdFor.get(name);
			if (held !== undefined) await held;
			const run = this.worthless ? undefined : this.stored.get(name);
			return run === undefined ? undefined : { ...run, data: run.data.slice(0) };
		}
		keep(message: SavedRunMessage): Promise<void> {
			this.kept.push(message);
			return Promise.resolve();
		}
		forget(name: string): Promise<void> {
			this.forgotten.push(name);
			return Promise.resolve();
		}
		measured(run: { bytes: number; rawBytes: number }, readMs: number, restoreMs: number): void {
			this.measuredWith.push([run, readMs, restoreMs]);
		}
	}

	const reply = (w: FakeWorker, id: number, extra: Partial<OkMessage> = {}) =>
		w.emit({ type: 'ok', id, svg: '<svg/>', log: [], missing: [], durationMs: 1, ...extra });

	it('send a job whose run no engine holds with the run kept for it, and ask for the runs saved', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun(100));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		expect(runs.reads).toEqual([route]);
		const posted = renders(worker(0))[0]!;
		expect(posted.persist).toBe(true);
		// Where the store stood, handed back with the run, so that a clear since is seen.
		expect(posted.epoch).toBe(3);
		expect(posted.stored?.route).toBe(route);
		expect(posted.stored?.data.byteLength).toBe(100);
		expect(posted.stored?.rawBytes).toBe(300);
	});

	it('hold a job while its run is read, and post it once the read is done', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		let release!: () => void;
		runs.hold = new Promise((resolve) => (release = resolve));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		expect(renders(worker(0))).toHaveLength(0);
		release();
		await tick();
		expect(renders(worker(0))[0]?.stored?.route).toBe(route);
	});

	it('send a job without a run when none is kept for it', async () => {
		const runs = new FakeRuns();
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		expect(renders(worker(0))[0]?.stored).toBeUndefined();
		expect(renders(worker(0))[0]?.persist).toBe(true);
	});

	it('read nothing for a job whose run an engine holds', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		reply(worker(0), renders(worker(0))[0]!.id, { snapshots: { held: [route], bytes: 1, failures: 0 } });
		await tick();
		send(host, 'b');
		await tick();
		expect(runs.reads).toEqual([route]);
		expect(renders(worker(0))[1]?.stored).toBeUndefined();
	});

	it('keep each run a worker hands over, from any worker still in the pool', async () => {
		const runs = new FakeRuns();
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		const id = renders(worker(0))[0]!.id;
		reply(worker(0), id);
		const message: SavedRunMessage = {
			type: 'saved-run',
			id,
			epoch: 3,
			run: storedRun(),
			preambleMs: 120,
			saveMs: 9,
			encodeMs: 30,
		};
		worker(0).emit(message);
		await tick();
		expect(runs.kept).toEqual([message]);
	});

	it('delete a run the worker could not read back', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		reply(worker(0), renders(worker(0))[0]!.id, { stored: 'corrupt' });
		await tick();
		expect(runs.forgotten).toEqual([route]);
	});

	it('learn what putting a run back took, and say what reading it took', async () => {
		let now = 0;
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun(1000));
		let release!: () => void;
		runs.hold = new Promise((resolve) => (release = resolve));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs, now: () => now });
		const result = send(host, 'a');
		worker(0).boot();
		now = 7;
		release();
		await tick();
		reply(worker(0), renders(worker(0))[0]!.id, {
			stored: 'used',
			timings: {
				resetMs: 1,
				texMs: 5,
				svgMs: 1,
				passes: 1,
				resumed: true,
				restored: true,
				restoreMs: 4,
			},
		});
		await tick();
		expect(runs.measuredWith).toEqual([[{ bytes: 1000, rawBytes: 3000 }, 7, 4]]);
		expect(result.value?.timings).toMatchObject({ restored: true, restoreMs: 4, fetchMs: 7 });
	});

	it('learn nothing of reading from a read made while the engine started', async () => {
		let now = 0;
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun(1000));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs, now: () => now });
		send(host, 'a');
		await tick();
		now = 50;
		worker(0).boot();
		await tick();
		const timings = {
			resetMs: 1,
			texMs: 5,
			svgMs: 1,
			passes: 1,
			resumed: true,
			restored: true,
			restoreMs: 4,
		};
		reply(worker(0), renders(worker(0))[0]!.id, { stored: 'used', timings });
		await tick();
		expect(runs.measuredWith).toEqual([[{ bytes: 1000, rawBytes: 3000 }, NaN, 4]]);
	});

	it('read, send and keep nothing while saved preambles are off', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		const host = new WorkerHost({ snapshotBudget: () => 0, runs });
		send(host, 'a');
		void host.ready().catch(() => undefined);
		worker(0).boot();
		await tick();
		expect(runs.loads).toBe(0);
		expect(runs.reads).toEqual([]);
		const posted = renders(worker(0))[0]!;
		expect(posted.stored).toBeUndefined();
		expect(posted.persist).toBe(false);
		worker(0).emit({
			type: 'saved-run',
			id: posted.id,
			epoch: 3,
			run: storedRun(),
			preambleMs: 1,
			saveMs: 1,
			encodeMs: 1,
		});
		await tick();
		expect(runs.kept).toEqual([]);
	});

	it('read nothing, and ask for no runs, where storage cannot be read', async () => {
		const runs = new FakeRuns();
		runs.readable = false;
		runs.writable = false;
		runs.stored.set(route, storedRun());
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		void host.ready().catch(() => undefined);
		send(host, 'a');
		worker(0).boot();
		await tick();
		expect(runs.loads).toBe(0);
		expect(runs.reads).toEqual([]);
		expect(renders(worker(0))[0]?.persist).toBe(false);
	});

	it('still read and send a stored run once storage has run out of room, and ask for no more', async () => {
		const runs = new FakeRuns();
		runs.writable = false;
		runs.stored.set(route, storedRun(100));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		void host.ready().catch(() => undefined);
		send(host, 'a');
		worker(0).boot();
		await tick();
		expect(runs.loads).toBe(1);
		expect(runs.reads).toEqual([route]);
		const posted = renders(worker(0))[0]!;
		expect(posted.stored?.data.byteLength).toBe(100);
		expect(posted.persist).toBe(false);
	});

	it('read what is stored while the engine starts', () => {
		const runs = new FakeRuns();
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		void host.ready();
		expect(runs.loads).toBe(1);
	});

	// A second preamble, and its run's name.
	const otherOptions = { texPackages: { siunitx: '' }, captureLog: true };
	const other = routeOf(buildInput(source, otherOptions).text, true)!;
	const sendOther = (host: WorkerHost, key: string) =>
		track(
			host.render(
				{ key, source, options: otherOptions, timeoutMs: 1000 },
				new AbortController().signal,
			),
		);
	const never = new Promise<void>(() => undefined);
	const posted = () => FakeWorker.spawned.flatMap((w) => renders(w));

	it('let a job whose run is still being read be passed by one that can go, on an idle engine', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		runs.stored.set(other, { ...storedRun(), route: other });
		runs.holdFor.set(route, never);
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs, poolSize: 2 });
		send(host, 'a');
		sendOther(host, 'b');
		worker(0).boot();
		worker(1).boot();
		await tick();
		expect(posted().map((r) => r.stored?.route)).toEqual([other]);
	});

	it('post a job without its run once it has waited 250 ms for the read with an engine idle', async () => {
		const timers = new FakeTimers();
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		let release!: () => void;
		runs.holdFor.set(route, new Promise((resolve) => (release = resolve)));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs, timers });
		send(host, 'a');
		await tick();
		// The engine's start does not count.
		timers.advance(5000);
		worker(0).boot();
		await tick();
		expect(posted()).toHaveLength(0);
		timers.advance(249);
		await tick();
		expect(posted()).toHaveLength(0);
		timers.advance(1);
		await tick();
		expect(posted()).toHaveLength(1);
		expect(posted()[0]?.stored).toBeUndefined();
		// Stored already: not written out again.
		expect(posted()[0]?.persist).toBe(false);

		// Storage that has not answered is not asked again until it has.
		reply(worker(0), posted()[0]!.id);
		send(host, 'b');
		await tick();
		expect(runs.reads).toEqual([route]);
		expect(posted()).toHaveLength(2);
		reply(worker(0), posted()[1]!.id);
		release();
		await tick();
		send(host, 'c');
		await tick();
		expect(runs.reads).toEqual([route, route]);
	});

	it("read a job's run when the engine holding it is busy and another can take the job", async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun(100));
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs, poolSize: 2 });
		send(host, 'a');
		worker(0).boot();
		await tick();
		reply(worker(0), renders(worker(0))[0]!.id, { snapshots: { held: [route], bytes: 1, failures: 0 } });
		await tick();
		// Engine 0 holds the run, and is busy with another preamble's diagram.
		sendOther(host, 'b');
		await tick();
		expect(renders(worker(0))).toHaveLength(2);
		let release!: () => void;
		runs.hold = new Promise((resolve) => (release = resolve));
		send(host, 'c');
		await tick();
		worker(1).boot();
		await tick();
		expect(runs.reads.filter((name) => name === route)).toEqual([route, route]);
		release();
		await tick();
		const sent = renders(worker(1))[0]!;
		expect(sent.stored?.data.byteLength).toBe(100);
		expect(sent.persist).toBe(true);
	});

	it('give a job whose run is being read to an engine that turns out to hold it', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs, poolSize: 2 });
		send(host, 'a');
		worker(0).boot();
		await tick();
		reply(worker(0), renders(worker(0))[0]!.id, { snapshots: { held: [route], bytes: 1, failures: 0 } });
		await tick();
		sendOther(host, 'b');
		await tick();
		runs.hold = never;
		send(host, 'c');
		await tick();
		// Engine 0 is done with the other diagram before the read: the job goes there, without the run.
		reply(worker(0), renders(worker(0))[1]!.id, {
			snapshots: { held: [route, other], bytes: 2, failures: 0 },
		});
		await tick();
		const sent = renders(worker(0))[2]!;
		expect(sent.stored).toBeUndefined();
		expect(sent.persist).toBe(false);
	});

	it('read nothing for a job whose run the only engine there can be holds, busy', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		reply(worker(0), renders(worker(0))[0]!.id, { snapshots: { held: [route], bytes: 1, failures: 0 } });
		await tick();
		sendOther(host, 'b');
		send(host, 'c');
		await tick();
		expect(runs.reads.filter((name) => name === route)).toEqual([route]);
	});

	it('ask for no run to be written out again when one is stored and none was sent', async () => {
		const runs = new FakeRuns();
		runs.stored.set(route, storedRun());
		runs.worthless = true;
		const host = new WorkerHost({ snapshotBudget: () => 12 * 1048576, runs });
		send(host, 'a');
		worker(0).boot();
		await tick();
		expect(renders(worker(0))[0]?.stored).toBeUndefined();
		expect(renders(worker(0))[0]?.persist).toBe(false);
	});
});

describe('the engine a job goes to', () => {
	const engine = (...held: string[]) => ({ held: new Set(held) });

	it('is the idle one that holds its run, else one no other waiting job wants, else the first', () => {
		const a = engine('x');
		const b = engine('y');
		const c = engine();
		expect(pickEngine('y', [a, b, c], [])).toBe(b);
		expect(pickEngine('z', [a, b, c], ['x', 'y'])).toBe(c);
		expect(pickEngine('z', [a, b], ['x'])).toBe(b);
		expect(pickEngine('z', [a, b], ['x', 'y'])).toBe(a);
		expect(pickEngine(undefined, [a, b], [undefined, 'x'])).toBe(b);
		expect(pickEngine('x', [], [])).toBeUndefined();
	});
});
