// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { TikzBlock, type BlockDeps, type TexJobSpec } from '../src/block/render-child';
import type { Artifact, BlockOptions, EngineCapabilities, TexHost, TexResult } from '../src/types';
import { TexError } from '../src/types';

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
		baked: { border: null, packages: {}, libraries: '', preamble: '', depHashes: [], wrap: 'auto', twoPass: false },
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

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="10" height="10"/></svg>';

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
					submit: (_k: string, job: TexJobSpec) => {
						job.onStart?.();
						return Promise.reject(
							new TexError('tex-error', ['! Undefined control sequence.'], 'Undefined control sequence.', 4),
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
