// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { artifact, processBlock, processorDeps, tieredCache } from './stubs/processor';
import { fakeApp } from './stubs/vault';
import { BlockTally, createProcessor, OFFSCREEN_CLASS, rendersDifferently } from '../src/block/processor';
import { RecentEdits } from '../src/block/edits';
import { Component } from './stubs/obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';
import type { BlockOutcome, TexJobSpec } from '../src/block/render-child';
import { buildInput } from '../engine-src/document';
import { budgetsFor } from '../src/platform/budgets';
import { DEFAULT_SETTINGS, type TikzSettings } from '../src/settings/schema';
import { RenderQueue } from '../src/queue/queue';
import { TexError, type TexResult } from '../src/types';
import { BLOCKS, livePreviewWidget } from './support/obsidian-blocks';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

const SOURCE = '\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}';

/** Let every pending microtask run: the lookups, the submits, the settlements. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function tracked(promise: Promise<void>): { done: boolean } {
	const state = { done: false };
	void promise.then(() => (state.done = true));
	return state;
}

const cardText = (el: HTMLElement): string | null | undefined =>
	el.querySelector('.tikzjax-error-message')?.textContent;

describe('a PDF export', () => {
	/**
	 * printToPdf renders the note into a `.print` container and waits on every block's promise,
	 * with no timeout of its own. Each block had 30 s, one after another, so a note with forty
	 * uncached diagrams held "Preparing PDF" for up to twenty minutes; the total budget was
	 * defined in budgets.ts and read nowhere.
	 */
	const printed = (): HTMLElement => document.body.createDiv({ cls: 'print' });
	const TOTAL = budgetsFor(false).exportTotalBudgetMs;

	it('stops waiting once its total budget is spent, and says so on every diagram it gave up on', async () => {
		const { deps, seen, timers } = processorDeps();
		const print = printed();
		const blocks = [];
		for (let i = 0; i < 3; i++) {
			blocks.push(
				await processBlock(deps, seen, `\\draw (${i},0) circle (1);`, { el: print.createDiv() }),
			);
		}
		const done = blocks.map((b) => tracked(b.settled));
		await flush();

		timers.advance(TOTAL - 1);
		await flush();
		expect(done.map((d) => d.done)).toEqual([false, false, false]);

		timers.advance(1);
		await vi.waitFor(() => expect(done.map((d) => d.done)).toEqual([true, true, true]));
		for (const block of blocks) {
			expect(cardText(block.el)).toBe('This diagram was not ready in time for the export.');
		}
	});

	it('gives a block that joins the export late only what is left of the budget', async () => {
		const { deps, seen, timers } = processorDeps();
		const print = printed();
		const first = await processBlock(deps, seen, SOURCE, { el: print.createDiv() });
		timers.advance(TOTAL - 1000);
		const late = await processBlock(deps, seen, `${SOURCE}%`, { el: print.createDiv() });
		const firstDone = tracked(first.settled);
		const lateDone = tracked(late.settled);

		timers.advance(1000);
		await vi.waitFor(() => expect(lateDone.done).toBe(true));
		expect(firstDone.done).toBe(true);
	});

	it('gives each export its own budget', async () => {
		const { deps, seen, timers } = processorDeps();
		const earlier = await processBlock(deps, seen, SOURCE, { el: printed().createDiv() });
		timers.advance(TOTAL - 1000);
		const later = await processBlock(deps, seen, SOURCE, { el: printed().createDiv() });
		const laterDone = tracked(later.settled);

		timers.advance(1000);
		await flush();
		await earlier.settled;
		expect(laterDone.done).toBe(false);
	});

	it('leaves a diagram that was ready alone, and keeps no timer for it', async () => {
		const { deps, seen, timers, l1 } = processorDeps();
		const probe = await processBlock(deps, seen, SOURCE, { load: false });
		l1.set(probe.spec.key, artifact());

		const cached = await processBlock(deps, seen, SOURCE, { el: printed().createDiv() });
		await cached.settled;
		await flush();
		expect(cached.el.querySelector('svg')).not.toBeNull();
		expect(timers.outstanding).toBe(0);
	});

	it('is the only thing the budget applies to', async () => {
		const { deps, seen, timers } = processorDeps();
		const block = await processBlock(deps, seen, SOURCE);
		const done = tracked(block.settled);
		await flush();
		timers.advance(TOTAL * 2);
		await flush();
		expect(done.done).toBe(false);
	});

	it('lets its blocks past the queue depth cap: the budget bounds them instead', async () => {
		const { deps, seen } = processorDeps();
		const exported = await processBlock(deps, seen, SOURCE, { el: printed().createDiv(), load: false });
		expect(exported.spec.uncapped).toBe(true);
	});
});

