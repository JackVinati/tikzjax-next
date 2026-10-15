import { beforeAll, describe, expect, it } from 'vitest';
import type {
	ErrorMessage,
	FlushedMessage,
	OkMessage,
	RenderRequest,
	SavedRunMessage,
	WorkerRequest,
	WorkerResponse,
} from '../engine-src/protocol';
import { GZIP_HELPER } from '../engine-src/gzip-helper';
import { buildWorker } from '../scripts/engine-assets.mjs';

/*
 * The runs a worker saves are handed to the host to keep in storage across the engine's stops
 * (internal/DECISIONS.md D36). On the maintainer's iPhone the heaviest diagrams of a note never
 * reached storage: the worker handed a run over only once it had had nothing to do for 100 ms, which
 * in a note is only at its end, and the engine was stopped when Obsidian went to the background,
 * with what was waiting. So a run is now written out between diagrams from the reply on and gzipped
 * on a thread of its own, and the host asks the worker to finish before it stops it; and a diagram
 * that resumes from a run put back from storage says so, also when an earlier diagram put it back.
 *
 * Asked of the worker that ships, built by the build's own function and run in this realm with
 * `self` shimmed, as scripts/verify-snapshot.mjs runs it, two of them, on the committed engine.
 */

const inbox: WorkerResponse[] = [];
let handler: ((event: { data: WorkerRequest }) => void) | null = null;
/** Set to refuse every run handed over, as a post that cannot clone or allocate it does. */
let refuseRuns = false;
let first: (request: WorkerRequest) => void;
let second: (request: WorkerRequest) => void;

const SNAPSHOTS = 12 * 1024 * 1024;
const SIUNITX = { texPackages: { siunitx: '' }, captureLog: true };
const PGFPLOTS = { texPackages: { pgfplots: '' }, captureLog: true };
const PLAIN = { captureLog: true };
const DIAGRAM = (n: number) => `\\begin{tikzpicture}\\draw (0,0) -- (${n},1);\\end{tikzpicture}`;

