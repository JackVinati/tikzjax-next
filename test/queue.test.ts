import { describe, expect, it } from 'vitest';
import { isQueueError, QueueError, RenderQueue, type Priority, type QueueTimers } from '../src/queue/queue';

// ------------------------------------------------------------------------------------------
// Harness
//
// No `vi.useFakeTimers()` anywhere: the queue takes its timers as a constructor argument, so the
// fake below is also the proof that it never reaches for an ambient one. Same for ordering — a
// wrong FIFO tiebreak would be invisible under a clock with millisecond resolution.

interface Scheduled {
	id: number;
	at: number;
	fn: () => void;
}

class FakeTimers implements QueueTimers {
	private now = 0;
	private nextId = 1;
	private readonly scheduled: Scheduled[] = [];

	setTimeout(fn: () => void, ms: number): number {
		const id = this.nextId++;
		this.scheduled.push({ id, at: this.now + ms, fn });
		return id;
	}

	clearTimeout(id: number): void {
		const index = this.scheduled.findIndex((t) => t.id === id);
		if (index >= 0) this.scheduled.splice(index, 1);
	}

	/** Fires everything due in the window, in (time, insertion) order, including re-entrant adds. */
	advance(ms: number): void {
		const target = this.now + ms;
		for (let guard = 0; guard < 10_000; guard++) {
			let next: Scheduled | undefined;
			for (const t of this.scheduled) {
				if (t.at > target) continue;
				if (next === undefined || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
			}
			if (next === undefined) {
				this.now = target;
				return;
			}
			this.scheduled.splice(this.scheduled.indexOf(next), 1);
			this.now = next.at;
			next.fn();
		}
		throw new Error('fake timers did not settle');
	}

	get outstanding(): number {
		return this.scheduled.length;
	}
}

/** Drain the microtask queue. Every settlement in the queue is microtask-driven. */
async function tick(rounds = 12): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Tracked<T> {
	status: 'pending' | 'fulfilled' | 'rejected';
	value: T | undefined;
	error: unknown;
}

/** Attaches handlers immediately, which is also what keeps a rejected submit from going unhandled. */
function track<T>(promise: Promise<T>): Tracked<T> {
	const state: Tracked<T> = { status: 'pending', value: undefined, error: undefined };
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

interface Job {
	id: string;
}

/** Hand-driven jobs: nothing settles until the test says so. */
class Runs {
	readonly started: string[] = [];
	readonly signals = new Map<string, AbortSignal>();
	private readonly deferreds = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
	/** Keys whose `run` should throw synchronously rather than return a promise. */
	readonly throwSync = new Set<string>();
	live = 0;
	maxLive = 0;

	readonly run = (job: Job, signal: AbortSignal): Promise<string> => {
		this.started.push(job.id);
		this.signals.set(job.id, signal);
		if (this.throwSync.has(job.id)) throw new Error(`sync boom: ${job.id}`);
		this.live += 1;
		this.maxLive = Math.max(this.maxLive, this.live);
		return new Promise<string>((resolve, reject) => {
			this.deferreds.set(job.id, { resolve, reject });
		});
	};

	finish(id: string, value = `${id}:ok`): void {
		const d = this.deferreds.get(id);
		if (d === undefined) throw new Error(`${id} was never started`);
		this.deferreds.delete(id);
		this.live -= 1;
		d.resolve(value);
	}

	fail(id: string, error: unknown = new Error(`boom: ${id}`)): void {
		const d = this.deferreds.get(id);
		if (d === undefined) throw new Error(`${id} was never started`);
		this.deferreds.delete(id);
		this.live -= 1;
		d.reject(error);
	}

	countOf(id: string): number {
		return this.started.filter((s) => s === id).length;
	}
}

function harness(opts: { concurrency: number; depthCap: number }) {
	const timers = new FakeTimers();
	const runs = new Runs();
	const queue = new RenderQueue<Job, string>({
		concurrency: opts.concurrency,
		depthCap: opts.depthCap,
		run: runs.run,
		timers,
	});
	const submit = (key: string, priority: Priority, timeoutMs = 1000): Tracked<string> =>
		track(queue.submit(key, { id: key }, priority, timeoutMs));
	return { timers, runs, queue, submit };
}

// ------------------------------------------------------------------------------------------

describe('priority and FIFO', () => {
	it('drains bands in order, most urgent first', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });

		const blocker = h.submit('blocker', 1);
		await tick();
		expect(h.runs.started).toEqual(['blocker']);

		// Submitted deliberately out of priority order.
		const p3 = h.submit('p3', 3);
		const p0 = h.submit('p0', 0);
		const p2 = h.submit('p2', 2);
		const p1 = h.submit('p1', 1);
		expect(h.queue.size()).toBe(4);

		for (const id of ['blocker', 'p0', 'p1', 'p2']) {
			h.runs.finish(id);
			await tick();
		}
		h.runs.finish('p3');
		await tick();

		expect(h.runs.started).toEqual(['blocker', 'p0', 'p1', 'p2', 'p3']);
		expect([blocker, p0, p1, p2, p3].map((t) => t.status)).toEqual(Array<string>(5).fill('fulfilled'));
		expect(h.queue.size()).toBe(0);
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('is stable FIFO inside a band', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('blocker', 0);
		await tick();

		// Interleaved so a sort that ignores submission order cannot pass by luck.
		h.submit('a', 2);
		h.submit('b', 1);
		h.submit('c', 2);
		h.submit('d', 1);

		for (const id of ['blocker', 'b', 'd', 'a']) {
			h.runs.finish(id);
			await tick();
		}
		expect(h.runs.started).toEqual(['blocker', 'b', 'd', 'a', 'c']);
	});

	it('promotes a deduped job to the most urgent caller without reordering its band', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('blocker', 0);
		await tick();

		h.submit('first', 1);
		h.submit('later', 3);
		// `later` scrolls into view while queued as a prefetch.
		h.submit('later', 0);

		h.runs.finish('blocker');
		await tick();
		expect(h.runs.started).toEqual(['blocker', 'later']);

		h.runs.finish('later');
		await tick();
		expect(h.runs.started).toEqual(['blocker', 'later', 'first']);
	});
});

