// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { shownNotices } from './stubs/obsidian';
import { installObsidianDom } from './stubs/obsidian-dom';
import { DebugView, type DebugSource, type RenderRecord } from '../src/ui/debug-view';
import { diagnosticsText } from '../src/ui/report';
import type { EngineReport } from '../src/engine/worker-host';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/*
 * The diagnostics view is where a slow diagram gets reported from, so for each diagram compiled it
 * says where the time went: waiting to be asked for, waiting in the queue, waiting for the engine to
 * start if this diagram did, setting up TeX's memory, TeX, drawing the DVI as SVG, the SVG pipeline
 * after it, drawing it in the note, and the whole wait. It says how often the engine started, and
 * its Copy button puts it on the clipboard as text, without the diagrams' code, the error messages
 * or the notes.
 */

const NO_STARTS: EngineReport = { starts: 0, lives: [], lastStop: null, poolSize: 2 };

function source(records: RenderRecord[], engine: EngineReport = NO_STARTS): DebugSource {
	return {
		records: () => records,
		inventory: () => null,
		cacheStats: () => Promise.resolve({ entries: 0, bytes: 0 }),
		memoryStats: () => ({ entries: 0, bytes: 0 }),
		queueDepth: () => 0,
		engine: () => engine,
		about: () => ({
			plugin: '0.2.1',
			obsidian: '1.7.2',
			platform: 'desktop',
			os: 'Windows',
			webView: { decompressionStream: true, fromBase64: false, cores: 8, memoryGiB: 8 },
			engineId: 'e'.repeat(64),
			outputRevision: 'r'.repeat(64),
		}),
		now: () => 0,
	};
}

/** The view, opened once on these records and its refresh timer stopped. */
async function opened(from: DebugSource): Promise<DebugView> {
	const view = new DebugView({} as WorkspaceLeaf, from);
	view.load();
	await view.onOpen();
	// Stops the view's refresh timer, which `onOpen` registered.
	view.unload();
	return view;
}

