import type { ColorMode, LazyMode, SvgoMode } from '../types';

/** Bumped when a migration is added. Older data.json is read forward, never discarded. */
export const SETTINGS_VERSION = 1;

export interface TikzSettings {
	settingsVersion: number;

	// --- colour -------------------------------------------------------------------------------
	colors: ColorMode;

	// --- rendering ----------------------------------------------------------------------------
	lazy: LazyMode;
	/** `preset` is SVGO and then the targeted transform; SVGO is not bundled, so today it is `targeted`. */
	svgo: SvgoMode;
	/**
	 * Preset: no SVG optimisation, no pre-flight lint, one priority band up. Not "no mount-time
	 * measurement": the engine's frame is an inch short of the drawing, so that would clip it.
	 */
	fast: boolean;
	/** 0 uses the platform budget. A user value applies as it is, on every device. */
	timeoutSeconds: number;
	/**
	 * Let a computer run a second engine while uncached diagrams queue up (DECISIONS.md D24). A phone
	 * or tablet runs one whatever this says, and so does a computer short of memory.
	 */
	secondEngine: boolean;
	/**
	 * Start a diagram from the run an earlier one with the same preamble saved at the end of its
	 * \begin{document} (internal/DECISIONS.md D32). Not in the settings tab: it is there to be turned
	 * off, in data.json, should a diagram ever draw differently from a saved run than from the start,
	 * without waiting for a release, and a release can turn it off for everyone the same way.
	 */
	preambleSnapshots: boolean;

	// --- what the plugin has told this vault, not in the settings tab -------------------------------
	/**
	 * The notice that TeX runs without the JIT, which makes it about twenty times slower, has been
	 * shown (internal/DECISIONS.md D33). It is shown once, on an iPhone or iPad, the first time an
	 * engine starts without one; false shows it again.
	 */
	jitNoticeShown: boolean;
	/**
	 * The versions of main.js and manifest.json, as `<main.js> → <manifest.json>`, that the notice
	 * that they are out of step was last shown for (src/platform/version.ts, D34), so that it is shown
	 * once for each pair. Synced with the rest of data.json, so another device out of step in the same
	 * way is not told again; its diagnostics view still says so.
	 */
	outOfStepNoticeShown: string;

	// --- source -------------------------------------------------------------------------------
	/**
	 * 'corrected' preserves blank lines (i.e. \par) and strips real U+00A0; 'legacy' reproduces the
	 * old behaviour byte for byte. The old code deleted every blank line, so fixing it CHANGES THE
	 * RENDERED OUTPUT of existing diagrams — hence a flag rather than a silent improvement.
	 */
	sourceHandling: 'corrected' | 'legacy';
	preamblePath: string;
	/** Walk up from the note looking for this file, PR #100's idea. Empty disables it. */
	autoPreambleName: string;

	// --- diagnostics --------------------------------------------------------------------------
	captureLog: boolean;
	preflight: boolean;

	// --- cache --------------------------------------------------------------------------------
	/** Read the previous plugin's localForage store on a miss, so upgrading recompiles nothing. */
	importLegacyCache: boolean;
}

export const DEFAULT_SETTINGS: TikzSettings = {
	settingsVersion: SETTINGS_VERSION,
	colors: 'adapt',
	lazy: 'on',
	svgo: 'preset',
	fast: false,
	timeoutSeconds: 0,
	secondEngine: true,
	preambleSnapshots: true,
	jitNoticeShown: false,
	outOfStepNoticeShown: '',
	sourceHandling: 'corrected',
	preamblePath: '',
	autoPreambleName: 'tikz-preamble.tex',
	captureLog: true,
	preflight: true,
	importLegacyCache: true,
};

/**
 * The settings that change the STORED BYTES, and nothing else. See internal/DESIGN.md §6.1.
 *
 * This list is deliberately narrow and enumerated rather than "hash the settings object". The
 * consequence is the one users will actually feel: switching theme, resizing a diagram, changing
 * alignment or adjusting a timeout costs ZERO recompiles, because none of them are in here. The
 * shipped plugin cannot offer that, because it bakes `currentColor` and `var(--background-primary)`
 * into the cached artifact.
 *
 * test/settings.test.ts asserts both halves — each setting listed here moves the revision, and
 * every other setting leaves it alone, the colour mode included — so it is a tested property rather
 * than a hope. A new setting does not compile there until it is put in one half or the other. Theme
 * and scale are not settings at all; test/key.test.ts keeps presentation out of the key.
 */
export function artifactRevision(settings: TikzSettings): string {
	return JSON.stringify({
		svgo: settings.svgo,
		fast: settings.fast,
		sourceHandling: settings.sourceHandling,
	});
}

/**
 * Read data.json forward.
 *
 * Must be idempotent and FORWARD-TOLERANT: with Sync enabled, a newer device can write a
 * settingsVersion this build has never seen, and the older device must preserve the keys it does
 * not understand rather than dropping them on write-back. That is the standard way plugin settings
 * get silently destroyed on mixed-version installs.
 */
export function migrateSettings(raw: unknown): TikzSettings {
	if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
	const data = raw as Record<string, unknown>;

	const merged: TikzSettings = { ...DEFAULT_SETTINGS, ...(data as Partial<TikzSettings>) };

	// v0 -> v1: the old plugin had exactly one setting.
	if (typeof data['invertColorsInDarkMode'] === 'boolean' && data['colors'] === undefined) {
		merged.colors = data['invertColorsInDarkMode'] ? 'adapt' : 'preserve';
	}

	// Retired, and ours to drop — unlike a key from a newer device, which is kept. Never in the
	// settings tab, yet in every data.json from the defaults, and unread since one worker runs one
	// job at a time: a second queue slot only queued a job inside the worker with its clock running.
	delete (merged as TikzSettings & { concurrency?: unknown }).concurrency;

	merged.settingsVersion = Math.max(SETTINGS_VERSION, Number(data['settingsVersion']) || 0);
	return merged;
}
