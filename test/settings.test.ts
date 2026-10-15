import { describe, expect, it } from 'vitest';
import {
	artifactRevision,
	DEFAULT_SETTINGS,
	migrateSettings,
	SETTINGS_VERSION,
	type TikzSettings,
} from '../src/settings/schema';

/**
 * One value per setting that differs from its default.
 *
 * Typed as the whole settings object on purpose: a new setting does not compile here until someone
 * gives it a value, and the test below then forces the question that matters for the cache — does
 * it change the stored bytes or not?
 */
const CHANGED: TikzSettings = {
	settingsVersion: SETTINGS_VERSION + 1,
	colors: 'invert',
	lazy: 'manual',
	svgo: 'off',
	fast: true,
	timeoutSeconds: 45,
	secondEngine: false,
	preambleSnapshots: false,
	jitNoticeShown: true,
	outOfStepNoticeShown: '0.2.1-beta.3 → 0.2.1',
	sourceHandling: 'legacy',
	preamblePath: 'tex/preamble.tex',
	autoPreambleName: '',
	captureLog: false,
	preflight: false,
	importLegacyCache: false,
};

/** The settings that change what a render stores, and so must move the cache key. */
const BYTE_AFFECTING: ReadonlyArray<keyof TikzSettings> = ['svgo', 'fast', 'sourceHandling'];

describe('artifactRevision', () => {
	const base = artifactRevision(DEFAULT_SETTINGS);

	it('is deterministic', () => {
		expect(artifactRevision({ ...DEFAULT_SETTINGS })).toBe(base);
	});

	for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof TikzSettings>) {
		const changed = { ...DEFAULT_SETTINGS, [key]: CHANGED[key] } as TikzSettings;

		if (BYTE_AFFECTING.includes(key)) {
			it(`changes with ${key}, which changes the stored bytes`, () => {
				expect(CHANGED[key]).not.toEqual(DEFAULT_SETTINGS[key]);
				expect(artifactRevision(changed)).not.toBe(base);
			});
		} else {
			// The colour mode is the one that matters most: switching Settings > Colours promises to
			// recompile nothing, which holds only because every mode stores the same artifact.
			it(`ignores ${key}, which is applied at mount time or never reaches the artifact`, () => {
				expect(CHANGED[key]).not.toEqual(DEFAULT_SETTINGS[key]);
				expect(artifactRevision(changed)).toBe(base);
			});
		}
	}

	it('tells every combination of the byte-affecting settings apart', () => {
		const seen = new Set<string>();
		for (const svgo of ['preset', 'targeted', 'off'] as const) {
			for (const fast of [false, true]) {
				for (const sourceHandling of ['corrected', 'legacy'] as const) {
					seen.add(artifactRevision({ ...DEFAULT_SETTINGS, svgo, fast, sourceHandling }));
				}
			}
		}
		expect(seen.size).toBe(12);
	});
});