async function waitFor<T>(find: () => T | undefined, ms = 60_000): Promise<T> {
	for (let waited = 0; waited < ms; waited += 5) {
		const found = find();
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('nothing came');
}

async function start(assets: unknown, source: string): Promise<(request: WorkerRequest) => void> {
	new Function(source)();
	const own = handler!;
	const ready = inbox.filter((m) => m.type === 'ready').length;
	own({ data: { type: 'boot', assets } as WorkerRequest });
	await waitFor(() => (inbox.filter((m) => m.type === 'ready').length > ready ? true : undefined));
	return (request) => own({ data: request });
}

let id = 0;
function render(
	worker: (request: WorkerRequest) => void,
	tex: string,
	options: RenderRequest['options'],
	extra: Partial<RenderRequest> = {},
): Promise<OkMessage | ErrorMessage> {
	const request: RenderRequest = {
		type: 'render',
		id: ++id,
		source: tex,
		options,
		snapshots: SNAPSHOTS,
		...extra,
	};
	worker(request);
	return waitFor(() =>
		inbox.find(
			(m): m is OkMessage | ErrorMessage =>
				(m.type === 'ok' || m.type === 'error') && m.id === request.id,
		),
	);
}

const handed = (reply: { id: number }) =>
	inbox.find((m): m is SavedRunMessage => m.type === 'saved-run' && m.id === reply.id);

beforeAll(async () => {
	const { source, assets } = await buildWorker('.');
	(globalThis as { self?: unknown }).self = {
		postMessage: (message: WorkerResponse) => {
			if (refuseRuns && message.type === 'saved-run')
				throw new DOMException('refused', 'DataCloneError');
			inbox.push(message);
		},
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		set onmessage(fn: typeof handler) {
			handler = fn;
		},
		get onmessage() {
			return handler;
		},
	};
	first = await start(assets, source);
	second = await start(assets, source);
}, 120_000);

describe('the runs a worker hands over', () => {
	it('are handed over from the reply on, while the next diagram is under way, and all before it says flushed', async () => {
		const a = await render(first, DIAGRAM(1), SIUNITX, { persist: true, epoch: 4 });
		expect(a.timings?.saveMs).toBeDefined();
		// Said with the diagram: its run is sent to be stored (internal/DECISIONS.md D39).
		expect(a.timings?.forStore).toBe(true);
		// The reply says the run is still to be handed over, for the host to wait for it before a stop.
		expect(a.snapshots?.pending).toBe(1);
		// The next diagram, of another preamble, posted at once, as the queue posts the next job.
		const b = render(first, DIAGRAM(2), PGFPLOTS, { persist: true, epoch: 4 });
		const bReply = await b;
		expect(bReply.type).toBe('ok');
		expect(bReply.snapshots?.pending).toBeGreaterThanOrEqual(1);
		// Both are handed over, and then the worker says so, also when asked.
		const asked = inbox.length;
		first({ type: 'flush' });
		const flushed = await waitFor(() => inbox.slice(asked).find((m) => m.type === 'flushed'));
		const flushedAt = inbox.indexOf(flushed);
		for (const reply of [a, bReply]) {
			const message = handed(reply);
			expect(message, `the run of render ${reply.id}`).toBeDefined();
			expect(inbox.indexOf(message!)).toBeLessThan(flushedAt);
			expect(message?.epoch).toBe(4);
		}
		// Unasked, too, once the last had been handed over: the host then stops it at once.
		const last = inbox.indexOf(handed(bReply)!);
		expect(inbox.slice(last).some((m) => m.type === 'flushed')).toBe(true);
		// Counted, for the engine's line in the diagnostics.
		expect((flushed as FlushedMessage).handedOver).toEqual({ sent: 2, dropped: 0, failed: 0 });
		// And a diagram after them, whose run is not handed over, says none is waiting, and that none is.
		const c = await render(first, DIAGRAM(3), SIUNITX, { persist: false });
		expect(c.snapshots?.pending).toBe(0);
		expect(c.snapshots?.handedOver).toEqual({ sent: 2, dropped: 0, failed: 0 });
		expect(c.timings?.forStore).toBeUndefined();
	}, 120_000);

	it('says flushed at once when it has nothing to hand over', async () => {
		const before = inbox.filter((m) => m.type === 'flushed').length;
		second({ type: 'flush' });
		await waitFor(
			() => (inbox.filter((m) => m.type === 'flushed').length > before ? true : undefined),
			5000,
		);
	});
});

describe('a diagram that resumes from a stored run', () => {
	it('says the run came from storage, both when it is put back for it and when an earlier one put it back', async () => {
		const saved = await render(first, DIAGRAM(3), PLAIN, { persist: true, epoch: 0 });
		const message = await waitFor(() => handed(saved));
		// To the second worker, which holds none, as after the engine's stop.
		const restored = await render(second, DIAGRAM(4), PLAIN, { stored: message.run });
		expect(restored.timings).toMatchObject({ resumed: true, restored: true, fromStore: true });
		const after = await render(second, DIAGRAM(5), PLAIN);
		expect(after.timings).toMatchObject({ resumed: true, fromStore: true });
		expect(after.timings?.restored).toBeUndefined();
		// The first worker's own, saved there, is a saved preamble.
		const own = await render(first, DIAGRAM(6), PLAIN);
		expect(own.timings?.resumed).toBe(true);
		expect(own.timings?.fromStore).toBeUndefined();
	}, 120_000);
});

/*
 * A run that does not fit beside the ones the worker is using, as circuitikz's 8.9 MiB may not at a
 * phone's 12, is let go at once (D32). Where the host asks for it, it is handed over all the same, for
 * later sessions to start from; and where the worker is too full to save one at all, it is saved for
 * that alone, once (internal/DECISIONS.md D39). Here at a budget of 1 MiB, which holds plain TikZ's
 * run and nothing beside it.
 */
describe('a run the worker cannot keep', () => {
	const SMALL = 1024 * 1024;

	it('is handed over where the host asks for it, and let go', async () => {
		const worker = await another();
		const reply = await render(worker, DIAGRAM(30), SIUNITX, {
			snapshots: SMALL,
			persist: true,
			epoch: 9,
		});
		expect(reply.timings).toMatchObject({ saveNotKept: true });
		expect(reply.snapshots?.held).toHaveLength(0);
		expect(reply.snapshots?.pending).toBe(1);
		const message = await waitFor(() => handed(reply));
		expect(message.epoch).toBe(9);
		// What it handed over starts a diagram of that preamble in a worker that holds none.
		const back = await render(await another(), DIAGRAM(31), SIUNITX, { stored: message.run });
		expect(back.timings).toMatchObject({ resumed: true, restored: true });
	}, 120_000);

	it('is saved for the host where the worker is too full to save it for itself, once a name', async () => {
		const worker = await another();
		const plain = await render(worker, DIAGRAM(32), PLAIN, { snapshots: SMALL, persist: true });
		expect(plain.snapshots?.held).toHaveLength(1);
		// Resumed from, so that it may not go to make room: what is left is less than any run saved yet.
		const resumed = await render(worker, DIAGRAM(33), PLAIN, { snapshots: SMALL });
		expect(resumed.timings?.resumed).toBe(true);

		// Not asked for: nothing is saved, as before.
		const unasked = await render(worker, DIAGRAM(34), SIUNITX, { snapshots: SMALL });
		expect(unasked.timings?.saveMs).toBeUndefined();

		// Asked for, while none is stored under its name: saved, not kept, and handed over.
		const asked = await render(worker, DIAGRAM(35), SIUNITX, { snapshots: SMALL, persist: true });
		expect(asked.timings).toMatchObject({ saveNotKept: true });
		expect(asked.snapshots?.held).toEqual(plain.snapshots?.held);
		const message = await waitFor(() => handed(asked));
		const back = await render(await another(), DIAGRAM(36), SIUNITX, { stored: message.run });
		expect(back.timings).toMatchObject({ resumed: true, restored: true });

		// Asked for again, as when the store did not keep it: not saved again in this worker's life.
		const again = await render(worker, DIAGRAM(37), SIUNITX, { snapshots: SMALL, persist: true });
		expect(again.timings?.saveMs).toBeUndefined();
		expect(handed(again)).toBeUndefined();
		// And the run it keeps is still resumed from.
		const still = await render(worker, DIAGRAM(38), PLAIN, { snapshots: SMALL });
		expect(still.timings?.resumed).toBe(true);
	}, 120_000);

	/** A worker at 1 MiB that holds plain TikZ's run and has resumed from it: too full to save another. */
	async function full(): Promise<(request: WorkerRequest) => void> {
		const worker = await another();
		const plain = await render(worker, DIAGRAM(40), PLAIN, { snapshots: SMALL, persist: true });
		await waitFor(() => handed(plain));
		const resumed = await render(worker, DIAGRAM(41), PLAIN, { snapshots: SMALL });
		expect(resumed.timings?.resumed).toBe(true);
		return worker;
	}

	/** Every message after the `at`-th, once a `flushed` has come among them. */
	const flushedAfter = (at: number) =>
		waitFor(() => (inbox.slice(at).some((m) => m.type === 'flushed') ? true : undefined));

	it('is not saved again for the host after its hand-over failed', async () => {
		// What fails a hand-over is memory: saving the run again at every diagram of its preamble would
		// allocate it once more each time, under the pressure that failed it.
		const worker = await full();
		refuseRuns = true;
		try {
			const at = inbox.length;
			const asked = await render(worker, DIAGRAM(42), SIUNITX, { snapshots: SMALL, persist: true });
			expect(asked.timings).toMatchObject({ saveNotKept: true });
			await flushedAfter(at);
			expect(handed(asked)).toBeUndefined();
			// Counted, for the engine's line in the diagnostics.
			const flushed = inbox.slice(at).find((m): m is FlushedMessage => m.type === 'flushed');
			expect(flushed?.handedOver?.failed).toBe(1);
		} finally {
			refuseRuns = false;
		}
		const again = await render(worker, DIAGRAM(43), SIUNITX, { snapshots: SMALL, persist: true });
		expect(again.timings?.saveMs).toBeUndefined();
	}, 120_000);

	it('is saved again once the store was cleared, or saved preambles were off', async () => {
		const worker = await full();
		const first = await render(worker, DIAGRAM(44), SIUNITX, {
			snapshots: SMALL,
			persist: true,
			epoch: 1,
		});
		expect(first.timings).toMatchObject({ saveNotKept: true });
		await waitFor(() => handed(first));
		const same = await render(worker, DIAGRAM(45), SIUNITX, {
			snapshots: SMALL,
			persist: true,
			epoch: 1,
		});
		expect(same.timings?.saveMs).toBeUndefined();
		// Cleared: the store's epoch moved, and it holds none.
		const cleared = await render(worker, DIAGRAM(46), SIUNITX, {
			snapshots: SMALL,
			persist: true,
			epoch: 2,
		});
		expect(cleared.timings).toMatchObject({ saveNotKept: true });
		await waitFor(() => handed(cleared));
		// Off, and on again, which deletes what was stored.
		await render(worker, DIAGRAM(47), PLAIN, { snapshots: 0 });
		const on = await render(worker, DIAGRAM(48), SIUNITX, { snapshots: SMALL, persist: true, epoch: 2 });
		expect(on.timings?.saveMs).toBeDefined();
	}, 120_000);

	it('is not saved for the host where the stored run sent could not be put back for want of memory', async () => {
		const worker = await full();
		// More than any array can hold: the inflate cannot allocate it, a RangeError, as on a phone short
		// of memory, and the run stays stored.
		const stored = { route: 'unused', data: new ArrayBuffer(16), compressed: true, rawBytes: 2 ** 40 };
		const failed = await render(worker, DIAGRAM(49), SIUNITX, {
			snapshots: SMALL,
			persist: true,
			stored,
		});
		expect(failed.stored).toBe('failed');
		expect(failed.timings?.saveMs).toBeUndefined();
		// Without one, it is saved for the host as before.
		const asked = await render(worker, DIAGRAM(50), SIUNITX, { snapshots: SMALL, persist: true });
		expect(asked.timings).toMatchObject({ saveNotKept: true });
	}, 120_000);

	it('is saved again for the host once its hand-over was dropped for room', async () => {
		// Its messages to itself held, the worker's first hand-over never finishes, and the runs it
		// cannot keep wait behind it: two of them pass its budget, and the older is dropped.
		const held: (() => void)[] = [];
		class HeldChannel {
			readonly port1: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
			readonly port2 = {
				postMessage: (data: unknown) => void held.push(() => this.port1.onmessage?.({ data })),
			};
		}
		const worker = await withGlobals({ MessageChannel: HeldChannel }, another);
		await render(worker, DIAGRAM(51), PLAIN, { snapshots: SMALL, persist: true });
		await render(worker, DIAGRAM(52), PLAIN, { snapshots: SMALL });
		const siunitx = await render(worker, DIAGRAM(53), SIUNITX, { snapshots: SMALL, persist: true });
		expect(siunitx.timings).toMatchObject({ saveNotKept: true });
		const pgfplots = await render(worker, DIAGRAM(54), PGFPLOTS, { snapshots: SMALL, persist: true });
		expect(pgfplots.timings).toMatchObject({ saveNotKept: true });
		// pgfplots' waits: not saved again; siunitx's was dropped, and counted: saved again.
		const waiting = await render(worker, DIAGRAM(55), PGFPLOTS, { snapshots: SMALL, persist: true });
		expect(waiting.timings?.saveMs).toBeUndefined();
		expect(waiting.snapshots?.handedOver).toEqual({ sent: 0, dropped: 1, failed: 0 });
		const again = await render(worker, DIAGRAM(56), SIUNITX, { snapshots: SMALL, persist: true });
		expect(again.timings).toMatchObject({ saveNotKept: true });
		expect(held.length).toBeGreaterThan(0);
	}, 120_000);
});

/**
 * A worker as the engine's worker starts one, run in this realm on the helper's own source, its
 * messages a task apart; `fail` makes it fail to start, as where a worker cannot start one of its own,
 * and `silent` start and never say it is up.
 */
class HelperWorker {
	static started = 0;
	static runs = 0;
	static terminated = 0;
	static fail = false;
	static silent = false;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	private readonly inner: {
		onmessage: ((event: { data: unknown }) => void) | null;
		postMessage: (m: unknown) => void;
	};

	constructor(_url: string) {
		HelperWorker.started++;
		this.inner = {
			onmessage: null,
			postMessage: (message: unknown) => setTimeout(() => this.onmessage?.({ data: message })),
		};
		if (HelperWorker.fail) {
			setTimeout(() => this.onerror?.({ message: 'refused' }));
			return;
		}
		if (HelperWorker.silent) return;
		new Function('self', GZIP_HELPER)(this.inner);
	}

	postMessage(message: unknown): void {
		HelperWorker.runs++;
		setTimeout(() => this.inner.onmessage?.({ data: message }));
	}

	terminate(): void {
		HelperWorker.terminated++;
		this.inner.onmessage = null;
	}
}

/**
 * A MessageChannel whose messages wait until `release`, as the engine's worker's messages to itself
 * waited in WebKit: in a note of heavy diagrams they came only after the next render, which the host
 * posts the moment a reply reaches it (internal/DECISIONS.md D38).
 */
class LateChannel {
	static readonly held: (() => void)[] = [];
	static release(): void {
		for (const deliver of LateChannel.held.splice(0)) deliver();
	}
	readonly port1: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
	readonly port2 = {
		postMessage: (data: unknown) => {
			LateChannel.held.push(() => this.port1.onmessage?.({ data }));
		},
	};
}

type Globals = { Worker?: unknown; MessageChannel?: unknown };

/**
 * Run `body` with these in place of the platform's. The worker looks `Worker` up when it starts its
 * helper, and keeps the MessageChannel it found when it was started.
 */
async function withGlobals<T>(globals: Globals, body: () => Promise<T>): Promise<T> {
	const real: Globals = {
		Worker: (globalThis as Globals).Worker,
		MessageChannel: (globalThis as Globals).MessageChannel,
	};
	Object.assign(globalThis, globals);
	try {
		return await body();
	} finally {
		Object.assign(globalThis, real);
	}
}

/** Another worker of the shipped source, started now. */
async function another(): Promise<(request: WorkerRequest) => void> {
	const { source, assets } = await buildWorker('.');
	return start(assets, source);
}

/** What a gzip inflates to. */
async function gunzip(bytes: ArrayBuffer): Promise<number> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return (await new Response(stream).arrayBuffer()).byteLength;
}