describe('the settings a block is built with', () => {
	/**
	 * Obsidian calls onExternalSettingsChange when Sync, iCloud or git rewrites data.json, and the
	 * plugin replaces its settings object there. The processor had been handed the OLD object once,
	 * at load, and the settings tab writes into the new one — so neither the synced values nor any
	 * later change in the tab reached a diagram until Obsidian restarted.
	 */
	it('are the ones the plugin holds now, not the ones it was loaded with', async () => {
		const { deps, seen, settings } = processorDeps();
		const before = await processBlock(deps, seen, SOURCE, { load: false });
		expect(before.spec.options.fast).toBe(false);

		settings.current = { ...settings.current, fast: true, colors: 'paper' };
		const after = await processBlock(deps, seen, SOURCE, { load: false });

		expect(after.spec.options.fast).toBe(true);
		expect(after.spec.options.presentation.colors).toBe('paper');
		// Fast and full renders are different artifacts, so the key moves with the setting.
		expect(after.spec.key).not.toBe(before.spec.key);
	});
});

describe("a block's cache key", () => {
	/**
	 * The key holds what the engine draws, OUTPUT_REVISION, not which build of the worker drew it:
	 * an engine that only got faster finds every diagram where the one before it left it
	 * (internal/DECISIONS.md D20).
	 */
	it('is the same whichever build of the engine is running', async () => {
		const one = processorDeps();
		const other = processorDeps({ host: { ...one.deps.host, id: 'another-build' } });
		const a = await processBlock(one.deps, one.seen, SOURCE, { load: false });
		const b = await processBlock(other.deps, other.seen, SOURCE, { load: false });
		expect(b.spec.key).toBe(a.spec.key);
	});
});