/** The view's rows, as drawn once for these records. */
async function rows(records: RenderRecord[]): Promise<HTMLElement[]> {
	const view = await opened(source(records));
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
				timings: {
					waitedMs: 300,
					queueMs: 30,
					startMs: 850,
					resetMs: 5,
					texMs: 63,
					svgMs: 9,
					passes: 1,
					postMs: 7,
					mountMs: 25,
					totalMs: 1290,
				},
			}),
		]);
		expect(timingsOf(row)).toEqual([
			'waited 300 ms',
			'queue 30 ms',
			'engine start 850 ms',
			'memory reset 5 ms',
			'TeX 63 ms',
			'DVI to SVG 9 ms',
			'SVG pipeline 7 ms',
			'drawing 25 ms',
			'seen to drawn 1290 ms',
		]);
	});

	it('leave out the engine start for a diagram that did not wait for one', async () => {
		const [row] = await rows([
			record({ timings: { queueMs: 0, resetMs: 5, texMs: 63, svgMs: 9, passes: 1, postMs: 7 } }),
		]);
		expect(timingsOf(row)).not.toContain('engine start 850 ms');
		expect(timingsOf(row)[1]).toBe('memory reset 5 ms');
	});

	it('say when the engine took a new memory for the diagram rather than resetting its own', async () => {
		// Newest first, as the view lists them.
		const [reset, fresh] = await rows([
			record({
				timings: { queueMs: 0, resetMs: 6, newMemory: 1, texMs: 63, svgMs: 9, passes: 1, postMs: 7 },
			}),
			record({
				timings: { queueMs: 0, resetMs: 4, newMemory: 0, texMs: 63, svgMs: 9, passes: 1, postMs: 7 },
			}),
		]);
		expect(timingsOf(fresh)).toContain('new memory 6 ms');
		expect(timingsOf(reset)).toContain('memory reset 4 ms');
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

describe('the rows of the diagnostics view', () => {
	it('are named as the copied text names them, so a line of a report can be found on the screen', async () => {
		const found = await rows([
			record({ key: 'aaaaaaaa-old', state: 'cached', tier: 'l2' }),
			record({ key: 'bbbbbbbb-new', durationMs: 42 }),
		]);
		const meta = (row: HTMLElement | undefined): string =>
			row?.querySelector('.tikzjax-debug-meta')?.textContent ?? '';
		expect(meta(found[0])).toBe('#2 bbbbbbbb · 42 ms');
		expect(meta(found[1])).toBe('#1 aaaaaaaa · from l2');
	});
});

describe('the engine in the diagnostics view', () => {
	it('says how often it started, how long each start took, and why it last stopped', async () => {
		const view = await opened(
			source([], {
				starts: 2,
				lives: [
					{ startMs: 230, boot: null, snapshots: null, stop: 'background' },
					{
						startMs: 86,
						boot: {
							decodeMs: 3,
							inflateMs: 45,
							compileMs: 0,
							totalMs: 49,
							nativeInflate: true,
							nativeBase64: true,
						},
						snapshots: null,
						stop: null,
					},
				],
				lastStop: 'background',
				poolSize: 2,
			}),
		);
		const text = view.contentEl.querySelector('.tikzjax-debug-starts')?.textContent ?? '';
		expect(text).toContain('The engine started 2 times this session.');
		expect(text).toContain('started in 230 ms, stopped when the app went to the background');
		expect(text).toContain(
			'started in 86 ms (in the worker 49 ms: decode 3 ms, inflate 45 ms, compile 0 ms; ' +
				'native gzip yes, native base64 yes), running',
		);
		expect(text).toContain('Last stopped: stopped when the app went to the background.');
		expect(text).toContain('Up to 2 engines compile at once.');
	});
});

describe('the Copy button', () => {
	const RECORDS = [record({ timings: { queueMs: 2, postMs: 1 } })];

	afterEach(() => {
		Reflect.deleteProperty(navigator, 'clipboard');
		Reflect.deleteProperty(navigator, 'permissions');
		Reflect.deleteProperty(document, 'execCommand');
		vi.useRealTimers();
	});

	/** The document's copy command, recording what the view's textarea had selected when it ran. */
	function copyCommand(copies: boolean): { calls: string[]; selected: string[]; view: DebugView | null } {
		const recorded = { calls: [] as string[], selected: [] as string[], view: null as DebugView | null };
		const execCommand = (command: string): boolean => {
			recorded.calls.push(command);
			const area = recorded.view?.contentEl.querySelector('textarea');
			recorded.selected.push(area?.value.slice(area.selectionStart, area.selectionEnd) ?? '');
			return copies;
		};
		Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
		return recorded;
	}

	const press = (view: DebugView): void =>
		[...view.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Copy')?.click();

	it('puts the view on the clipboard as text, from inside the click', async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const from = source(RECORDS);
		const view = await opened(from);
		const before = shownNotices.length;

		press(view);
		// Called before the click handler returned, which is what WebKit asks of a page.
		expect(writeText).toHaveBeenCalledTimes(1);
		const copied = (writeText.mock.calls[0] as unknown as [string])[0];
		expect(copied).toBe(
			diagnosticsText({
				about: from.about(),
				engine: from.engine(),
				memory: from.memoryStats(),
				stored: { entries: 0, bytes: 0 },
				queueDepth: 0,
				records: RECORDS,
				now: 0,
			}),
		);
		await vi.waitFor(() => expect(shownNotices.length).toBe(before + 1));
		expect(shownNotices[shownNotices.length - 1]?.message).toBe('Diagnostics copied to the clipboard.');
		expect(view.contentEl.querySelector<HTMLElement>('.tikzjax-debug-by-hand')?.hidden).toBe(true);
	});

	it('shows the text, selected, to copy by hand where there is no clipboard', async () => {
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		const view = await opened(source(RECORDS));

		press(view);
		const box = view.contentEl.querySelector<HTMLElement>('.tikzjax-debug-by-hand');
		const area = box?.querySelector('textarea');
		expect(box?.hidden).toBe(false);
		expect(area?.value).toContain('TikZJax Next diagnostics');
		expect(area?.value).toContain('queue 2 ms');
		expect(area?.selectionStart).toBe(0);
		expect(area?.selectionEnd).toBe(area?.value.length);
	});

	it('shows it to copy by hand when the clipboard says no', async () => {
		const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const view = await opened(source(RECORDS));

		press(view);
		await vi.waitFor(() =>
			expect(view.contentEl.querySelector<HTMLElement>('.tikzjax-debug-by-hand')?.hidden).toBe(false),
		);
		expect(view.contentEl.querySelector('textarea')?.value).toContain('Plugin: 0.2.1');
	});

	it('copies with the copy command, from inside the click, where the Permissions API is missing', async () => {
		// As Obsidian does, read in its 1.14.4 bundle: an older iOS WebKit has the asynchronous
		// clipboard and not the Permissions API, and only the command is sure to work there.
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
		const command = copyCommand(true);
		const view = await opened(source(RECORDS));
		command.view = view;
		const before = shownNotices.length;

		press(view);
		expect(writeText).not.toHaveBeenCalled();
		expect(command.calls).toEqual(['copy']);
		// The whole text was selected when the command ran.
		expect(command.selected[0]).toContain('TikZJax Next diagnostics');
		expect(command.selected[0]).toContain('queue 2 ms');
		expect(shownNotices.length).toBe(before + 1);
		expect(view.contentEl.querySelector<HTMLElement>('.tikzjax-debug-by-hand')?.hidden).toBe(true);
	});

	it('leaves the text to copy by hand when the copy command does not copy', async () => {
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		copyCommand(false);
		const view = await opened(source(RECORDS));

		press(view);
		const area = view.contentEl.querySelector('textarea');
		expect(view.contentEl.querySelector<HTMLElement>('.tikzjax-debug-by-hand')?.hidden).toBe(false);
		expect(area?.getAttribute('aria-label')).toBe('Diagnostics as text');
		expect(area?.selectionEnd).toBe(area?.value.length);
	});

	it('shows the text to copy by hand when the clipboard never answers', async () => {
		const writeText = vi.fn(() => new Promise<void>(() => undefined));
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const view = await opened(source(RECORDS));
		vi.useFakeTimers();

		press(view);
		const box = view.contentEl.querySelector<HTMLElement>('.tikzjax-debug-by-hand');
		vi.advanceTimersByTime(1499);
		expect(box?.hidden).toBe(true);
		vi.advanceTimersByTime(1);
		expect(box?.hidden).toBe(false);
		expect(view.contentEl.querySelector('textarea')?.value).toContain('Plugin: 0.2.1');
	});

	it('copies no diagram source, though the view shows it', async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const view = await opened(source(RECORDS));
		expect(view.contentEl.textContent).toContain('\\draw (0,0) -- (1,1);');

		press(view);
		expect((writeText.mock.calls[0] as unknown as [string])[0]).not.toContain('\\draw');
	});
});
