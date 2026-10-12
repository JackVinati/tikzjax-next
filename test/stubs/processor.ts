import { expect } from 'vitest';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { Component } from './obsidian';
import { FakeTimers } from './timers';
import { fakeApp } from './vault';
import { createProcessor, type ProcessorDeps } from '../../src/block/processor';
import type { TexJobSpec } from '../../src/block/render-child';
import { PreambleService } from '../../src/preamble/vault';
import { budgetsFor } from '../../src/platform/budgets';
import { DEFAULT_SETTINGS, type TikzSettings } from '../../src/settings/schema';
import type { Artifact, EngineCapabilities, TexHost } from '../../src/types';

/**
 * The code-block processor with everything around it faked except what decides a block's spec:
 * the settings, the budgets, the preamble service over a fake vault, and the key derivation.
 * Needs a DOM (happy-dom) and the Obsidian DOM extensions installed.
 */

export const CAPS: EngineCapabilities = { expl3: true, twoPass: false, packages: {}, files: new Set() };

/** An engine that never answers: tests that need a compile give the processor a queue of their own. */
export const host: TexHost = {
	id: 'test-engine',
	capabilities: CAPS,
	ready: () => Promise.resolve(),
	render: () => new Promise(() => undefined),
	dispose: () => undefined,
};

export function artifact(over: Partial<Artifact> = {}): Artifact {
	return {
		v: 1,
		template:
			'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="-72 -72 100 50">' +
			'<clipPath id="__TZ__0"><rect width="10" height="10"/></clipPath>' +
			'<g clip-path="url(#__TZ__0)"><rect width="20" height="20"/></g></svg>',
		w: 40,
		h: 20,
		viewBox: '0 0 40 20',
		fonts: [],
		bytes: 200,
		engineId: 'test-engine',
		origin: 'render',
		createdAt: 0,
		lastUsed: 0,
		...over,
	};
}

/** L1 and L2 as two maps, so a test can put an artifact in either. Never an L3 hit. */
export function tieredCache() {
	const l1 = new Map<string, Artifact>();
	const l2 = new Map<string, Artifact>();
	const cache = {
		peek: (key: string) => l1.get(key),
		peekSize: () => undefined,
		lookup: (key: string) => {
			const hot = l1.get(key);
			if (hot) return Promise.resolve({ artifact: hot, tier: 'l1' as const });
			const stored = l2.get(key);
			if (!stored) return Promise.resolve(undefined);
			l1.set(key, stored);
			return Promise.resolve({ artifact: stored, tier: 'l2' as const });
		},
		put: (key: string, a: Artifact) => void l1.set(key, a),
	};
	return { l1, l2, cache: cache as unknown as ProcessorDeps['cache'] };
}

export function processorDeps(over: Partial<ProcessorDeps> = {}, app = fakeApp()) {
	const { l1, l2, cache } = tieredCache();
	const seen: TexJobSpec[] = [];
	const settings: { current: TikzSettings } = { current: { ...DEFAULT_SETTINGS } };
	const timers = new FakeTimers();
	const deps: ProcessorDeps = {
		app,
		settings: () => settings.current,
		budgets: budgetsFor(false),
		cache,
		queue: { submit: () => new Promise(() => undefined), release: () => undefined } as never,
		host,
		svgo: null,
		observe: () => undefined,
		unobserve: () => undefined,
		ensureFonts: () => undefined,
		now: timers.time,
		timers,
		preamble: new PreambleService(app, (text) => String(text.length)),
		onBlock: (spec) => void seen.push(spec),
		...over,
	};
	return { deps, seen, settings, timers, l1, l2 };
}

/** One processor per set of deps, as the plugin registers one: it keeps state across blocks. */
const processors = new WeakMap<ProcessorDeps, ReturnType<typeof createProcessor>>();
function processorFor(deps: ProcessorDeps): ReturnType<typeof createProcessor> {
	let processor = processors.get(deps);
	if (!processor) {
		processor = createProcessor(deps);
		processors.set(deps, processor);
	}
	return processor;
}

/**
 * Hand a block to the processor the way Obsidian does: a container in the page, and a context
 * whose `addChild` loads the block at once. `load: false` keeps the block from starting, for a
 * test that only wants the spec.
 */
export async function processBlock(
	deps: ProcessorDeps,
	seen: TexJobSpec[],
	source: string,
	opts: { path?: string; el?: HTMLElement; load?: boolean } = {},
) {
	const el = opts.el ?? document.body.createDiv();
	const parent = new Component();
	if (opts.load !== false) parent.load();
	const before = seen.length;
	const ctx = {
		sourcePath: opts.path ?? 'note.md',
		addChild: (child: Component) => parent.addChild(child),
	} as unknown as MarkdownPostProcessorContext;
	const settled = processorFor(deps)(source, el, ctx);
	// The processor goes async only to resolve a preamble; give it the turns that takes.
	for (let i = 0; i < 20 && seen.length === before; i++) await Promise.resolve();
	expect(seen.length).toBe(before + 1);
	const spec = seen[seen.length - 1] as TexJobSpec;
	return { spec, settled, el, parent };
}