describe('whether a block waits for typing to pause', () => {
	/**
	 * Only a block of a note being typed in waits for the debounce (internal/DECISIONS.md D22), and
	 * the note is the one the block is rendered from: the one Live Preview's editor, a Reading view
	 * or an embed names as its source. It is asked as the block is made, and answered at its cache
	 * miss (D39).
	 */
	it('is asked of the note the block is rendered from as it is made, and answered once the cache has missed', async () => {
		const asked: string[] = [];
		const answered: string[] = [];
		const { deps, seen } = processorDeps({
			editing: (notePath) => {
				asked.push(notePath);
				return {
					by: (key) => {
						answered.push(key);
						return { editing: false };
					},
					shown: () => () => undefined,
					rested: () => undefined,
				};
			},
		});
		const { spec } = await processBlock(deps, seen, SOURCE, { path: 'Folder/Typed in.md' });
		expect(asked).toEqual(['Folder/Typed in.md']);
		await flush();
		expect(answered).toEqual([spec.key]);
	});

	it('is told the text the block shows in its note, from its load to its unload', async () => {
		const events: string[] = [];
		const { deps, seen } = processorDeps({
			editing: (notePath) => ({
				by: () => ({ editing: false }),
				shown: (key) => {
					events.push(`shown ${notePath} ${key}`);
					return () => events.push(`unloaded ${key}`);
				},
				rested: () => undefined,
			}),
		});
		const { spec, parent } = await processBlock(deps, seen, SOURCE, { path: 'note.md' });
		expect(events).toEqual([`shown note.md ${spec.key}`]);
		parent.unload();
		parent.unload();
		expect(events).toEqual([`shown note.md ${spec.key}`, `unloaded ${spec.key}`]);
	});

	/*
	 * A block made again of a diagram the cache does not hold joins no compile: that its note showed
	 * it before an edit does not make it a block made again unchanged (block/edits.ts).
	 */
	it('is told whether the cache holds the diagram each time the block comes to rest', async () => {
		const rests: [string, boolean][] = [];
		const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
		const answers: Record<string, () => Promise<TexResult>> = {
			drawn: () => Promise.resolve({ svg: SVG, log: [], durationMs: 1 }),
			failed: () => Promise.reject(new TexError('tex-error', [], 'Undefined control sequence')),
		};
		const { deps, seen, l1 } = processorDeps({
			editing: () => ({
				by: () => ({ editing: false }),
				shown: () => () => undefined,
				rested: (key, cached) => rests.push([key, cached]),
			}),
			queue: {
				submit: (_key: string, job: TexJobSpec) =>
					(
						answers[/% (\w+)/.exec(job.source)?.[1] ?? ''] ?? (() => new Promise(() => undefined))
					)(),
				release: () => undefined,
			} as never,
			observe: (_el, onChange) => onChange(true),
		});
		for (const { source, cached } of [
			{ source: '\\draw (0,0) -- (1,1); % drawn', cached: true },
			{ source: '\\draw (0,0) -- (2,1); % failed', cached: false },
			{ source: '%!tikz nocache\n\\draw (0,0) -- (3,1); % drawn', cached: false },
			{ source: '%!tikz lazy=manual\n\\draw (0,0) -- (4,1); % none', cached: false },
		]) {
			rests.length = 0;
			const { spec } = await processBlock(deps, seen, source, { path: 'note.md' });
			await vi.waitFor(() => expect(rests.at(-1), source).toEqual([spec.key, cached]));
		}
		// Found in the cache.
		const probe = await processBlock(deps, seen, SOURCE, { load: false });
		l1.set(probe.spec.key, artifact());
		rests.length = 0;
		const hit = await processBlock(deps, seen, SOURCE, { path: 'note.md' });
		expect(rests).toEqual([[hit.spec.key, true]]);
	});

	/*
	 * The orders of things below are Obsidian's, read in its 1.14.4 bundle. A view that loads a note
	 * replaces its editor's state (`set(text, true)` → setState), which no update listener hears, so
	 * loading a note is no edit; Live Preview builds a code block's widget, and calls the processor,
	 * in the update of the keystroke that remade it, and triggers `editor-change` from that update's
	 * listener, after it; a view whose file is written by something else re-reads it and redraws
	 * after the `modify`. Here with the plugin's own RecentEdits, and a cache read held until the
	 * test lets it miss, as IndexedDB answers later.
	 */
	function startingNote(
		opts: {
			/** What the engine says of a diagram: by default, nothing ever. */
			engine?: ((source: string) => Promise<TexResult>) | undefined;
			debounceMs?: number | undefined;
		} = {},
	) {
		const clock = { now: 10_000 };
		const edits = new RecentEdits(1000, () => clock.now);
		const reads: ((found: undefined) => void)[] = [];
		const { cache } = tieredCache();
		const held = {
			...(cache as unknown as Record<string, unknown>),
			lookup: () => new Promise<undefined>((resolve) => reads.push(resolve)),
		} as unknown as typeof cache;
		const submitted: string[] = [];
		const { deps } = processorDeps({
			cache: held,
			budgets: { ...budgetsFor(false), debounceMs: opts.debounceMs ?? 5 },
			editing: (notePath) => edits.making(notePath),
			// In view at once: what decides the wait is the debounce alone.
			observe: (_el, onChange) => onChange(true),
			queue: {
				submit: (key: string, job: TexJobSpec) => {
					submitted.push(key);
					return opts.engine?.(job.source) ?? new Promise(() => undefined);
				},
				release: () => undefined,
			} as never,
		});
		const processor = createProcessor(deps);
		/**
		 * Obsidian hands the processor the blocks of one section of `note.md`, in the run of code under
		 * way. Its view unloads them with the parent this returns.
		 */
		const make = (...sources: string[]) => {
			const parent = new Component();
			parent.load();
			const ctx = {
				sourcePath: 'note.md',
				addChild: (child: Component) => parent.addChild(child),
				getSectionInfo: () => null,
			} as unknown as MarkdownPostProcessorContext;
			for (const source of sources) void processor(source, document.body.createDiv(), ctx);
			return parent;
		};
		/** The cache reads under way miss. */
		const miss = async () => {
			for (const resolve of reads.splice(0)) resolve(undefined);
			await flush();
		};
		return { edits, clock, make, miss, submitted };
	}

	it('does not wait when the note was written after the block was made, as at startup', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		// Obsidian starts and its view of the note makes the block: no edit.
		make(SOURCE);
		await flush();
		// Then something writes the note, Sync bringing another device's change or a plugin acting at
		// startup, while the block's cache read is under way.
		clock.now += 40;
		edits.changed('note.md');
		clock.now += 40;
		await miss();
		// Queued at once: 0.2.1-beta.5 counted the write and waited the debounce.
		expect(submitted).toHaveLength(1);
	});

	it('does not wait either for an editor that names no note, after the block was made', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		make(SOURCE);
		await flush();
		clock.now += 40;
		edits.changed(null);
		await miss();
		expect(submitted).toHaveLength(1);
	});

	it('waits while typing in Live Preview, where the keystroke is reported after its widget was made', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		// One keystroke's update: the widget, and so the block, first; then editor-change.
		make(SOURCE);
		edits.changed('note.md');
		await flush();
		clock.now += 40;
		await miss();
		expect(submitted).toHaveLength(0);
		await vi.waitFor(() => expect(submitted).toHaveLength(1));
	});

	it('waits for a block made after its note changed: a second pane, a Reading view, a sync while it is shown', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		edits.changed('note.md');
		// Remade 10 ms later, or up to 200 while a Reading view is still parsing.
		clock.now += 200;
		make(SOURCE);
		await flush();
		await miss();
		expect(submitted).toHaveLength(0);
		await vi.waitFor(() => expect(submitted).toHaveLength(1));
	});

	it('waits for a block made after a change and before another, whichever came last', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		edits.changed('note.md');
		clock.now += 100;
		make(SOURCE);
		await flush();
		clock.now += 100;
		edits.changed('note.md');
		await miss();
		expect(submitted).toHaveLength(0);
	});

	/*
	 * At a start on the desktop, once the note's blocks had been made and queued, Obsidian reset its
	 * syntax highlighting, which replaces the note's first character with itself, and `editor-change`
	 * named the note; Live Preview then made every block again, 103 ms later, and beta.6 made those
	 * wait for the debounce (internal/DECISIONS.md D40). Live Preview lets the first blocks go in one
	 * of two ways, read in the 1.14.4 bundle: in the update that makes them again, which another
	 * plugin's processor registered once the workspace is ready causes; or in the reset's own update,
	 * past a syntax tree not parsed that far yet, and the parse that follows makes them again.
	 */
	const OTHER = '\\begin{tikzpicture}\\draw (0,0) rectangle (1,1);\\end{tikzpicture}';
	const TYPED = '\\begin{tikzpicture}\\draw (0,0) circle (2);\\end{tikzpicture}';

	it('does not wait for the blocks Live Preview makes again after Obsidian’s own edit at a start', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		const first = [make(SOURCE), make(OTHER)];
		await flush();
		await miss();
		expect(submitted).toHaveLength(2);
		clock.now += 50;
		edits.changed('note.md');
		await flush();
		clock.now += 103;
		for (const block of first) block.unload();
		make(SOURCE);
		make(OTHER);
		await flush();
		await miss();
		// Queued at once: beta.6 waited the debounce.
		expect(submitted).toHaveLength(4);
	});

	it('nor for those it lets go in the edit’s own update and makes again with the parse', async () => {
		const { edits, clock, make, miss, submitted } = startingNote();
		const first = [make(SOURCE), make(OTHER)];
		await flush();
		await miss();
		clock.now += 50;
		for (const block of first) block.unload();
		edits.changed('note.md');
		await flush();
		clock.now += 100;
		make(SOURCE);
		make(OTHER);
		await flush();
		await miss();
		expect(submitted).toHaveLength(4);
	});

	/*
	 * Typing still waits wherever a diagram is drawn while its text changes (D22): a Reading view
	 * beside the editor or an embed of the note, each made again 10 ms after the keystroke, letting the
	 * old block go; a second pane in Live Preview, which makes its block in the update that tells it of
	 * the keystroke, and reports that update as an edit of its own; a sync writing the note on screen.
	 */
	const typing = [
		{
			name: 'a Reading view beside the editor, or an embed of the note',
			edit: (edits: RecentEdits) => edits.changed('note.md'),
			remade: () => undefined,
		},
		{
			name: 'a second pane in Live Preview',
			edit: (edits: RecentEdits) => edits.changed('note.md'),
			remade: (edits: RecentEdits) => edits.changed('note.md'),
		},
		{
			name: 'a sync writing the note',
			edit: (edits: RecentEdits) => edits.changed('note.md', 'modify'),
			remade: () => undefined,
		},
	];
	for (const view of typing) {
		it(`still waits for a text that was typed: ${view.name}`, async () => {
			const { edits, clock, make, miss, submitted } = startingNote();
			const shown = make(SOURCE);
			await flush();
			await miss();
			expect(submitted).toHaveLength(1);
			clock.now += 5000;
			view.edit(edits);
			await flush();
			clock.now += 10;
			shown.unload();
			make(TYPED);
			view.remade(edits);
			await flush();
			await miss();
			expect(submitted).toHaveLength(1);
			await vi.waitFor(() => expect(submitted).toHaveLength(2));
		});
	}

	/*
	 * Reading view makes again every block of the section being typed in, and a section is a whole
	 * list, callout or blockquote; Live Preview makes again a callout it draws as one widget. A diagram
	 * there that the cache does not hold, one on an error card or one never cached, joins no compile
	 * when it is made again: taken for one the note already showed, it was compiled at every keystroke
	 * beside it. It waits, as in beta.6, and the next keystroke lets it go.
	 */
	const ERRORED = '\\begin{tikzpicture}\\draw (0,0) node {\\undefinedmacro};\\end{tikzpicture}';
	const NEVER_CACHED = `%!tikz nocache\n${OTHER}`;
	const DRAWN = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
	const typedAt = (i: number) => `\\begin{tikzpicture}\\draw (0,0) circle (${i + 3});\\end{tikzpicture}`;
	for (const beside of [
		{ name: 'an error card', source: ERRORED },
		{ name: 'a diagram never cached', source: NEVER_CACHED },
	]) {
		for (const view of typing) {
			it(`waits again for ${beside.name} in the section typed in: ${view.name}`, async () => {
				const { edits, clock, make, miss, submitted } = startingNote({
					engine: (source) =>
						source.includes('undefinedmacro')
							? Promise.reject(new TexError('tex-error', [], 'Undefined control sequence'))
							: source.includes('rectangle')
								? Promise.resolve({ svg: DRAWN, log: [], durationMs: 1 })
								: new Promise(() => undefined),
					// Longer than the test: a block that waits is never asked for.
					debounceMs: 60_000,
				});
				let section = make(beside.source, typedAt(0));
				await flush();
				await miss();
				await flush();
				expect(submitted).toHaveLength(2);
				const asked = submitted[0];
				clock.now += 5000;
				for (let i = 1; i <= 5; i++) {
					clock.now += 150;
					view.edit(edits);
					await flush();
					clock.now += 10;
					section.unload();
					section = make(beside.source, typedAt(i));
					view.remade(edits);
					await flush();
					await miss();
				}
				// Not asked for again while typing: it was, once a keystroke, before this.
				expect(submitted.filter((key) => key === asked)).toHaveLength(1);
				expect(submitted).toHaveLength(2);
				section.unload();
			});
		}
	}
});

