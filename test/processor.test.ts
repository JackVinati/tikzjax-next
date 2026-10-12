// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { processBlock, processorDeps } from './stubs/processor';
import { rendersDifferently } from '../src/block/processor';
import { budgetsFor } from '../src/platform/budgets';
import { DEFAULT_SETTINGS, type TikzSettings } from '../src/settings/schema';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

const SOURCE = '\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}';

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
