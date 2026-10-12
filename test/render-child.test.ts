// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { TikzBlock, type BlockDeps, type TexJobSpec } from '../src/block/render-child';
import { RenderQueue } from '../src/queue/queue';
import type { Artifact, BlockOptions, EngineCapabilities, TexHost, TexResult } from '../src/types';
import { InterruptedError, TexError } from '../src/types';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

// -------------------------------------------------------------------------------------------

const CAPS: EngineCapabilities = { expl3: true, twoPass: false, packages: {}, files: new Set() };

const host: TexHost = {
	id: 'test-engine',
	capabilities: CAPS,
	ready: () => Promise.resolve(),
	render: () => Promise.reject(new TexError('engine-unavailable', [])),
	dispose: () => undefined,
};

function options(over: Partial<BlockOptions> = {}): BlockOptions {
	return {
		baked: {
			border: null,
			packages: {},
			libraries: '',
			preamble: '',
			depHashes: [],
			wrap: 'auto',
			twoPass: false,
		},
		presentation: {},
		raw: false,
		nocache: false,
		fast: false,
		warnings: [],
		...over,
	};
}

function artifact(template: string): Artifact {
	return {
		v: 1,
		template,
		w: 100,
		h: 50,
		viewBox: '0 0 100 50',
		fonts: [],
		bytes: template.length,
		engineId: 'test-engine',
		origin: 'render',
		createdAt: 0,
		lastUsed: 0,
	};
}

const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="10" height="10"/></svg>';

/** A cache with only the tiers the child actually reaches, so a test never waits on IndexedDB. */
function fakeCache(hot?: Artifact) {
	const l1 = new Map<string, Artifact>();
	if (hot) l1.set('K', hot);
	return {
		peek: (key: string) => l1.get(key),
		peekSize: (key: string) => {
			const a = l1.get(key);
			return a ? { w: a.w, h: a.h } : undefined;
		},
		lookup: () => Promise.resolve(undefined),
		put: (key: string, a: Artifact) => void l1.set(key, a),
		stats: () => Promise.resolve({ entries: l1.size, bytes: 0 }),
		memoryStats: () => ({ entries: l1.size, bytes: 0 }),
		clear: () => Promise.resolve(),
		dropMemory: () => l1.clear(),
		dispose: () => undefined,
	} as unknown as BlockDeps['cache'];
}

function deps(over: Partial<BlockDeps> = {}): BlockDeps {
	return {
		cache: fakeCache(),
		queue: {
			submit: () => Promise.reject(new TexError('engine-unavailable', [])),
			release: () => undefined,
		} as unknown as BlockDeps['queue'],
		host,
		svgo: null,
		// Reports visible immediately, which is what a block in view does. A stub that never called
		// back would leave the child in GATING forever — correct, since the 2 s escape hatch lives
		// in ViewportGate, but it would make every test here a timeout rather than an assertion.
		observe: (_el, onChange) => onChange(true),
		unobserve: () => undefined,
		ensureFonts: () => undefined,
		debounceMs: 0,
		now: () => 0,
		...over,
	};
}

function spec(over: Partial<TexJobSpec> = {}): TexJobSpec {
	return {
		key: 'K',
		source: '\\draw (0,0) circle (1);',
		rawSource: '\\draw (0,0) circle (1);',
		options: options(),
		texOptions: {},
		legacySource: null,
		timeoutMs: 1000,
		isExport: false,
		preflight: [],
		...over,
	};
}

const container = (): HTMLElement => document.body.createDiv();

// -------------------------------------------------------------------------------------------