describe('the gzip of a run handed over', () => {
	it('is done by a worker of its own where one can be started, and the run is the same', async () => {
		const real = (globalThis as { Worker?: unknown }).Worker;
		(globalThis as { Worker?: unknown }).Worker = HelperWorker;
		let third: (request: WorkerRequest) => void;
		try {
			const { source, assets } = await buildWorker('.');
			third = await start(assets, source);
			const reply = await render(third, DIAGRAM(7), SIUNITX, { persist: true, epoch: 1 });
			const message = await waitFor(() => handed(reply));
			expect(HelperWorker.started).toBe(1);
			expect(HelperWorker.runs).toBe(1);
			expect(message.run.compressed).toBe(true);
			expect(await gunzip(message.run.data)).toBe(message.run.rawBytes);
			// And sent back to another worker, it is put back and started from.
			const back = await render(second, DIAGRAM(8), SIUNITX, { stored: message.run });
			expect(back.timings).toMatchObject({ restored: true, fromStore: true });
		} finally {
			(globalThis as { Worker?: unknown }).Worker = real;
		}
	}, 120_000);

	it('is done on the engine’s own thread where the worker of its own fails to start', async () => {
		const real = (globalThis as { Worker?: unknown }).Worker;
		(globalThis as { Worker?: unknown }).Worker = HelperWorker;
		HelperWorker.fail = true;
		HelperWorker.started = 0;
		try {
			// The second worker has handed nothing over yet: its helper is started now, and fails.
			const reply = await render(second, DIAGRAM(9), PGFPLOTS, { persist: true, epoch: 2 });
			const message = await waitFor(() => handed(reply));
			expect(HelperWorker.started).toBe(1);
			expect(message.run.compressed).toBe(true);
			expect(await gunzip(message.run.data)).toBe(message.run.rawBytes);
		} finally {
			HelperWorker.fail = false;
			(globalThis as { Worker?: unknown }).Worker = real;
		}
	}, 120_000);

	/*
	 * In WebKit a first build of 0.2.1-beta.5 handed most runs of a note of heavy diagrams over a
	 * diagram or more late, many only after the last one: each waited for a message the worker sent
	 * itself, which came after the next render, and for the helper to say it was up, which it had been
	 * asked only at the first run. Node's messages do not come late, so they are held here.
	 */
	it('goes to the worker of its own in the task its reply is posted in, though the worker’s messages to itself come late', async () => {
		await withGlobals({ Worker: HelperWorker }, async () => {
			const late = await withGlobals({ MessageChannel: LateChannel }, another);
			HelperWorker.started = 0;
			HelperWorker.runs = 0;
			try {
				const a = await render(late, DIAGRAM(10), SIUNITX, { persist: true, epoch: 6 });
				// Started with the render, the helper had its run before anything else could happen.
				expect(HelperWorker.started).toBe(1);
				expect(HelperWorker.runs).toBe(1);
				const b = await render(late, DIAGRAM(11), PGFPLOTS, { persist: true, epoch: 6 });
				// Both are handed over, the worker's messages to itself still held: nothing waits for one.
				for (const reply of [a, b]) {
					const message = await waitFor(() => handed(reply), 20_000);
					expect(message.run.compressed).toBe(true);
					expect(await gunzip(message.run.data)).toBe(message.run.rawBytes);
				}
				expect(HelperWorker.runs).toBe(2);
				expect(LateChannel.held).toHaveLength(0);
			} finally {
				LateChannel.release();
			}
		});
	}, 120_000);

	it('is done on the engine’s own thread where the worker of its own never says it is up, which is stopped', async () => {
		await withGlobals({ Worker: HelperWorker }, async () => {
			const silent = await another();
			HelperWorker.silent = true;
			HelperWorker.started = 0;
			HelperWorker.terminated = 0;
			try {
				const reply = await render(silent, DIAGRAM(12), SIUNITX, { persist: true, epoch: 7 });
				const message = await waitFor(() => handed(reply), 10_000);
				expect(HelperWorker.started).toBe(1);
				expect(HelperWorker.terminated).toBe(1);
				expect(message.run.compressed).toBe(true);
				expect(await gunzip(message.run.data)).toBe(message.run.rawBytes);
			} finally {
				HelperWorker.silent = false;
			}
		});
	}, 120_000);
});