describe('concurrency', () => {
	it('never exceeds its slot count', async () => {
		const h = harness({ concurrency: 2, depthCap: 64 });
		const tracked = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => h.submit(k, 1));

		await tick();
		expect(h.queue.inflightCount()).toBe(2);
		expect(h.runs.started).toEqual(['a', 'b']);
		expect(h.queue.size()).toBe(4);

		for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
			expect(h.queue.inflightCount()).toBeLessThanOrEqual(2);
			h.runs.finish(id);
			await tick();
		}

		expect(h.runs.maxLive).toBe(2);
		expect(h.runs.started).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
		expect(tracked.every((t) => t.status === 'fulfilled')).toBe(true);
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('still makes progress when handed a concurrency below one', async () => {
		// `min(2, hardwareConcurrency - 1)` is 0 on a single-core device, and a queue with zero slots
		// would never start anything and never settle anything — a silent, total stall.
		const h = harness({ concurrency: 0, depthCap: 64 });
		const a = h.submit('a', 1);
		await tick();
		expect(h.runs.started).toEqual(['a']);

		h.runs.finish('a');
		await tick();
		expect(a.status).toBe('fulfilled');
		expect(h.queue.inflightCount()).toBe(0);
	});
});

describe('dedup by key', () => {
	it('compiles once and resolves every caller', async () => {
		const h = harness({ concurrency: 2, depthCap: 64 });
		const first = h.queue.submit('same', { id: 'same' }, 2, 1000);
		const second = h.queue.submit('same', { id: 'same' }, 2, 1000);
		// One entry, therefore literally one promise — two panes cannot diverge.
		expect(second).toBe(first);

		const a = track(first);
		const b = track(second);
		await tick();
		expect(h.runs.countOf('same')).toBe(1);
		expect(h.queue.inflightCount()).toBe(1);

		h.runs.finish('same', 'svg');
		await tick();
		expect(a.value).toBe('svg');
		expect(b.value).toBe('svg');
	});

	it('joins a job that has already started rather than starting a second one', async () => {
		const h = harness({ concurrency: 2, depthCap: 64 });
		h.submit('k', 1);
		await tick();

		const late = h.submit('k', 1);
		await tick();
		expect(h.runs.countOf('k')).toBe(1);

		h.runs.finish('k', 'shared');
		await tick();
		expect(late.value).toBe('shared');
	});

	it('starts a fresh job once the previous one has settled', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('k', 1);
		await tick();
		h.runs.finish('k');
		await tick();

		h.submit('k', 1);
		await tick();
		expect(h.runs.countOf('k')).toBe(2);
	});
});