describe('a note opened on a cold engine', () => {
	/*
	 * The iPhone's note after a start, through the processor, the block and its machine and the real
	 * queue (internal/DECISIONS.md D40): four blocks made in the order of the note, whose cache reads
	 * answer in another order, the top one's last. The engine is still starting: the runner never says
	 * the engine has a job until the test does.
	 */
	const nameOf = (source: string): string | undefined => /% (#\d)/.exec(source)?.[1];
	const SVG_OUT = '<svg xmlns="http://www.w3.org/2000/svg"/>';

	function note() {
		const reads = new Map<string, (found: undefined) => void>();
		const { cache } = tieredCache();
		const held = {
			...(cache as unknown as Record<string, unknown>),
			lookup: (key: string) => new Promise<undefined>((resolve) => reads.set(key, resolve)),
		} as unknown as typeof cache;
		const ran: string[] = [];
		const running = new Map<string, () => void>();
		const finish = new Map<string, (result: TexResult) => void>();
		const queue = new RenderQueue<TexJobSpec, TexResult>({
			concurrency: 1,
			depthCap: 16,
			timers: { setTimeout: () => 0, clearTimeout: () => undefined },
			startupMs: 30_000,
			run: (job, _signal, onRunning) => {
				const name = nameOf(job.source) ?? '?';
				ran.push(name);
				running.set(name, onRunning);
				return new Promise((resolve) => finish.set(name, resolve));
			},
		});
		const { deps, seen } = processorDeps({
			cache: held,
			queue,
			observe: (_el, onChange) => onChange(true),
		});
		const processor = createProcessor(deps);
		const make = (name: string) => {
			const parent = new Component();
			parent.load();
			const ctx = {
				sourcePath: 'note.md',
				addChild: (child: Component) => parent.addChild(child),
				getSectionInfo: () => null,
			} as unknown as MarkdownPostProcessorContext;
			void processor(`\\draw (0,0) -- (1,1); % ${name}`, document.body.createDiv(), ctx);
		};
		/** The block's cache read answers: not cached. */
		const miss = async (name: string) => {
			const key = seen.find((spec) => nameOf(spec.source) === name)?.key;
			const read = key === undefined ? undefined : reads.get(key);
			if (read === undefined) throw new Error(`no read for ${name}`);
			read(undefined);
			await flush();
		};
		return { make, miss, ran, running, finish };
	}

	it('starts the diagram at the top first, whichever cache read answered first', async () => {
		const n = note();
		for (const name of ['#1', '#2', '#3', '#4']) n.make(name);
		await flush();
		for (const name of ['#2', '#3', '#4']) await n.miss(name);
		expect(n.ran).toEqual(['#2']);
		// The top one's read answers while the engine is still starting: #2 gives up its slot.
		await n.miss('#1');
		expect(n.ran).toEqual(['#2', '#1']);
		n.running.get('#1')?.();
		n.finish.get('#1')?.({ svg: SVG_OUT, log: [], durationMs: 1 });
		await flush();
		expect(n.ran).toEqual(['#2', '#1', '#2']);
	});

	it('leaves the engine the diagram it has, and starts the one at the top next', async () => {
		const n = note();
		for (const name of ['#1', '#2', '#3', '#4']) n.make(name);
		await flush();
		for (const name of ['#2', '#3', '#4']) await n.miss(name);
		n.running.get('#2')?.();
		await n.miss('#1');
		expect(n.ran).toEqual(['#2']);
		n.finish.get('#2')?.({ svg: SVG_OUT, log: [], durationMs: 1 });
		await flush();
		expect(n.ran).toEqual(['#2', '#1']);
	});
});

describe('the engine', () => {
	it('is started by a block that is not cached, and not by one that is', async () => {
		const startEngine = vi.fn();
		const { deps, seen, l1 } = processorDeps({ startEngine });
		const cached = await processBlock(deps, seen, SOURCE, { load: false });
		l1.set(cached.spec.key, artifact());

		await processBlock(deps, seen, SOURCE);
		await flush();
		expect(startEngine).not.toHaveBeenCalled();

		await processBlock(deps, seen, `${SOURCE}%`);
		await flush();
		expect(startEngine).toHaveBeenCalledTimes(1);
	});
});

describe('a block in a list item', () => {
	/**
	 * Live Preview hands the processor the block's lines as they stand in the note, the list's
	 * indentation on every one; Reading view hands it the code block's content, which the markdown
	 * parser has taken that indentation off. The source keeps leading whitespace into the key, so
	 * the one diagram was compiled once for each view, and the commands, which derive Reading
	 * view's key, said a diagram on screen in Live Preview had not been rendered.
	 */
	for (const block of BLOCKS.filter((b) => b.livePreview === 'lines')) {
		it(`is the same diagram in Live Preview as in Reading view: ${block.name}`, async () => {
			const { deps, seen } = processorDeps();
			const reading = await processBlock(deps, seen, block.reading, { load: false });
			const { source, section } = livePreviewWidget(block.note);
			const live = await processBlock(deps, seen, source, { load: false, section });

			expect(live.spec.key).toBe(reading.spec.key);
			expect(live.spec.source).toBe(reading.spec.source);
		});
	}

	it('applies a %!tikz line written at the list indentation, in both views', async () => {
		const block = BLOCKS.find((b) => b.reading.startsWith('%!tikz'));
		if (!block) throw new Error('a block with a directive');
		const { deps, seen } = processorDeps();
		const { source, section } = livePreviewWidget(block.note);
		const live = await processBlock(deps, seen, source, { load: false, section });

		expect(live.spec.options.baked.border).toBe('2pt');
		expect(live.spec.source.startsWith('\\begin{tikzpicture}\n')).toBe(true);
	});

	it('keeps what it is handed when the section is not the block itself', async () => {
		// Reading view describes the whole list, whose inner lines are not the block; an embed or an
		// export has no section at all. Either way the text is already Reading view's.
		const { deps, seen } = processorDeps();
		const block = BLOCKS[0];
		if (!block) throw new Error('a block');
		const list = block.note.split('\n');
		const section = {
			text: block.note,
			lineStart: list.indexOf('- The square:'),
			lineEnd: list.indexOf('- Next step.'),
		};
		const handed = '  \\draw (0,0);\n    \\draw (1,1);';
		const framed = await processBlock(deps, seen, handed, { load: false, section });
		const bare = await processBlock(deps, seen, handed, { load: false });

		expect(framed.spec.source).toBe(handed);
		expect(bare.spec.source).toBe(handed);
	});

	it('keeps the indentation of a top-level body, so it is not the unindented block', async () => {
		// A fence at the left margin has nothing in front of it to take off: its body's
		// indentation is the block's own, as Reading view leaves it.
		const { deps, seen } = processorDeps();
		const indented = 'Text.\n\n```tikz\n  \\draw (0,0);\n```\n';
		const { source, section } = livePreviewWidget(indented);
		const live = await processBlock(deps, seen, source, { load: false, section });
		const unindented = await processBlock(deps, seen, '\\draw (0,0);', { load: false });

		expect(live.spec.source).toBe('  \\draw (0,0);');
		expect(live.spec.key).not.toBe(unindented.spec.key);
	});
});

describe('rendersDifferently', () => {
	const base: TikzSettings = { ...DEFAULT_SETTINGS };

	it('is true for every setting a block on screen is built from', () => {
		const changes: Partial<TikzSettings>[] = [
			{ colors: 'paper' },
			{ lazy: 'manual' },
			{ svgo: 'off' },
			{ fast: true },
			{ sourceHandling: 'legacy' },
			{ preamblePath: 'preamble.tex' },
			{ autoPreambleName: '' },
			{ preflight: false },
		];
		for (const change of changes) expect(rendersDifferently(base, { ...base, ...change })).toBe(true);
	});

	it('is false for the ones that only matter to the next compile, so typing a time limit redraws nothing', () => {
		const changes: Partial<TikzSettings>[] = [
			{ timeoutSeconds: 30 },
			{ captureLog: false },
			{ importLegacyCache: false },
		];
		for (const change of changes) expect(rendersDifferently(base, { ...base, ...change })).toBe(false);
		expect(rendersDifferently(base, { ...base })).toBe(false);
	});
});

describe('the time limit from the settings', () => {
	it('gives every diagram that long on a desktop', async () => {
		const { deps, seen, settings } = processorDeps();
		settings.current = { ...settings.current, timeoutSeconds: 60 };
		const { spec } = await processBlock(deps, seen, SOURCE, { load: false });
		expect(spec.timeoutMs).toBe(60_000);
	});

	it('is not capped on a phone, the slower device, where a raised limit is wanted most', async () => {
		const { deps, seen, settings } = processorDeps({ budgets: budgetsFor(true) });
		settings.current = { ...settings.current, timeoutSeconds: 60 };
		const { spec } = await processBlock(deps, seen, SOURCE, { load: false });
		expect(spec.timeoutMs).toBe(60_000);
	});

	it('may be lowered on a phone', async () => {
		const { deps, seen, settings } = processorDeps({ budgets: budgetsFor(true) });
		settings.current = { ...settings.current, timeoutSeconds: 5 };
		const { spec } = await processBlock(deps, seen, SOURCE, { load: false });
		expect(spec.timeoutMs).toBe(5_000);
	});

	it("does not clamp a block's own timeout= — it is what the timeout card tells the user to write", async () => {
		const { deps, seen } = processorDeps({ budgets: budgetsFor(true) });
		const { spec } = await processBlock(deps, seen, `%!tikz timeout=60\n${SOURCE}`, { load: false });
		expect(spec.timeoutMs).toBe(60_000);
	});
});

describe('the optimisation a block asks for', () => {
	it('is its own svgo= when it has one, and the setting when it does not', async () => {
		const { deps, seen, settings } = processorDeps();
		settings.current = { ...settings.current, svgo: 'targeted' };
		const fromSetting = await processBlock(deps, seen, SOURCE, { load: false });
		const fromBlock = await processBlock(deps, seen, `%!tikz svgo=off\n${SOURCE}`, { load: false });

		expect(fromSetting.spec.svgo).toBe('targeted');
		expect(fromBlock.spec.svgo).toBe('off');
		expect(fromBlock.spec.key).not.toBe(fromSetting.spec.key);
	});
});

describe('"Render all diagrams in this note"', () => {
	/**
	 * It renders the note into an off-screen holder and waits for every block. With lazy rendering
	 * on — the default — each block there waited for the viewport, and the holder is never in it:
	 * a real IntersectionObserver reports it as not intersecting, which also cancels the 2 s escape
	 * hatch. Nothing was submitted, the wait never ended, and the "Rendering diagrams…" notice
	 * stayed up for good.
	 */
	const holder = (): HTMLElement => document.body.createDiv({ cls: OFFSCREEN_CLASS });

	it('renders its blocks without waiting to be seen', async () => {
		const { deps, seen } = processorDeps();
		const { spec } = await processBlock(deps, seen, SOURCE, { el: holder().createDiv(), load: false });
		expect(spec.options.presentation.lazy).toBe('off');
	});

	it('renders a lazy=manual block too: the command is the user asking for it', async () => {
		const { deps, seen } = processorDeps();
		const { spec } = await processBlock(deps, seen, `%!tikz lazy=manual\n${SOURCE}`, {
			el: holder().createDiv(),
			load: false,
		});
		expect(spec.options.presentation.lazy).toBe('off');
	});

	it('leaves a block on the page as lazy as it was', async () => {
		const { deps, seen } = processorDeps();
		const { spec } = await processBlock(deps, seen, SOURCE, { load: false });
		expect(spec.options.presentation.lazy).toBe('on');
	});

	it('is not cut short by the queue depth cap: "all" means all, and the run can be stopped', async () => {
		// Past the cap (16 on a phone) a block rests on a "Render diagram" button, so a long note
		// came back from "Render all diagrams" with its last diagrams unrendered.
		const { deps, seen } = processorDeps();
		const warm = await processBlock(deps, seen, SOURCE, { el: holder().createDiv(), load: false });
		const page = await processBlock(deps, seen, SOURCE, { load: false });
		expect(warm.spec.uncapped).toBe(true);
		expect(page.spec.uncapped).toBe(false);
	});

	it('submits a block in the holder even though nothing ever reports it visible', async () => {
		const submit = vi.fn(() => new Promise(() => undefined));
		const { deps, seen } = processorDeps({
			queue: { submit, release: () => undefined } as never,
			budgets: { ...budgetsFor(false), debounceMs: 0 },
		});
		await processBlock(deps, seen, SOURCE, { el: holder().createDiv() });
		await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
	});
});

describe('BlockTally', () => {
	it('counts the blocks inside its container by how they came to rest, and nothing outside it', () => {
		const container = document.body.createDiv();
		const tally = new BlockTally(container);
		const report = (state: BlockOutcome['state'], inside = true): void =>
			tally.watch(inside ? container.createDiv() : document.body.createDiv())?.({ state });

		report('ok');
		report('cached');
		report('error');
		report('manual');
		report('ok', false);
		// A block that never came to rest — cancelled with the run — counts as not rendered.
		tally.watch(container.createDiv());

		expect(tally.counts()).toEqual({ ok: 2, failed: 3 });
	});

	it('goes by the last word from each block, so a retried failure that mounts is not counted twice', () => {
		const container = document.body.createDiv();
		const tally = new BlockTally(container);
		const report = tally.watch(container.createDiv());
		report?.({ state: 'error', message: 'x' });
		report?.({ state: 'ok' });
		expect(tally.counts()).toEqual({ ok: 1, failed: 0 });
	});
});

describe('an error TeX found in a preamble file', () => {
	/**
	 * The whole path from the vault to the card, short of the engine: TeX's `l.2` behind a preamble
	 * of three lines is two lines above the block (engine/worker-host.ts turns it into -1), and the
	 * card has to say which file that line is in, at that file's own line.
	 */
	it('is shown on the card from the file, at the line it was written on', async () => {
		const app = fakeApp({
			'preambles/global.tex': '\\usetikzlibrary{arrows.meta}\n\\undefinedmacro',
			'tikz-preamble.tex': '\\tikzset{box/.style={draw}}',
		});
		const submit = vi.fn(
			(
				_key: string,
				_job: unknown,
				_band: number,
				_timeout: number,
				opts?: { onStart?: () => void },
			) => {
				opts?.onStart?.();
				return Promise.reject(
					new TexError(
						'tex-error',
						['! Undefined control sequence.'],
						'Undefined control sequence.',
						-1,
					),
				);
			},
		);
		const { deps, seen, settings } = processorDeps(
			{
				queue: { submit, release: () => undefined } as never,
				budgets: { ...budgetsFor(false), debounceMs: 0 },
			},
			app,
		);
		settings.current = { ...DEFAULT_SETTINGS, preamblePath: 'preambles/global.tex' };

		const { spec, settled, el } = await processBlock(deps, seen, `%!tikz lazy=off\n${SOURCE}`);
		expect(spec.preambleLines).toEqual([
			{ path: 'preambles/global.tex', line: 1 },
			{ path: 'preambles/global.tex', line: 2 },
			{ path: 'tikz-preamble.tex', line: 1 },
		]);

		await settled;
		expect(el.querySelector('.tikzjax-error-where')?.textContent).toBe(
			'In the preamble: preambles/global.tex, line 2',
		);
		expect(el.querySelector('.tikzjax-error-source span')?.textContent).toBe('2 | \\undefinedmacro\n');
	});

	/**
	 * Through the worker's own input (engine-src/document.ts) and the host's arithmetic: TeX blames
	 * the line `\begin{document}` is on, as it does for an `\AtBeginDocument` hook that fails. Behind
	 * a file that ends in a newline — most saved files do — that line holds nothing of the user's,
	 * and the card named a line of the file past its end, with nothing on it. With `border=` too,
	 * whose `\standaloneconfig` the plugin writes on that same line.
	 */
	for (const directives of ['%!tikz lazy=off', '%!tikz lazy=off border=2pt']) {
		it(`names \\begin{document} for an error on its line (${directives})`, async () => {
			const app = fakeApp({ 'tikz-preamble.tex': '\\usepackage{amsmath}\n' });
			const submit = vi.fn(
				(
					_key: string,
					job: TexJobSpec,
					_band: number,
					_timeout: number,
					opts?: { onStart?: () => void },
				) => {
					opts?.onStart?.();
					const input = buildInput(job.source, job.texOptions);
					const at =
						input.text.split('\n').findIndex((line) => line.endsWith('\\begin{document}')) + 1;
					// engine/worker-host.ts: a line of the whole input, made a line of the block.
					const line = at - input.bodyLine + 1;
					return Promise.reject(
						new TexError(
							'tex-error',
							['! Undefined control sequence.'],
							'Undefined control sequence.',
							line,
						),
					);
				},
			);
			const { deps, seen } = processorDeps(
				{
					queue: { submit, release: () => undefined } as never,
					budgets: { ...budgetsFor(false), debounceMs: 0 },
				},
				app,
			);

			const { settled, el } = await processBlock(deps, seen, `${directives}\n${SOURCE}`);
			await settled;
			expect(submit).toHaveBeenCalled();
			expect(el.querySelector('.tikzjax-error-where')?.textContent).toBe(
				'TeX stopped before reaching the diagram, at \\begin{document}: in something a package or the preamble runs as the document starts.',
			);
			expect(el.querySelector('.tikzjax-error-source')).toBeNull();
		});
	}

	/**
	 * A preamble file whose last line is a comment and that ends without a newline: what the worker
	 * and the plugin write after it, the `\standaloneconfig` of `border=` and `\begin{document}`, goes
	 * on a line of its own, where TeX reads it, and not on the comment's (internal/DECISIONS.md D35).
	 */
	for (const directives of ['%!tikz lazy=off', '%!tikz lazy=off border=2pt']) {
		it(`writes nothing of its own on a comment the preamble ends with (${directives})`, async () => {
			const app = fakeApp({ 'tikz-preamble.tex': '\\usepackage{amsmath}\n% end of preamble' });
			let text = '';
			const submit = vi.fn(
				(
					_key: string,
					job: TexJobSpec,
					_band: number,
					_timeout: number,
					opts?: { onStart?: () => void },
				) => {
					opts?.onStart?.();
					text = buildInput(job.source, job.texOptions).text;
					return Promise.reject(new TexError('tex-error', [], 'stop', 1));
				},
			);
			const { deps, seen } = processorDeps(
				{
					queue: { submit, release: () => undefined } as never,
					budgets: { ...budgetsFor(false), debounceMs: 0 },
				},
				app,
			);
			const { settled } = await processBlock(deps, seen, `${directives}\n${SOURCE}`);
			await settled;
			const lines = text.split('\n');
			const comment = lines.indexOf('% end of preamble');
			expect(comment).toBeGreaterThan(-1);
			expect(lines[comment + 1]).toMatch(
				directives.includes('border')
					? /^\\standaloneconfig\{border=2pt\}\\begin\{document\}$/
					: /^\\begin\{document\}$/,
			);
		});
	}

	it('leaves a block with no preamble files nothing to look up', async () => {
		const { deps, seen } = processorDeps();
		const { spec } = await processBlock(deps, seen, SOURCE, { load: false });
		expect(spec.preambleLines).toEqual([]);
	});
});

describe('the preamble files a block depends on', () => {
	it('are tracked while the block is on the page, and not after', async () => {
		const app = fakeApp({ 'tikz-preamble.tex': '\\usetikzlibrary{arrows}' });
		const { deps, seen } = processorDeps({}, app);
		const block = await processBlock(deps, seen, SOURCE);
		expect(deps.preamble.trackedFiles()).toEqual(['tikz-preamble.tex']);

		block.parent.unload();
		expect(deps.preamble.trackedFiles()).toEqual([]);
	});
});
