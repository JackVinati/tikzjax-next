import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineInventory, WorkerRequest, WorkerResponse } from '../engine-src/protocol';

// The real module is the 9 MB worker string, produced by the build; nothing here reads it.
vi.mock('virtual:engine', () => ({ WORKER_SOURCE: '', ENGINE_ID: 'test-engine', ENGINE_INVENTORY: null }));

import { WorkerHost } from '../src/engine/worker-host';
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
		return this.posted.map((m) => m.id);
	}

	boot(): void {
		this.emit({ type: 'ready', engineId: 'test-engine', inventory: INVENTORY });
	}

	reply(id: number, svg = '<svg/>'): void {
		this.emit({ type: 'ok', id, svg, log: [], missing: [], durationMs: 1 });
	}

	crash(message: string): void {
		this.onerror?.({ message } as ErrorEvent);
	}

	private emit(message: WorkerResponse): void {
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

		host.kill('the app was backgrounded');
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

		host.kill('restarted from the command palette');
		await tick();

		for (const r of [a, b]) {
			expect(r.result.error).toBeInstanceOf(InterruptedError);
			expect(r.result.error).not.toBeInstanceOf(TexError);
			expect((r.result.error as Error).message).toBe('restarted from the command palette');
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