describe('release is per owner, not per key', () => {
	/**
	 * The failure this closes, from review: refcounting per KEY means a release arriving after the
	 * releasing caller's own job has already settled lands on a DIFFERENT caller's fresh job for
	 * the same key and cancels it. Two panes showing the same diagram plus one of them unloading
	 * late is enough to reproduce it, which makes it a real vault scenario rather than a contrived
	 * one.
	 */
	it('ignores a release from an owner this entry never had', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		const blockA = { name: 'A' };
		const blockC = { name: 'C' };

		// A and B both want K; it starts and settles, so the entry is gone.
		track(h.queue.submit('K', { id: 'K' }, 1, 1000, { owner: blockA }));
		track(h.queue.submit('K', { id: 'K' }, 1, 1000));
		await tick();
		h.runs.finish('K');
		await tick();

		// C submits K afresh, behind a blocker so it stays unstarted.
		h.submit('blocker', 1);
		await tick();
		const cJob = track(h.queue.submit('K', { id: 'K' }, 1, 1000, { owner: blockC }));
		expect(h.queue.size()).toBe(1);

		// A unloads only now. Its release must not touch C's job.
		h.queue.release('K', blockA);
		await tick();
		expect(h.queue.size()).toBe(1);
		expect(cJob.status).toBe('pending');

		// C's own release still works.
		h.queue.release('K', blockC);
		await tick();
		expect(h.queue.size()).toBe(0);
		expect(isQueueError(cJob.error, 'cancelled')).toBe(true);
	});

	it('still counts anonymous callers one for one', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('blocker', 1);
		await tick();

		const first = h.submit('K', 1);
		h.submit('K', 1);
		expect(h.queue.size()).toBe(1);

		h.queue.release('K');
		await tick();
		expect(first.status).toBe('pending');

		h.queue.release('K');
		await tick();
		expect(isQueueError(first.error, 'cancelled')).toBe(true);
	});
});

describe('release and refcounting', () => {
	it('drops an unstarted job at the last release', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('blocker', 1);
		await tick();

		const queued = h.submit('queued', 2);
		expect(h.queue.size()).toBe(1);

		h.queue.release('queued');
		await tick();
		expect(h.queue.size()).toBe(0);
		expect(isQueueError(queued.error, 'cancelled')).toBe(true);

		h.runs.finish('blocker');
		await tick();
		expect(h.runs.started).toEqual(['blocker']);
	});

	it('keeps an unstarted job while another caller still holds it', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('blocker', 1);
		await tick();

		const held = h.submit('shared', 2);
		h.submit('shared', 2);

		h.queue.release('shared');
		expect(h.queue.size()).toBe(1);
		expect(held.status).toBe('pending');

		h.queue.release('shared');
		await tick();
		expect(h.queue.size()).toBe(0);
		expect(isQueueError(held.error, 'cancelled')).toBe(true);
	});

	it('lets a started job finish and still resolves it — we already paid for it', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		const running = h.submit('running', 1);
		await tick();

		h.queue.release('running');
		await tick();
		expect(running.status).toBe('pending');
		expect(h.queue.inflightCount()).toBe(1);
		// Release is not cancellation: the signal stays live so the host keeps going.
		expect(h.runs.signals.get('running')?.aborted).toBe(false);

		// A caller arriving after the last release still joins the running compile.
		const rejoined = h.submit('running', 1);
		h.runs.finish('running', 'value');
		await tick();
		expect(running.value).toBe('value');
		expect(rejoined.value).toBe('value');
		expect(h.runs.countOf('running')).toBe(1);
	});

	it('ignores a release for an unknown or already-settled key', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		expect(() => h.queue.release('never-seen')).not.toThrow();

		const done = h.submit('done', 1);
		await tick();
		h.runs.finish('done');
		await tick();
		expect(done.status).toBe('fulfilled');

		expect(() => h.queue.release('done')).not.toThrow();
		expect(() => h.queue.release('done')).not.toThrow();
	});
});