describe('a cached block', () => {
	/**
	 * The regression this exists for. `load` emits [addClasses, paintPlaceholder]; the child probes
	 * L1 from inside `addClasses`. When a hit dispatched inline, the diagram mounted and then the
	 * SAME batch carried on and painted a spinner underneath it, which nothing ever removed — so
	 * every reopened note with a cached diagram grew a permanent spinner below each one.
	 */
	it('mounts without leaving a placeholder behind', async () => {
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ cache: fakeCache(artifact(SVG)) }));

		child.onload();
		await child.settled;

		expect(el.querySelector('svg')).not.toBeNull();
		expect(el.querySelector('.tikzjax-placeholder')).toBeNull();
	});

	it('paints nothing at all between the probe and the mount', () => {
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ cache: fakeCache(artifact(SVG)) }));

		// Synchronous on purpose: an L1 hit must resolve inside onload, before the frame ends.
		// That is the whole point of a synchronous probe, and it is what removes the layout shift.
		child.onload();
		expect(el.querySelector('svg')).not.toBeNull();
		expect(el.querySelectorAll('.tikzjax-placeholder')).toHaveLength(0);
	});

	it('settles exactly once', async () => {
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ cache: fakeCache(artifact(SVG)) }));
		const settled = vi.fn();

		void child.settled.then(settled);
		child.onload();
		// Re-entering a terminal state must emit no second settle.
		child.onunload();
		await Promise.resolve();
		await Promise.resolve();

		expect(settled).toHaveBeenCalledTimes(1);
	});
});

describe('an empty block', () => {
	it('reports it instead of queueing a job that cannot work', async () => {
		const el = container();
		const submit = vi.fn(() => Promise.resolve({} as TexResult));
		const child = new TikzBlock(
			el,
			spec({ source: '   \n  ' }),
			deps({ queue: { submit, release: () => undefined } as unknown as BlockDeps['queue'] }),
		);

		child.onload();
		await child.settled;

		expect(submit).not.toHaveBeenCalled();
		expect(el.querySelector('.tikzjax-error')).not.toBeNull();
		expect(el.querySelector('.tikzjax-placeholder')).toBeNull();
	});

	it('does not claim that TeX ran', async () => {
		const el = container();
		const child = new TikzBlock(el, spec({ source: '' }), deps());

		child.onload();
		await child.settled;

		expect(el.querySelector('.tikzjax-error-message')?.textContent).toBe('This block is empty.');
	});
});

describe('the promise handed to Obsidian', () => {
	/**
	 * It must never reject. In reading mode `Promise.all(asyncSections)` has no `.catch`, so a
	 * rejection strands the section forever; in export it throws out of printToPdf.
	 */
	it('resolves even when the engine fails', async () => {
		const el = container();
		const child = new TikzBlock(
			el,
			spec(),
			deps({
				queue: {
					// Starts the job, as the real runner does, and THEN fails — the ordinary
					// "TeX did not like your diagram" path.
					submit: (
						_k: string,
						_job: TexJobSpec,
						_p: number,
						_t: number,
						opts?: { onStart?: () => void },
					) => {
						opts?.onStart?.();
						return Promise.reject(
							new TexError(
								'tex-error',
								['! Undefined control sequence.'],
								'Undefined control sequence.',
								4,
							),
						);
					},
					release: () => undefined,
				} as unknown as BlockDeps['queue'],
			}),
		);

		child.onload();
		await expect(child.settled).resolves.toBeUndefined();
		expect(el.querySelector('.tikzjax-error')).not.toBeNull();
	});
});

describe('a job that fails before it starts', () => {
	/**
	 * `err` is a COMPILING event, so a rejection arriving while the machine is still in SCHEDULING
	 * — the runner threw before calling onStart, or the queue failed for a reason of its own — used
	 * to be a no-op, and the block sat unsettled forever. That is the never-settling class this
	 * whole design exists to eliminate, arriving through the back door.
	 */
	it('still settles, and shows the failure', async () => {
		const el = container();
		const child = new TikzBlock(
			el,
			spec(),
			deps({
				queue: {
					submit: () => Promise.reject(new Error('the queue itself broke')),
					release: () => undefined,
				} as unknown as BlockDeps['queue'],
			}),
		);

		child.onload();
		await expect(child.settled).resolves.toBeUndefined();
		expect(el.querySelector('.tikzjax-placeholder')).toBeNull();
	});
});

// -------------------------------------------------------------------------------------------
// Against the real queue
//
// The stubs above settle `submit` in one step, which is exactly what hid the bugs below: the
// queue's dedup hands a second caller the FIRST caller's job, and only a real queue does that.

interface Run {
	job: TexJobSpec;
	signal: AbortSignal;
	resolve: (result: TexResult) => void;
	reject: (error: unknown) => void;
}