describe('migrateSettings', () => {
	it('starts from the defaults when there is nothing usable to read', () => {
		for (const raw of [undefined, null, 'colors=invert', 42, true]) {
			expect(migrateSettings(raw), JSON.stringify(raw)).toEqual(DEFAULT_SETTINGS);
		}
	});

	it('hands back a copy, so editing the settings never edits the defaults', () => {
		const settings = migrateSettings(undefined);
		settings.colors = 'invert';
		settings.preamblePath = 'x.tex';
		expect(DEFAULT_SETTINGS.colors).toBe('adapt');
		expect(DEFAULT_SETTINGS.preamblePath).toBe('');
	});

	it('fills in settings an older data.json does not have', () => {
		const settings = migrateSettings({ settingsVersion: 1, colors: 'paper' });
		expect(settings).toEqual({ ...DEFAULT_SETTINGS, colors: 'paper' });
	});

	/**
	 * The old plugin's whole data.json was `{ invertColorsInDarkMode }`. Inverting recoloured TeX's
	 * black into the theme's text colour, which is what adapt does; not inverting kept the engine's
	 * colours, which is preserve.
	 */
	it("maps the previous plugin's one setting onto the colour mode", () => {
		expect(migrateSettings({ invertColorsInDarkMode: true }).colors).toBe('adapt');
		expect(migrateSettings({ invertColorsInDarkMode: false }).colors).toBe('preserve');
	});

	it('lets an explicit colour mode win over the old flag', () => {
		expect(migrateSettings({ invertColorsInDarkMode: false, colors: 'paper' }).colors).toBe('paper');
	});

	/**
	 * With Sync, a newer device can write keys and a settingsVersion this build has never seen. The
	 * older device writes its settings back whole, so whatever it drops here is gone on every device.
	 */
	it('keeps keys it does not understand, and a newer settingsVersion, for the write-back', () => {
		const future = {
			...DEFAULT_SETTINGS,
			settingsVersion: SETTINGS_VERSION + 5,
			paletteFromTheme: { accent: true },
			renderOnSave: 'always',
		};
		const settings = migrateSettings(future) as TikzSettings & Record<string, unknown>;

		expect(settings.settingsVersion).toBe(SETTINGS_VERSION + 5);
		expect(settings['paletteFromTheme']).toEqual({ accent: true });
		expect(settings['renderOnSave']).toBe('always');
		expect(JSON.parse(JSON.stringify(settings))).toEqual(future);
	});

	/**
	 * Every data.json written so far holds `"concurrency": 0`, from the defaults. Nothing has read it
	 * since one worker runs one job at a time (main.ts), and a key this build no longer has is not a
	 * newer device's to keep: it is ours, retired.
	 */
	it('drops the concurrency setting, which nothing reads any more', () => {
		const settings = migrateSettings({ ...DEFAULT_SETTINGS, concurrency: 2 });
		expect('concurrency' in settings).toBe(false);
		expect('concurrency' in DEFAULT_SETTINGS).toBe(false);
	});

	/**
	 * 0.2.1-beta.3 and beta.4 could show the notice that TeX seems to run without the JIT on a phone
	 * that had it, its probe fooled by a slow processor (internal/DECISIONS.md D38), and the notice is
	 * shown once only. A data.json from before the probe that settles a second later shows it again,
	 * once, where that probe finds the JIT off; one written since keeps what it says.
	 */
	it('lets the JIT notice be shown once more to a vault that may have been shown it wrongly', () => {
		expect(migrateSettings({ settingsVersion: 1, jitNoticeShown: true }).jitNoticeShown).toBe(false);
		expect(migrateSettings({ jitNoticeShown: true }).jitNoticeShown).toBe(false);
		expect(migrateSettings({ settingsVersion: 2, jitNoticeShown: true }).jitNoticeShown).toBe(true);
		expect(migrateSettings({ settingsVersion: 7, jitNoticeShown: true }).jitNoticeShown).toBe(true);
		const once = migrateSettings({ settingsVersion: 1, jitNoticeShown: true });
		once.jitNoticeShown = true;
		expect(migrateSettings(JSON.parse(JSON.stringify(once))).jitNoticeShown).toBe(true);
	});

	it('never moves settingsVersion backwards, or below this build', () => {
		expect(migrateSettings({}).settingsVersion).toBe(SETTINGS_VERSION);
		expect(migrateSettings({ settingsVersion: 0 }).settingsVersion).toBe(SETTINGS_VERSION);
		expect(migrateSettings({ settingsVersion: 'two' }).settingsVersion).toBe(SETTINGS_VERSION);
	});

	it('is idempotent', () => {
		for (const raw of [
			undefined,
			{ invertColorsInDarkMode: false },
			{ invertColorsInDarkMode: true, lazy: 'off', unknown: [1, 2] },
			{ ...CHANGED },
		]) {
			const once = migrateSettings(raw);
			expect(migrateSettings(once), JSON.stringify(raw)).toEqual(once);
		}
	});
});