describe('slot accounting', () => {
	it('frees the slot when a job rejects, and the failure stays local', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		const bad = h.submit('bad', 1);
		const good = h.submit('good', 1);
		await tick();

		const boom = new Error('tex exploded');
		h.runs.fail('bad', boom);
		await tick();

		expect(bad.status).toBe('rejected');
		expect(bad.error).toBe(boom);
		// The original error reaches the caller unwrapped: a TexError's kind must survive the queue.
		expect(isQueueError(bad.error)).toBe(false);
		expect(h.runs.started).toEqual(['bad', 'good']);

		h.runs.finish('good');
		await tick();
		expect(good.status).toBe('fulfilled');
		expect(h.queue.inflightCount()).toBe(0);
		expect(h.timers.outstanding).toBe(0);
	});

	it('frees the slot when run throws synchronously', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.runs.throwSync.add('sync-bad');

		const bad = h.submit('sync-bad', 1);
		const good = h.submit('good', 1);
		await tick();

		expect(bad.status).toBe('rejected');
		expect((bad.error as Error).message).toBe('sync boom: sync-bad');
		expect(h.runs.started).toContain('good');

		h.runs.finish('good');
		await tick();
		expect(good.status).toBe('fulfilled');
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('settles the caller even when the timer seam itself throws', async () => {
		// The one invariant this module is built around is "every job settles". `start`'s try/finally
		// frees the slot, but the settle happens inside the try — so a throw from the injected timer
		// (the only line in there that calls out to code the queue does not own) used to free the slot
		// and leave the caller's promise pending for the life of the session, exactly the wedge class
		// of upstream #18/#23/#27/#39/#51/#82/#85/#89, plus an unhandled rejection off `void start()`.
		const boom = new Error('timer subsystem down');
		const timers: QueueTimers = {
			setTimeout() {
				throw boom;
			},
			clearTimeout() {
				/* never reached */
			},
		};
		const queue = new RenderQueue<Job, string>({
			concurrency: 1,
			depthCap: 8,
			timers,
			run: () => Promise.resolve('ok'),
		});

		const first = track(queue.submit('a', { id: 'a' }, 1, 1000));
		await tick();
		expect(first.status).toBe('rejected');
		expect(first.error).toBe(boom);
		// And the queue is still usable rather than one slot poorer.
		expect(queue.inflightCount()).toBe(0);
		expect(queue.size()).toBe(0);

		const second = track(queue.submit('b', { id: 'b' }, 1, 1000));
		await tick();
		expect(second.status).toBe('rejected');
		expect(queue.inflightCount()).toBe(0);
	});

	it('clears the timeout timer on a normal settle', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('k', 1, 5000);
		await tick();
		expect(h.timers.outstanding).toBe(1);

		h.runs.finish('k');
		await tick();
		expect(h.timers.outstanding).toBe(0);
	});
});