/** The real RenderQueue on real timers, with a runner the test settles by hand. */
function realQueue(startupMs?: number) {
	const runs: Run[] = [];
	const queue = new RenderQueue<TexJobSpec, TexResult>({
		concurrency: 1,
		depthCap: 64,
		run: (job, signal) =>
			new Promise<TexResult>((resolve, reject) => runs.push({ job, signal, resolve, reject })),
		timers: {
			setTimeout: (fn, ms) => window.setTimeout(fn, ms),
			clearTimeout: (id) => window.clearTimeout(id),
		},
		...(startupMs === undefined ? {} : { startupMs }),
	});
	return { queue, runs };
}

const RESULT: TexResult = { svg: SVG, log: [], durationMs: 1 };

function tracked(child: TikzBlock): { done: boolean } {
	const state = { done: false };
	void child.settled.then(() => (state.done = true));
	return state;
}

describe('two blocks showing the same diagram', () => {
	/**
	 * The same uncached diagram in two panes, twice in one note, or in a hover preview while it
	 * compiles: the queue runs ONE job for both. Only the block that submitted first used to hear
	 * that it had started, so the other stayed in SCHEDULING — a spinner forever and a promise
	 * that never settled, which hangs "Export to PDF" when the export joins a compile in flight.
	 */
	it('both mount when the second joins a compile already running', async () => {
		const { queue, runs } = realQueue();
		const a = container();
		const b = container();
		const first = new TikzBlock(a, spec(), deps({ queue }));
		const second = new TikzBlock(b, spec(), deps({ queue }));
		const firstDone = tracked(first);
		const secondDone = tracked(second);

		first.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		second.onload();
		// Long enough for the second block's debounce to fire and its submit to join.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runs).toHaveLength(1);

		runs[0]?.resolve(RESULT);
		await vi.waitFor(() => expect(secondDone.done).toBe(true));

		expect(firstDone.done).toBe(true);
		expect(a.querySelector('svg')).not.toBeNull();
		expect(b.querySelector('svg')).not.toBeNull();
		expect(b.querySelector('.tikzjax-placeholder')).toBeNull();
	});

	it('both mount when they queue together behind other work', async () => {
		const { queue, runs } = realQueue();
		// Something else holds the only slot, so both blocks wait in the same pending entry.
		const blocker = queue.submit('X', spec({ key: 'X' }), 1, 1000);
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		const a = container();
		const b = container();
		const first = new TikzBlock(a, spec(), deps({ queue }));
		const second = new TikzBlock(b, spec(), deps({ queue }));
		const secondDone = tracked(second);
		first.onload();
		second.onload();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(queue.size()).toBe(1);

		runs[0]?.resolve(RESULT);
		await blocker;
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		runs[1]?.resolve(RESULT);

		await vi.waitFor(() => expect(secondDone.done).toBe(true));
		expect(b.querySelector('svg')).not.toBeNull();
		await expect(first.settled).resolves.toBeUndefined();
		expect(a.querySelector('svg')).not.toBeNull();
	});

	it('an export that joins a compile in flight settles, so the PDF does not wait forever', async () => {
		const { queue, runs } = realQueue();
		const visible = new TikzBlock(container(), spec(), deps({ queue }));
		visible.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		const el = container();
		const exported = new TikzBlock(el, spec({ isExport: true, timeoutMs: 30_000 }), deps({ queue }));
		const exportDone = tracked(exported);
		exported.onload();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runs).toHaveLength(1);

		runs[0]?.resolve(RESULT);
		await vi.waitFor(() => expect(exportDone.done).toBe(true));
		expect(el.querySelector('svg')).not.toBeNull();
	});
});

