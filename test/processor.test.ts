// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { artifact, processBlock, processorDeps } from './stubs/processor';
import { fakeApp } from './stubs/vault';
import { BlockTally, OFFSCREEN_CLASS, rendersDifferently } from '../src/block/processor';
import type { BlockOutcome } from '../src/block/render-child';
import { budgetsFor } from '../src/platform/budgets';
import { DEFAULT_SETTINGS, type TikzSettings } from '../src/settings/schema';

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

	it('is clamped to the platform budget on a phone, as the setting says', async () => {
		// The setting syncs between devices: a limit chosen for a desktop's heavy diagrams would let
		// one diagram hold the phone's only engine, and its memory, for that long.
		const { deps, seen, settings } = processorDeps({ budgets: budgetsFor(true) });
		settings.current = { ...settings.current, timeoutSeconds: 60 };
		const { spec } = await processBlock(deps, seen, SOURCE, { load: false });
		expect(spec.timeoutMs).toBe(budgetsFor(true).timeoutMs);
	});

	it('may still be lowered on a phone', async () => {
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