describe('timeout and poison', () => {
	it('rejects only the wedged job, frees its slot, and poisons its key', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		const wedged = h.submit('wedged', 1, 100);
		const next = h.submit('next', 1, 100);
		await tick();
		expect(h.runs.started).toEqual(['wedged']);

		h.timers.advance(100);
		await tick();

		expect(isQueueError(wedged.error, 'timeout')).toBe(true);
		expect(h.runs.signals.get('wedged')?.aborted).toBe(true);
		expect(h.queue.isPoisoned('wedged')).toBe(true);

		// The slot came back even though `run` for `wedged` has still not settled. This is the whole
		// point: upstream #18/#23/#27/#39/#51/#82/#85/#89 is one wedged render holding a slot forever.
		expect(h.runs.started).toEqual(['wedged', 'next']);
		expect(h.queue.inflightCount()).toBe(1);

		h.runs.finish('next');
		await tick();
		expect(next.status).toBe('fulfilled');
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('ignores a late settlement from a timed-out job', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		const wedged = h.submit('wedged', 1, 100);
		await tick();
		h.timers.advance(100);
		await tick();
		expect(wedged.status).toBe('rejected');

		// The worker eventually answers, long after we gave up. Nothing may re-settle or throw.
		h.runs.finish('wedged', 'too late');
		await tick();
		expect(wedged.status).toBe('rejected');
		expect(wedged.value).toBeUndefined();
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('refuses a poisoned key without calling run, until the poison is cleared', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('wedged', 1, 100);
		await tick();
		h.timers.advance(100);
		await tick();

		const refused = h.submit('wedged', 1, 100);
		await tick();
		expect(isQueueError(refused.error, 'poisoned')).toBe(true);
		expect(h.runs.countOf('wedged')).toBe(1);
		expect(h.queue.size()).toBe(0);
		expect(h.queue.inflightCount()).toBe(0);

		h.queue.clearPoison('wedged');
		expect(h.queue.isPoisoned('wedged')).toBe(false);
		h.submit('wedged', 1, 100);
		await tick();
		expect(h.runs.countOf('wedged')).toBe(2);
	});

	it('clearPoison() with no key clears the whole set', async () => {
		const h = harness({ concurrency: 2, depthCap: 64 });
		h.submit('a', 1, 100);
		h.submit('b', 1, 100);
		await tick();
		h.timers.advance(100);
		await tick();
		expect(h.queue.isPoisoned('a')).toBe(true);
		expect(h.queue.isPoisoned('b')).toBe(true);

		h.queue.clearPoison();
		expect(h.queue.isPoisoned('a')).toBe(false);
		expect(h.queue.isPoisoned('b')).toBe(false);
	});

	it('raises the deadline of a job that has ALREADY started, without extending it twice', async () => {
		// Export dedups onto whatever is already compiling. Before this, the export inherited the
		// visible block's 10 s, was cut at 10 s, and — the part that really hurts — poisoned the key,
		// so the diagram was refused for the rest of the session over a budget it never received.
		const h = harness({ concurrency: 1, depthCap: 64 });
		const visible = h.submit('k', 1, 100);
		await tick();
		expect(h.runs.started).toEqual(['k']);

		const exported = track(h.queue.submit('k', { id: 'k' }, 0, 1000));
		await tick();

		// The old deadline passes and nothing happens.
		h.timers.advance(100);
		await tick();
		expect(visible.status).toBe('pending');
		expect(exported.status).toBe('pending');
		expect(h.queue.isPoisoned('k')).toBe(false);

		// The new deadline is 1000ms from the START, not 100 + 1000: the re-arm waits only the
		// difference, which is what keeps this exact without the queue holding a clock.
		h.timers.advance(899);
		await tick();
		expect(exported.status).toBe('pending');

		h.timers.advance(1);
		await tick();
		expect(isQueueError(exported.error, 'timeout')).toBe(true);
		expect(isQueueError(visible.error, 'timeout')).toBe(true);
		expect((exported.error as QueueError).message).toContain('1000ms');
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('never lowers the deadline of a running job', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		const generous = h.submit('k', 1, 1000);
		await tick();
		// A visible block joining an export's compile must not cut it down to its own 10 s.
		track(h.queue.submit('k', { id: 'k' }, 1, 100));
		await tick();

		h.timers.advance(999);
		await tick();
		expect(generous.status).toBe('pending');

		h.runs.finish('k', 'in time');
		await tick();
		expect(generous.value).toBe('in time');
		expect(h.queue.isPoisoned('k')).toBe(false);
	});

	it('lets an export through the poison door, and only an export', async () => {
		// machine.ts `miss()` puts export ahead of poison and emits no `unpoison` — so if the queue
		// refuses at the door, that block stays in SCHEDULING (the driver has no event for a submit
		// rejected before it got a slot) and `Promise.all(ctx.promises)` hangs "Preparing PDF".
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('k', 1, 100);
		await tick();
		h.timers.advance(100);
		await tick();
		expect(h.queue.isPoisoned('k')).toBe(true);

		// An ordinary block is still refused without ever reaching `run`.
		const ordinary = h.submit('k', 1, 100);
		await tick();
		expect(isQueueError(ordinary.error, 'poisoned')).toBe(true);
		expect(h.runs.countOf('k')).toBe(1);

		const exported = track(h.queue.submit('k', { id: 'k' }, 0, 30_000, { ignorePoison: true }));
		await tick();
		expect(h.runs.countOf('k')).toBe(2);
		// The override is per submit: the key stays poisoned for everyone else.
		expect(h.queue.isPoisoned('k')).toBe(true);

		h.runs.finish('k', 'rendered for the pdf');
		await tick();
		expect(exported.value).toBe('rendered for the pdf');
	});

	it('re-poisons a key whose export attempt wedges again', async () => {
		const h = harness({ concurrency: 1, depthCap: 64 });
		h.submit('k', 1, 100);
		await tick();
		h.timers.advance(100);
		await tick();
		h.queue.clearPoison('k');

		const exported = track(h.queue.submit('k', { id: 'k' }, 0, 300, { ignorePoison: true }));
		await tick();
		h.timers.advance(300);
		await tick();
		expect(isQueueError(exported.error, 'timeout')).toBe(true);
		// Bounded by the per-block export budget, then back behind the poison set for everyone.
		expect(h.queue.isPoisoned('k')).toBe(true);
		expect(h.queue.inflightCount()).toBe(0);
	});

	it('times out per job, not per queue', async () => {
		const h = harness({ concurrency: 2, depthCap: 64 });
		const short = h.submit('short', 1, 100);
		const long = h.submit('long', 1, 500);
		await tick();

		h.timers.advance(100);
		await tick();
		expect(isQueueError(short.error, 'timeout')).toBe(true);
		expect(long.status).toBe('pending');

		h.runs.finish('long');
		await tick();
		expect(long.status).toBe('fulfilled');
		expect(h.queue.isPoisoned('long')).toBe(false);
	});
});

describe('depth cap', () => {
	it('rejects the least urgent overflow with a distinguishable reason', async () => {
		const h = harness({ concurrency: 1, depthCap: 2 });
		h.submit('blocker', 1);
		await tick();
		// A started job is not queue depth.
		expect(h.queue.size()).toBe(0);

		const a = h.submit('a', 1);
		const b = h.submit('b', 1);
		expect(h.queue.size()).toBe(2);

		// Lowest priority band goes first, even though it is not the oldest.
		const prefetch = h.submit('prefetch', 3);
		await tick();
		expect(isQueueError(prefetch.error, 'depth-cap')).toBe(true);
		expect(h.queue.size()).toBe(2);

		// Inside one band it is the most recently added that loses: `b`, not `a`.
		const urgent = h.submit('urgent', 0);
		await tick();
		expect(isQueueError(b.error, 'depth-cap')).toBe(true);
		expect(a.status).toBe('pending');
		expect(urgent.status).toBe('pending');
		expect(h.queue.size()).toBe(2);

		h.runs.finish('blocker');
		await tick();
		expect(h.runs.started).toEqual(['blocker', 'urgent']);
		expect(h.runs.countOf('prefetch')).toBe(0);
		expect(h.runs.countOf('b')).toBe(0);
	});

	it('lets an evicted key be submitted again', async () => {
		const h = harness({ concurrency: 1, depthCap: 1 });
		h.submit('blocker', 1);
		await tick();
		h.submit('keep', 1);
		const evicted = h.submit('evicted', 3);
		await tick();
		expect(isQueueError(evicted.error, 'depth-cap')).toBe(true);
		// Eviction is not poison: pressing "Render diagram" must work.
		expect(h.queue.isPoisoned('evicted')).toBe(false);

		h.runs.finish('blocker');
		await tick();
		h.runs.finish('keep');
		await tick();

		const retried = h.submit('evicted', 0);
		await tick();
		expect(h.runs.countOf('evicted')).toBe(1);
		expect(retried.status).toBe('pending');
		h.runs.finish('evicted');
		await tick();
		expect(retried.status).toBe('fulfilled');
	});

	it('does not evict a job that a free slot can take immediately', async () => {
		const h = harness({ concurrency: 2, depthCap: 1 });
		const a = h.submit('a', 1);
		const b = h.submit('b', 1);
		await tick();
		expect(h.runs.started).toEqual(['a', 'b']);
		expect(a.status).toBe('pending');
		expect(b.status).toBe('pending');
	});
});

describe('QueueError', () => {
	it('is an Error with a matchable kind', () => {
		const error = new QueueError('timeout', 'k');
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('QueueError');
		expect(error.key).toBe('k');
		expect(isQueueError(error, 'timeout')).toBe(true);
		expect(isQueueError(error, 'depth-cap')).toBe(false);
		expect(isQueueError(new Error('nope'))).toBe(false);
	});
});

// ------------------------------------------------------------------------------------------
// Property-style: whatever the interleaving, every slot comes back.

/** Seeded PRNG — `Math.random()` would make a failure unreproducible, which is worse than no test. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface RandomJob {
	id: string;
	mode: 'ok' | 'throw' | 'hang';
	duration: number;
}

describe('under randomised throw / timeout / release interleavings', () => {
	it('always returns to zero in flight with every promise settled', async () => {
		for (let seed = 1; seed <= 25; seed++) {
			const rnd = mulberry32(seed);
			const pick = <X>(xs: readonly X[]): X => {
				const x = xs[Math.floor(rnd() * xs.length)];
				if (x === undefined) throw new Error('empty pick');
				return x;
			};

			const timers = new FakeTimers();
			const concurrency = 1 + Math.floor(rnd() * 3);
			const depthCap = 1 + Math.floor(rnd() * 4);
			const timeoutMs = 50;
			let runCount = 0;

			const queue = new RenderQueue<RandomJob, string>({
				concurrency,
				depthCap,
				timers,
				// Jobs settle off the same fake clock, so timeout-versus-completion races are decided
				// deterministically rather than by whichever microtask happens to win.
				run: (job) =>
					new Promise<string>((resolve, reject) => {
						runCount += 1;
						if (job.mode === 'hang') return;
						timers.setTimeout(() => {
							if (job.mode === 'ok') resolve(job.id);
							else reject(new Error(`boom: ${job.id}`));
						}, job.duration);
					}),
			});

			const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
			const tracked: Tracked<string>[] = [];

			for (let step = 0; step < 80; step++) {
				const roll = rnd();
				if (roll < 0.6) {
					const key = pick(keys);
					const job: RandomJob = {
						id: key,
						mode: pick(['ok', 'ok', 'throw', 'hang'] as const),
						// Straddles timeoutMs on purpose: some finish, some are cut off.
						duration: Math.floor(rnd() * 90),
					};
					tracked.push(track(queue.submit(key, job, pick([0, 1, 2, 3] as const), timeoutMs)));
				} else if (roll < 0.8) {
					queue.release(pick(keys));
				} else if (roll < 0.9) {
					queue.clearPoison(rnd() < 0.5 ? pick(keys) : undefined);
				} else {
					timers.advance(Math.floor(rnd() * 40));
				}
				await tick(4);

				expect(queue.inflightCount()).toBeLessThanOrEqual(concurrency);
				expect(queue.inflightCount()).toBeGreaterThanOrEqual(0);
				expect(queue.size()).toBeLessThanOrEqual(depthCap);
			}

			// Let everything that can still settle do so. Hung jobs settle by timing out.
			for (let i = 0; i < 60 && (queue.size() > 0 || queue.inflightCount() > 0); i++) {
				timers.advance(100);
				await tick(6);
			}

			const context = `seed ${seed} (concurrency ${concurrency}, depthCap ${depthCap})`;
			expect(runCount, context).toBeGreaterThan(0);
			expect(queue.inflightCount(), context).toBe(0);
			expect(queue.size(), context).toBe(0);
			expect(tracked.filter((t) => t.status === 'pending').length, `${context}: promises left hanging`).toBe(0);
		}
	});
});