describe('a compile the engine was stopped under', () => {
	/**
	 * Backgrounding iOS kills the worker, and so do "Restart the TeX engine" and a neighbour's
	 * timeout. The diagram did nothing wrong, and used to get a card saying it took too long.
	 */
	it('runs again and mounts, with no error card in between', async () => {
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ queue }));
		const done = tracked(child);
		child.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		runs[0]?.reject(new InterruptedError('the app was backgrounded'));
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		expect(el.querySelector('.tikzjax-error')).toBeNull();
		expect(el.querySelector('.tikzjax-placeholder')).not.toBeNull();
		expect(done.done).toBe(false);

		runs[1]?.resolve(RESULT);
		await vi.waitFor(() => expect(done.done).toBe(true));
		expect(el.querySelector('svg')).not.toBeNull();
		expect(el.querySelector('.tikzjax-error')).toBeNull();
	});

	it('says the engine did not start when it never came up — not that the diagram took too long', async () => {
		// A runner that never reports the job running: a boot that hangs.
		const { queue, runs } = realQueue(20);
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ queue }));
		child.onload();
		await child.settled;

		expect(runs).toHaveLength(1);
		expect(runs[0]?.signal.aborted).toBe(true);
		expect(el.querySelector('.tikzjax-error-message')?.textContent).toBe(
			'The TeX engine could not start.',
		);
		expect(queue.isPoisoned('K')).toBe(false);
	});

	it('brings both blocks of a shared compile back', async () => {
		const { queue, runs } = realQueue();
		const a = container();
		const b = container();
		const first = new TikzBlock(a, spec(), deps({ queue }));
		const second = new TikzBlock(b, spec(), deps({ queue }));
		const secondDone = tracked(second);
		first.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		second.onload();
		await new Promise((resolve) => setTimeout(resolve, 10));

		runs[0]?.reject(new InterruptedError('restarted from the command palette'));
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		// Re-submitted by both, compiled once.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runs).toHaveLength(2);

		runs[1]?.resolve(RESULT);
		await vi.waitFor(() => expect(secondDone.done).toBe(true));
		await expect(first.settled).resolves.toBeUndefined();
		expect(a.querySelector('svg')).not.toBeNull();
		expect(b.querySelector('svg')).not.toBeNull();
	});
});

/** Press the button with this label, as a reader would. */
function press(el: HTMLElement, label: string): void {
	const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label);
	if (!button) throw new Error(`no "${label}" button`);
	button.click();
}

const cardText = (el: HTMLElement): string | null | undefined =>
	el.querySelector('.tikzjax-error-message')?.textContent;

describe('Retry', () => {
	/**
	 * A timeout poisons the key for the session, and Retry is the documented way out. It emitted
	 * `unpoison`, which nothing carried out, so the queue refused the key again at the door: the
	 * job never re-ran, and the card it put back was the old one.
	 */
	it('runs a diagram that timed out again, and mounts it', async () => {
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec({ timeoutMs: 20 }), deps({ queue }));
		child.onload();
		await child.settled;
		expect(cardText(el)).toBe('The diagram took longer than its time budget.');
		expect(queue.isPoisoned('K')).toBe(true);

		press(el, 'Retry');
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		runs[1]?.resolve(RESULT);
		await vi.waitFor(() => expect(el.querySelector('svg')).not.toBeNull());
	});

	it('shows what went wrong this time, not last time', async () => {
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec({ timeoutMs: 20 }), deps({ queue }));
		child.onload();
		await child.settled;

		press(el, 'Retry');
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		runs[1]?.reject(
			new TexError('tex-error', ['! Undefined control sequence.'], 'Undefined control sequence.', 3),
		);
		await vi.waitFor(() => expect(cardText(el)).toMatch(/Undefined control sequence/));
	});
});

describe('the card for an undefined macro', () => {
	it('names the macro from the log, where TeX echoed it', async () => {
		// The worker sends the bare `!` line as the message; the macro survives only in the log.
		// The card used to be built without it and said TeX had not echoed the macro at all.
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ queue }));
		child.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		runs[0]?.reject(
			new TexError(
				'tex-error',
				['! Undefined control sequence.', 'l.5 \\draw (0,0) -- \\myTypo', '?'],
				'Undefined control sequence.',
				5,
				'Undefined control sequence.',
			),
		);
		await child.settled;
		expect(cardText(el)).toBe('Undefined control sequence \\myTypo');
	});
});

describe('the card for a diagram that timed out earlier', () => {
	it('says so, and points at the Retry that now works — not at "TeX ran successfully"', async () => {
		const { queue } = realQueue();
		const first = new TikzBlock(container(), spec({ timeoutMs: 20 }), deps({ queue }));
		first.onload();
		await first.settled;

		const el = container();
		const second = new TikzBlock(el, spec(), deps({ queue }));
		second.onload();
		await second.settled;

		expect(cardText(el)).toBe('This diagram timed out earlier in this session, so it was not run again.');
		expect(el.querySelector('.tikzjax-error-hint')?.textContent).toMatch(/Retry/);
	});
});
