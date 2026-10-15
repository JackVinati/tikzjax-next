import { beforeAll, describe, expect, it } from 'vitest';
import type {
	ErrorMessage,
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
 * on a thread of its own, and the host asks the worker to finish before it stops it.
 *
 * Asked of the worker that ships, built by the build's own function and run in this realm with
 * `self` shimmed, as scripts/verify-snapshot.mjs runs it, two of them, on the committed engine.
 */

const inbox: WorkerResponse[] = [];
let handler: ((event: { data: WorkerRequest }) => void) | null = null;
let first: (request: WorkerRequest) => void;
let second: (request: WorkerRequest) => void;

const SNAPSHOTS = 12 * 1024 * 1024;
const SIUNITX = { texPackages: { siunitx: '' }, captureLog: true };
const PGFPLOTS = { texPackages: { pgfplots: '' }, captureLog: true };
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
		postMessage: (message: WorkerResponse) => inbox.push(message),
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
		// The next diagram, of another preamble, posted at once, as the queue posts the next job.
		const b = render(first, DIAGRAM(2), PGFPLOTS, { persist: true, epoch: 4 });
		const bReply = await b;
		expect(bReply.type).toBe('ok');
		// Both are handed over, and then the worker says so when asked.
		first({ type: 'flush' });
		await waitFor(() => (inbox.some((m) => m.type === 'flushed') ? true : undefined));
		const flushedAt = inbox.findIndex((m) => m.type === 'flushed');
		for (const reply of [a, bReply]) {
			const message = handed(reply);
			expect(message, `the run of render ${reply.id}`).toBeDefined();
			expect(inbox.indexOf(message!)).toBeLessThan(flushedAt);
			expect(message?.epoch).toBe(4);
		}
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

/**
 * A worker as the engine's worker starts one, run in this realm on the helper's own source, its
 * messages a task apart; `fail` makes it fail to start, as where a worker cannot start one of its own.
 */
class HelperWorker {
	static started = 0;
	static runs = 0;
	static fail = false;
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
		new Function('self', GZIP_HELPER)(this.inner);
	}

	postMessage(message: unknown): void {
		HelperWorker.runs++;
		setTimeout(() => this.inner.onmessage?.({ data: message }));
	}

	terminate(): void {
		this.inner.onmessage = null;
	}
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
			expect(back.timings).toMatchObject({ restored: true });
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
});
