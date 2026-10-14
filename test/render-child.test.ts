// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { TikzBlock, type BlockDeps, type BlockOutcome, type TexJobSpec } from '../src/block/render-child';
import { RenderQueue } from '../src/queue/queue';
import type { Artifact, BlockOptions, EngineCapabilities, TexHost, TexResult } from '../src/types';
import { InterruptedError, TexError } from '../src/types';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

// One optional stage that throws, switched on per test: the only way to reach a pipeline that
// degrades without being handed output so broken that it cannot be parsed at all. And one that
// runs `during`, for a test that has to pass time inside the pipeline.
const pipeline = vi.hoisted(() => ({ breakAStage: false, during: null as (() => void) | null }));
vi.mock('../src/svg/stages', async (importOriginal) => {
	const real = await importOriginal<typeof import('../src/svg/stages')>();
	return {
		...real,
		buildStages: (options: Parameters<typeof real.buildStages>[0]) => {
			const stages = real.buildStages(options);
			const during = pipeline.during;
			if (during) return [...stages, { name: 'during', run: () => during() }];
			if (!pipeline.breakAStage) return stages;
			return [
				...stages,
				{
					name: 'broken',
					run: () => {
						throw new Error('this stage is broken');
					},
				},
			];
		},
	};
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
		options: options(),
		svgo: 'preset',
		texOptions: {},
		preambleLines: [],
		legacySource: null,
		timeoutMs: 1000,
		isExport: false,
		uncapped: false,
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
function realQueue(startupMs?: number, depthCap = 64) {
	const runs: Run[] = [];
	const queue = new RenderQueue<TexJobSpec, TexResult>({
		concurrency: 1,
		depthCap,
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

describe('an export with more diagrams to compile than the queue holds', () => {
	it('renders every one of them — no "Render diagram" button in the PDF', async () => {
		// The depth cap is 16 on a phone; the cap evicted export jobs like any other, and an
		// evicted block rests on its button, which is what went into the PDF.
		const { queue, runs } = realQueue(undefined, 1);
		const els = [container(), container(), container()];
		const blocks = els.map(
			(el, i) =>
				new TikzBlock(el, spec({ key: `K${i}`, isExport: true, uncapped: true }), deps({ queue })),
		);
		for (const block of blocks) block.onload();

		for (let i = 0; i < els.length; i++) {
			await vi.waitFor(() => expect(runs).toHaveLength(i + 1));
			runs[i]?.resolve(RESULT);
		}
		for (const block of blocks) await block.settled;
		for (const el of els) {
			expect(el.querySelector('.tikzjax-manual')).toBeNull();
			expect(el.querySelector('svg')).not.toBeNull();
		}
	});
});

describe('a compile the engine was stopped under', () => {
	/**
	 * Backgrounding iOS kills the worker, and so does "Restart the TeX engine" — and a neighbour's
	 * timeout used to. The diagram did nothing wrong, and used to get a card saying it took too long.
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

	/**
	 * main.ts pauses the queue and then kills the worker when the phone is backgrounded. Nothing
	 * starts while paused, so the interrupted job went back into a list of waiting jobs that was
	 * already at the cap — 16 on a phone — as the newest in its band, which is the one the cap
	 * turns away: the diagram being compiled came back as a "Render diagram" button.
	 */
	it('goes back in line when the phone is backgrounded with the queue full, first, and is not turned away', async () => {
		const { queue, runs } = realQueue(undefined, 2);
		const els = [container(), container(), container()];
		const blocks = els.map((el, i) => new TikzBlock(el, spec({ key: `K${i}` }), deps({ queue })));
		for (const block of blocks) block.onload();
		await vi.waitFor(() => expect(queue.size()).toBe(2));
		expect(runs.map((run) => run.job.key)).toEqual(['K0']);

		queue.pause();
		runs[0]?.reject(new InterruptedError('the app was backgrounded'));
		await new Promise((resolve) => setTimeout(resolve, 10));
		for (const el of els) expect(el.querySelector('.tikzjax-manual')).toBeNull();
		expect(runs).toHaveLength(1);

		queue.resume();
		for (let i = 1; i <= els.length; i++) {
			await vi.waitFor(() => expect(runs).toHaveLength(i + 1));
			runs[i]?.resolve(RESULT);
		}
		// It was the diagram being compiled, so it is the one to pick up again.
		expect(runs.map((run) => run.job.key)).toEqual(['K0', 'K0', 'K1', 'K2']);
		for (const block of blocks) await block.settled;
		for (const el of els) expect(el.querySelector('svg')).not.toBeNull();
	});

	it('still settles when the plugin is unloading, so nothing — a PDF export least of all — waits forever', async () => {
		// Unloading closes the queue, then disposes the host, which interrupts the running job.
		// The block asks again, is refused by the closed queue, and comes to rest.
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec(), deps({ queue }));
		child.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		queue.close();
		runs[0]?.reject(new InterruptedError('the plugin was unloaded'));

		await expect(child.settled).resolves.toBeUndefined();
		expect(runs).toHaveLength(1);
		expect(el.querySelector('.tikzjax-placeholder')).toBeNull();
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

	it('replaces the card: a spinner while it compiles, then the diagram alone', async () => {
		// The card used to stay where it was, under the diagram, once the retry succeeded.
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec({ timeoutMs: 20 }), deps({ queue }));
		child.onload();
		await child.settled;

		press(el, 'Retry');
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		expect(el.querySelector('.tikzjax-error')).toBeNull();
		expect(el.querySelectorAll('.tikzjax-placeholder')).toHaveLength(1);

		runs[1]?.resolve(RESULT);
		await vi.waitFor(() => expect(el.querySelector('svg')).not.toBeNull());
		expect(el.querySelectorAll('svg')).toHaveLength(1);
		expect(el.querySelector('.tikzjax-error')).toBeNull();
		expect(el.querySelector('.tikzjax-placeholder')).toBeNull();
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

describe('"Render diagram"', () => {
	it('gives way to a spinner, then to the diagram — the button does not linger', async () => {
		// lazy=manual, and every block pushed past the queue's depth cap, get this button. It used
		// to stay under the rendered diagram, doing nothing when pressed.
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(
			el,
			spec({ options: options({ presentation: { lazy: 'manual' } }) }),
			deps({ queue }),
		);
		child.onload();
		await child.settled;
		expect(el.querySelector('.tikzjax-manual')).not.toBeNull();

		press(el, 'Render diagram');
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		expect(el.querySelector('.tikzjax-manual')).toBeNull();
		expect(el.querySelectorAll('.tikzjax-placeholder')).toHaveLength(1);

		runs[0]?.resolve(RESULT);
		await vi.waitFor(() => expect(el.querySelector('svg')).not.toBeNull());
		expect(el.querySelector('.tikzjax-manual')).toBeNull();
		expect(el.querySelector('.tikzjax-placeholder')).toBeNull();
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

// -------------------------------------------------------------------------------------------
// What may be mounted and cached

/**
 * Make the mount-time measurement succeed, as it does in a real window: happy-dom has no
 * `document.fonts`, and its getBBox measures nothing. Without this, measure() never reaches the
 * cache, and a test could not see what it would have stored.
 */
function measurable(): () => void {
	const doc = document as unknown as { fonts?: unknown };
	const proto = window.SVGSVGElement.prototype as unknown as { getBBox?: unknown };
	const realBBox = proto.getBBox;
	Object.defineProperty(doc, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
	proto.getBBox = () => ({ x: 0, y: 0, width: 40, height: 20 });
	return () => {
		delete doc.fonts;
		proto.getBBox = realBBox;
	};
}

/** A queue that starts the job and hands back exactly this engine result. */
function answering(result: TexResult): BlockDeps['queue'] {
	return {
		submit: (_k: string, _j: TexJobSpec, _p: number, _t: number, opts?: { onStart?: () => void }) => {
			opts?.onStart?.();
			return Promise.resolve(result);
		},
		release: () => undefined,
	} as unknown as BlockDeps['queue'];
}

describe('engine output the SVG pipeline cannot make safe', () => {
	/**
	 * When the engine's SVG does not parse, or a mandatory stage throws, no document has passed
	 * sanitize and ids. The block used to mount the RAW engine string anyway — "degraded" — and
	 * measure() then wrote it to L1 and L2, so every later open replayed it. The engine passes
	 * `\special{dvisvgm:raw …}` through verbatim, so that string is author-controlled markup.
	 */
	it('is never mounted and never cached, and the card says why', async () => {
		const restore = measurable();
		try {
			const cache = fakeCache();
			const put = vi.spyOn(cache, 'put');
			const malformed =
				'<svg xmlns="http://www.w3.org/2000/svg"><g><rect onclick="alert(1)" width="10" height="10"/></svg>';
			const el = container();
			const child = new TikzBlock(
				el,
				spec(),
				deps({ cache, queue: answering({ svg: malformed, log: [], durationMs: 1 }) }),
			);

			child.onload();
			await child.settled;
			// Long enough for a measure() to have run and stored something, had one been started.
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(el.querySelector('[onclick]')).toBeNull();
			expect(el.querySelector('svg')).toBeNull();
			expect(put).not.toHaveBeenCalled();
			expect(cardText(el)).toBe('The diagram could not be made safe to show, so it is not shown.');
		} finally {
			restore();
		}
	});
});

describe('a pipeline that skipped an optional stage', () => {
	it('mounts what passed sanitize and ids, says what was skipped, and caches none of it', async () => {
		const restore = measurable();
		pipeline.breakAStage = true;
		try {
			const cache = fakeCache();
			const put = vi.spyOn(cache, 'put');
			const el = container();
			const child = new TikzBlock(
				el,
				spec(),
				deps({ cache, queue: answering({ svg: SVG, log: [], durationMs: 1 }) }),
			);

			child.onload();
			await child.settled;
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(el.querySelector('svg')).not.toBeNull();
			expect(el.querySelector('.tikzjax-warning-chip')?.textContent).toMatch(/broken stage failed/);
			// Not by `persist`, and not by the measurement that follows the mount either.
			expect(put).not.toHaveBeenCalled();
		} finally {
			pipeline.breakAStage = false;
			restore();
		}
	});
});

describe('the first measurement', () => {
	it('reframes the diagram it measured, and applies the scale it could not apply before', async () => {
		const restore = measurable();
		try {
			const cache = fakeCache();
			const put = vi.spyOn(cache, 'put');
			const el = container();
			const engineSvg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="-72 -72 100 50"><rect width="10" height="10"/></svg>';
			const child = new TikzBlock(
				el,
				spec({ options: options({ presentation: { scale: 2 } }) }),
				deps({ cache, queue: answering({ svg: engineSvg, log: [], durationMs: 1 }) }),
			);

			child.onload();
			await child.settled;
			await vi.waitFor(() =>
				expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 20'),
			);

			const svg = el.querySelector('svg');
			expect(svg?.getAttribute('width')).toBe('40pt');
			expect(svg?.getAttribute('height')).toBe('20pt');
			// Scaled from the measured width, not the engine's.
			expect(el.querySelector<HTMLElement>('.tikzjax-figure-wrapper')?.style.width).toBe('80pt');
			expect(put).toHaveBeenLastCalledWith(
				'K',
				expect.objectContaining({ viewBox: '0 0 40 20', w: 40 }),
			);
		} finally {
			restore();
		}
	});
});

describe('a diagram the sanitizer took something out of', () => {
	/**
	 * `\special{dvisvgm:raw …}` puts markup in the engine's output verbatim, and the sanitizer takes
	 * out whatever the engine itself never emits. What it took out was returned and then dropped,
	 * so someone with a legitimate raw special saw their markup vanish and nothing say why.
	 */
	it('mounts with a chip naming what was removed, and keeps it on the stored artifact', async () => {
		const restore = measurable();
		try {
			const cache = fakeCache();
			const put = vi.spyOn(cache, 'put');
			const el = container();
			const engineSvg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="-72 -72 100 50">' +
				'<g onclick="alert(1)"><rect width="10" height="10"/></g><script>alert(2)</script></svg>';
			const child = new TikzBlock(
				el,
				spec(),
				deps({ cache, queue: answering({ svg: engineSvg, log: [], durationMs: 1 }) }),
			);

			child.onload();
			await child.settled;

			const chip = 'Removed active content from this diagram: onclick=, <script>.';
			expect(el.querySelector('rect')).not.toBeNull();
			expect(el.querySelector('script')).toBeNull();
			expect(el.querySelector('.tikzjax-warning-chip')?.textContent).toBe(chip);
			// Safe to keep — it is what the sanitizer let through — so it is stored, chip and all.
			await vi.waitFor(() => expect(put).toHaveBeenCalled());
			expect(put.mock.calls[0]?.[1].warn).toBe(chip);
		} finally {
			restore();
		}
	});

	it('says how many more there were past the first three', async () => {
		const el = container();
		const engineSvg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">' +
			'<g onclick="a()" onmouseover="b()" onfocus="c()" onblur="d()" onkeyup="e()"/></svg>';
		const child = new TikzBlock(
			el,
			spec(),
			deps({ queue: answering({ svg: engineSvg, log: [], durationMs: 1 }) }),
		);

		child.onload();
		await child.settled;

		expect(el.querySelector('.tikzjax-warning-chip')?.textContent).toBe(
			'Removed active content from this diagram: onclick=, onmouseover=, onfocus= and 2 more.',
		);
	});
});

describe('blocks in different colour modes', () => {
	/**
	 * The mode is not in the key, so one stored template serves every block with the same source.
	 * The mode used to reach the stages, and whichever block compiled first decided what the others
	 * were served (svg/colors.ts); now the block hands the pipeline no mode at all.
	 */
	it('store the same template', async () => {
		const restore = measurable();
		try {
			const engineSvg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="-72 -72 100 50">' +
				'<rect fill="black" width="10" height="10"/><circle fill="white" r="3"/></svg>';
			const stored: string[] = [];
			for (const colors of ['adapt', 'preserve', 'paper', 'invert'] as const) {
				const cache = fakeCache();
				const put = vi.spyOn(cache, 'put');
				const child = new TikzBlock(
					container(),
					spec({ options: options({ presentation: { colors } }) }),
					deps({ cache, queue: answering({ svg: engineSvg, log: [], durationMs: 1 }) }),
				);
				child.onload();
				await child.settled;
				await vi.waitFor(() => expect(put).toHaveBeenCalled());
				stored.push(put.mock.calls[0]?.[1].template ?? '');
			}
			expect(new Set(stored).size).toBe(1);
			expect(stored[0]).toContain('currentColor');
		} finally {
			restore();
		}
	});
});

describe('a diagram TeX recovered from an error in', () => {
	it('mounts with what TeX reported beside it', async () => {
		// Only possible because the worker injects \nonstopmode: a diagram that renders with a
		// piece quietly missing. The warning was set on the raw result and dropped by the
		// pipeline, and the chip was only ever drawn for a degraded mount.
		const el = container();
		const child = new TikzBlock(
			el,
			spec(),
			deps({
				queue: answering({
					svg: SVG,
					log: [],
					durationMs: 1,
					firstError: 'Undefined control sequence.',
				}),
			}),
		);

		child.onload();
		await child.settled;

		expect(el.querySelector('svg')).not.toBeNull();
		expect(el.querySelector('.tikzjax-warning-chip')?.textContent).toBe(
			'TeX reported: Undefined control sequence.',
		);
	});
});

/** A queue that records the band each block asked for, and never answers. */
function recordingBands(): { queue: BlockDeps['queue']; bands: number[] } {
	const bands: number[] = [];
	const queue = {
		submit: (_k: string, _j: TexJobSpec, priority: number) => {
			bands.push(priority);
			return new Promise(() => undefined);
		},
		release: () => undefined,
	} as unknown as BlockDeps['queue'];
	return { queue, bands };
}

describe('a block the viewport never reports on', () => {
	/**
	 * After two seconds without a record the viewport gate gives up waiting — for a block detached
	 * from the document, say — and the escape hatch was meant to queue it at the back. It reported
	 * the block VISIBLE instead, so it went in with the diagrams the reader was looking at.
	 */
	it('goes to the back of the queue', async () => {
		const { queue, bands } = recordingBands();
		const child = new TikzBlock(
			container(),
			spec(),
			deps({ queue, observe: (_el, onChange) => onChange(true, true) }),
		);
		child.onload();
		await vi.waitFor(() => expect(bands).toHaveLength(1));
		expect(bands).toEqual([3]);
	});
});

describe('the debounce', () => {
	/**
	 * It exists for typing (#24): a block remade at every keystroke must not compile at every
	 * keystroke. Every block used to wait for it, so a note opened on a phone waited 500 ms before
	 * its first diagram was even queued. Now only a block of a note being typed in waits.
	 */
	const LONG = 60_000;

	it('is not waited for by a block shown for the first time: it is queued as soon as it is seen', async () => {
		const { queue, bands } = recordingBands();
		const child = new TikzBlock(
			container(),
			spec(),
			deps({ queue, debounceMs: LONG, editing: () => false }),
		);
		child.onload();
		await vi.waitFor(() => expect(bands).toEqual([1]));
	});

	it('is waited for by a block of a note being typed in, which the next keystroke unloads unqueued', async () => {
		const { queue, bands } = recordingBands();
		const child = new TikzBlock(
			container(),
			spec(),
			deps({ queue, debounceMs: LONG, editing: () => true }),
		);
		child.onload();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(bands).toEqual([]);

		child.onunload();
		await child.settled;
		expect(bands).toEqual([]);
	});

	it('asks whether the note is being typed in when the cache misses, not before', async () => {
		const asked = vi.fn(() => false);
		const child = new TikzBlock(
			container(),
			spec(),
			deps({ cache: fakeCache(artifact(SVG)), editing: asked }),
		);
		child.onload();
		await child.settled;
		// A cached diagram never waits for anything, so nothing is asked.
		expect(asked).not.toHaveBeenCalled();
	});
});

describe('the engine started ahead of the first job', () => {
	/**
	 * A diagram that is not cached will be compiled once it has been seen, so the engine is started
	 * when the cache misses, and its start runs while the block waits for the viewport gate and the
	 * queue. Never for a cached diagram, nor for one waiting for a button press.
	 */
	it('is started when the cache misses, before the block is even seen', async () => {
		const startEngine = vi.fn();
		const child = new TikzBlock(
			container(),
			spec(),
			// Never in view, so never queued: only the miss can have started the engine.
			deps({ startEngine, observe: () => undefined }),
		);
		child.onload();
		await vi.waitFor(() => expect(startEngine).toHaveBeenCalledTimes(1));
		child.onunload();
	});

	it('is not started for a diagram from the cache', async () => {
		const startEngine = vi.fn();
		const child = new TikzBlock(
			container(),
			spec(),
			deps({ cache: fakeCache(artifact(SVG)), startEngine }),
		);
		child.onload();
		await child.settled;
		expect(startEngine).not.toHaveBeenCalled();
	});

	it('is not started for a lazy=manual diagram, which waits for its button', async () => {
		const startEngine = vi.fn();
		const child = new TikzBlock(
			container(),
			spec({ options: options({ presentation: { lazy: 'manual' } }) }),
			deps({ startEngine }),
		);
		child.onload();
		await child.settled;
		expect(startEngine).not.toHaveBeenCalled();
	});
});

describe('fast mode', () => {
	/**
	 * Fast mode is a preset (settings: "Preset: no SVGO, no pre-flight lint, one priority band up"),
	 * and the band was never moved: a fast diagram waited behind the full renders beside it.
	 */
	it('asks the queue for one band more urgent than the same block at full quality', async () => {
		const { queue, bands } = recordingBands();
		new TikzBlock(container(), spec(), deps({ queue })).onload();
		new TikzBlock(container(), spec({ options: options({ fast: true }) }), deps({ queue })).onload();
		await vi.waitFor(() => expect(bands).toHaveLength(2));
		expect(bands).toEqual([1, 0]);
	});

	it('cannot go above the export band', async () => {
		const { queue, bands } = recordingBands();
		new TikzBlock(
			container(),
			spec({ isExport: true, options: options({ fast: true }) }),
			deps({ queue }),
		).onload();
		await vi.waitFor(() => expect(bands).toHaveLength(1));
		expect(bands).toEqual([0]);
	});

	it('is still framed by the measurement: without it, the right and bottom edges are cut off', async () => {
		const restore = measurable();
		try {
			const el = container();
			const engineSvg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="-72 -72 100 50"><rect width="10" height="10"/></svg>';
			const child = new TikzBlock(
				el,
				spec({ options: options({ fast: true }) }),
				deps({ queue: answering({ svg: engineSvg, log: [], durationMs: 1 }) }),
			);
			child.onload();
			await child.settled;
			await vi.waitFor(() =>
				expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 20'),
			);
		} finally {
			restore();
		}
	});
});

describe('the svgo setting and directive', () => {
	/**
	 * They reached the cache key and nothing else: `%!tikz svgo=off` recompiled the diagram and
	 * changed nothing about it, because the pipeline only ever asked whether the block was fast.
	 * `alignment-baseline` on a <text> is what the targeted transform removes.
	 */
	const TEXT_SVG =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text alignment-baseline="baseline">x</text></svg>';

	async function mountedWith(over: Partial<TexJobSpec>): Promise<Element | null> {
		const el = container();
		const child = new TikzBlock(
			el,
			spec(over),
			deps({ queue: answering({ svg: TEXT_SVG, log: [], durationMs: 1 }) }),
		);
		child.onload();
		await child.settled;
		return el.querySelector('text');
	}

	it('off leaves the engine output unoptimised', async () => {
		const text = await mountedWith({ svgo: 'off' });
		expect(text?.getAttribute('alignment-baseline')).toBe('baseline');
	});

	it('targeted runs the targeted transform', async () => {
		const text = await mountedWith({ svgo: 'targeted' });
		expect(text).not.toBeNull();
		expect(text?.hasAttribute('alignment-baseline')).toBe(false);
	});

	it('preset, with SVGO not bundled, runs the targeted transform as it always has', async () => {
		const text = await mountedWith({ svgo: 'preset' });
		expect(text?.hasAttribute('alignment-baseline')).toBe(false);
	});

	it('fast mode turns every optimisation off, whatever svgo says', async () => {
		const text = await mountedWith({ svgo: 'targeted', options: options({ fast: true }) });
		expect(text?.getAttribute('alignment-baseline')).toBe('baseline');
	});
});

describe('what a block reports when it comes to rest', () => {
	/**
	 * The diagnostics view listed every block as "rendering" forever, and "Render all diagrams"
	 * counted no failures: the only record of a block was written when it was processed, before
	 * anything had happened to it.
	 */
	function reporting(): { reports: BlockOutcome[]; report: (outcome: BlockOutcome) => void } {
		const reports: BlockOutcome[] = [];
		return { reports, report: (outcome) => void reports.push(outcome) };
	}

	it('a diagram from memory: cached, and from which tier', async () => {
		const { reports, report } = reporting();
		const child = new TikzBlock(container(), spec(), deps({ cache: fakeCache(artifact(SVG)), report }));
		child.onload();
		await child.settled;
		expect(reports).toEqual([{ state: 'cached', tier: 'l1' }]);
	});

	it('a compiled diagram: ok, and how long TeX took', async () => {
		const { reports, report } = reporting();
		const child = new TikzBlock(
			container(),
			spec(),
			deps({ queue: answering({ svg: SVG, log: [], durationMs: 42 }), report }),
		);
		child.onload();
		await child.settled;
		await vi.waitFor(() => expect(reports).toHaveLength(2));
		const timings = { waitedMs: 0, queueMs: 0, postMs: 0 };
		expect(reports).toEqual([
			{ state: 'ok', durationMs: 42, timings },
			{ state: 'ok', durationMs: 42, timings: { ...timings, mountMs: 0, totalMs: 0 } },
		]);
	});

	it('a compiled diagram: where its time went, before the engine, in it and after it', async () => {
		const { reports, report } = reporting();
		let now = 100;
		const engine = { resetMs: 5, texMs: 63, svgMs: 9, passes: 1, startMs: 850 };
		const queue = {
			submit: (_k: string, _j: TexJobSpec, _p: number, _t: number, opts?: { onStart?: () => void }) => {
				// Behind other diagrams for 30 ms, then started.
				now += 30;
				opts?.onStart?.();
				return Promise.resolve({ svg: SVG, log: [], durationMs: 80, timings: engine });
			},
			release: () => undefined,
		} as unknown as BlockDeps['queue'];
		pipeline.during = () => void (now += 7);
		const restore = measurable();
		// The measurement, which waits for the fonts and reframes the diagram, takes 25 ms.
		(window.SVGSVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => {
			now += 25;
			return { x: 0, y: 0, width: 40, height: 20 } as DOMRect;
		};
		try {
			const child = new TikzBlock(
				container(),
				spec(),
				deps({
					queue,
					now: () => now,
					report,
					// Seen at 100, and asked for 300 ms later, after its debounce.
					observe: (_el, onChange) => {
						onChange(true);
						now += 300;
					},
				}),
			);
			child.onload();
			await child.settled;
			await vi.waitFor(() => expect(reports).toHaveLength(2));
		} finally {
			pipeline.during = null;
			restore();
		}

		// When it came to rest, and again once it had been drawn, with the mount and the whole wait.
		const atRest = { ...engine, waitedMs: 300, queueMs: 30, postMs: 7 };
		expect(reports).toEqual([
			{ state: 'ok', durationMs: 80, timings: atRest },
			{ state: 'ok', durationMs: 80, timings: { ...atRest, mountMs: 25, totalMs: 362 } },
		]);
	});

	it('a diagram from a cache: no timings, since nothing was compiled', async () => {
		const { reports, report } = reporting();
		const child = new TikzBlock(container(), spec(), deps({ cache: fakeCache(artifact(SVG)), report }));
		child.onload();
		await child.settled;
		expect(reports[0]?.timings).toBeUndefined();
	});

	it('a failure: what its card says, and the log', async () => {
		const { reports, report } = reporting();
		const { queue, runs } = realQueue();
		const child = new TikzBlock(container(), spec(), deps({ queue, report }));
		child.onload();
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		runs[0]?.reject(new TexError('missing-file', ['! LaTeX Error'], undefined, undefined, 'siunitx.sty'));
		await child.settled;

		expect(reports).toEqual([
			{
				state: 'error',
				reason: 'missing-file',
				message: 'siunitx.sty is not bundled with this TeX engine.',
				log: ['! LaTeX Error'],
			},
		]);
	});

	it('a "Render diagram" button: manual', async () => {
		const { reports, report } = reporting();
		const child = new TikzBlock(
			container(),
			spec({ options: options({ presentation: { lazy: 'manual' } }) }),
			deps({ report }),
		);
		child.onload();
		await child.settled;
		expect(reports).toEqual([{ state: 'manual' }]);
	});

	it('a block unloaded before it came to rest: cancelled', async () => {
		const { reports, report } = reporting();
		const { queue } = realQueue();
		const child = new TikzBlock(container(), spec(), deps({ queue, report }));
		child.onload();
		child.onunload();
		await child.settled;
		expect(reports).toEqual([{ state: 'cancelled' }]);
	});

	it('again after a Retry, with the new outcome', async () => {
		const { reports, report } = reporting();
		const { queue, runs } = realQueue();
		const el = container();
		const child = new TikzBlock(el, spec({ timeoutMs: 20 }), deps({ queue, report }));
		child.onload();
		await child.settled;

		press(el, 'Retry');
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		runs[1]?.resolve(RESULT);
		// At rest, and once drawn.
		await vi.waitFor(() => expect(reports).toHaveLength(3));
		expect(reports.map((r) => r.state)).toEqual(['error', 'ok', 'ok']);
	});
});
