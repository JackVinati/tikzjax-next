// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { installObsidianDom } from './stubs/obsidian-dom';
import { DebugView, type DebugSource, type RenderRecord } from '../src/ui/debug-view';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/*
 * The diagnostics view is where a slow diagram gets reported from, so for each diagram compiled it
 * says where the time went: waiting in the queue, waiting for the engine to start if this diagram
 * did, setting up TeX's memory, TeX, drawing the DVI as SVG, and the SVG pipeline after it.
 */

function source(records: RenderRecord[]): DebugSource {
	return {
		records: () => records,
		inventory: () => null,
		cacheStats: () => Promise.resolve({ entries: 0, bytes: 0 }),
		memoryStats: () => ({ entries: 0, bytes: 0 }),
		queueDepth: () => 0,
	};
}

/** The view's rows, as drawn once for these records. */
async function rows(records: RenderRecord[]): Promise<HTMLElement[]> {
	const view = new DebugView({} as WorkspaceLeaf, source(records));
	view.load();
	await view.onOpen();
	// Stops the view's refresh timer, which `onOpen` registered.
	view.unload();
	return [...view.contentEl.querySelectorAll<HTMLElement>('.tikzjax-debug-row')];
}

const timingsOf = (row: HTMLElement | undefined): string[] =>
	[...(row?.querySelectorAll('.tikzjax-debug-timings > span') ?? [])].map((span) => span.textContent ?? '');

const record = (over: Partial<RenderRecord>): RenderRecord => ({
	key: 'K',
	sourcePreview: '\\draw (0,0) -- (1,1);',
	state: 'ok',
	at: 0,
	...over,
});

describe('the timings of a diagram in the diagnostics view', () => {
	it('are each step of a compile, in the order they happened', async () => {
		const [row] = await rows([
			record({
				durationMs: 80,
				timings: { queueMs: 30, startMs: 850, resetMs: 5, texMs: 63, svgMs: 9, passes: 1, postMs: 7 },
			}),
		]);
		expect(timingsOf(row)).toEqual([
			'queue 30 ms',
			'engine start 850 ms',
			'memory reset 5 ms',
			'TeX 63 ms',
			'DVI to SVG 9 ms',
			'SVG pipeline 7 ms',
		]);
	});

	it('leave out the engine start for a diagram that did not wait for one', async () => {
		const [row] = await rows([
			record({ timings: { queueMs: 0, resetMs: 5, texMs: 63, svgMs: 9, passes: 1, postMs: 7 } }),
		]);
		expect(timingsOf(row)).not.toContain('engine start 850 ms');
		expect(timingsOf(row)[1]).toBe('memory reset 5 ms');
	});

	it('say when TeX ran twice', async () => {
		const [row] = await rows([
			record({ timings: { queueMs: 0, resetMs: 10, texMs: 120, svgMs: 9, passes: 2, postMs: 7 } }),
		]);
		expect(timingsOf(row)).toContain('TeX 120 ms, 2 passes');
	});

	it('are the queue and the pipeline alone when the engine said nothing of its steps', async () => {
		const [row] = await rows([record({ timings: { queueMs: 12, postMs: 3 } })]);
		expect(timingsOf(row)).toEqual(['queue 12 ms', 'SVG pipeline 3 ms']);
	});

	it('are not there for a diagram that came from a cache, or failed', async () => {
		const found = await rows([
			record({ state: 'cached', tier: 'l1' }),
			record({ state: 'error', message: 'Undefined control sequence.' }),
		]);
		expect(found).toHaveLength(2);
		for (const row of found) expect(row.querySelector('.tikzjax-debug-timings')).toBeNull();
	});

	it('sit under the row they belong to, newest row first', async () => {
		const found = await rows([
			record({ key: 'old', timings: { queueMs: 1, postMs: 1 } }),
			record({ key: 'new', timings: { queueMs: 2, postMs: 2 } }),
		]);
		expect(timingsOf(found[0])[0]).toBe('queue 2 ms');
		expect(timingsOf(found[1])[0]).toBe('queue 1 ms');
	});
});
