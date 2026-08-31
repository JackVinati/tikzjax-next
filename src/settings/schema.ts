import type { ColorMode, LazyMode, SvgoMode } from '../types';

/** Bumped when a migration is added. Older data.json is read forward, never discarded. */
export const SETTINGS_VERSION = 1;

export interface TikzSettings {
	settingsVersion: number;

	// --- colour -------------------------------------------------------------------------------
	colors: ColorMode;

	// --- rendering ----------------------------------------------------------------------------
	lazy: LazyMode;
	svgo: SvgoMode;
	/** Preset: no SVGO, no mount-time measurement, no pre-flight lint, one priority band up. */
	fast: boolean;
	/** 0 uses the platform budget. A user value is clamped to it on mobile. */
	timeoutSeconds: number;
	concurrency: number;

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
	concurrency: 0,
	sourceHandling: 'corrected',
	preamblePath: '',
	autoPreambleName: 'tikz-preamble.tex',
	captureLog: true,
	preflight: true,
	importLegacyCache: true,
};

/**
 * The settings that change the STORED BYTES, and nothing else. See docs/DESIGN.md §6.1.
 *
 * This list is deliberately narrow and enumerated rather than "hash the settings object". The
 * consequence is the one users will actually feel: switching theme, resizing a diagram, changing
 * alignment or adjusting a timeout costs ZERO recompiles, because none of them are in here. The
 * shipped plugin cannot offer that, because it bakes `currentColor` and `var(--background-primary)`
 * into the cached artifact.
 *
 * Two unit tests assert this — sensitivity to each included input, and insensitivity to theme and
 * scale — so it is a tested property rather than a hope.
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

	merged.settingsVersion = Math.max(SETTINGS_VERSION, Number(data['settingsVersion']) || 0);
	return merged;
}
