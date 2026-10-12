import { describe, expect, it } from 'vitest';
import {
	artifactRevision,
	DEFAULT_SETTINGS,
	migrateSettings,
	SETTINGS_VERSION,
} from '../src/settings/schema';
import type { TikzSettings } from '../src/settings/schema';

/**
 * src/settings/schema.ts said two unit tests asserted what artifactRevision is sensitive to, and
 * none existed: key.test.ts passes a literal string where the revision goes. These are those tests,
 * and the ones migrateSettings needed as well — it is the function that decides whether a Sync'd
 * data.json written by a newer device survives being read by an older one.
 */

const withSetting = <K extends keyof TikzSettings>(key: K, value: TikzSettings[K]): TikzSettings => ({
	...DEFAULT_SETTINGS,
	[key]: value,
});

describe('artifactRevision', () => {
	const base = artifactRevision(DEFAULT_SETTINGS);

	it('is deterministic', () => {
		expect(artifactRevision({ ...DEFAULT_SETTINGS })).toBe(base);
	});

	// Each of these changes the bytes that are stored, so a cached artifact built under the other
	// value is wrong and must not be served.
	it('changes with the settings that change the stored bytes', () => {
		expect(artifactRevision(withSetting('sourceHandling', 'legacy'))).not.toBe(base);
		expect(artifactRevision(withSetting('fast', true))).not.toBe(base);
	});

	// The promise the README makes: switching theme, timing out, rendering lazily or not, logging or
	// not — none of it recompiles anything. Every one of these is presentation or behaviour, never
	// the bytes of a diagram.
	it('ignores everything that only changes presentation or behaviour', () => {
		const unchanged: TikzSettings[] = [
			withSetting('colors', 'invert'),
			withSetting('colors', 'preserve'),
			withSetting('lazy', 'off'),
			withSetting('lazy', 'manual'),
			withSetting('timeoutSeconds', 30),
			withSetting('concurrency', 3),
			withSetting('captureLog', false),
			withSetting('preflight', false),
			withSetting('importLegacyCache', false),
			// A preamble reaches the key through the files it resolves to — their paths and contents,
			// in BakedOptions.depHashes — not through these settings, so a vault where they name no
			// file, or a file a diagram never reads, keeps its keys.
			withSetting('preamblePath', 'latex/diagrams.tex'),
			withSetting('autoPreambleName', ''),
		];
		for (const settings of unchanged) expect(artifactRevision(settings)).toBe(base);
	});
});

describe('migrateSettings', () => {
	it('returns the defaults for nothing, or for something that is not an object', () => {
		for (const raw of [undefined, null, 'colors', 42, true]) {
			expect(migrateSettings(raw)).toEqual(DEFAULT_SETTINGS);
		}
	});

	it('fills in every key a stored file does not have', () => {
		const migrated = migrateSettings({ colors: 'paper' });
		expect(migrated).toEqual({ ...DEFAULT_SETTINGS, colors: 'paper' });
	});

	it('returns a fresh object, never the shared defaults', () => {
		const migrated = migrateSettings(undefined);
		migrated.colors = 'invert';
		expect(DEFAULT_SETTINGS.colors).toBe('adapt');
	});

	// The original plugin had one setting. Its meaning maps onto the colour modes, and a user who
	// had turned inversion off expects their diagrams to keep their colours.
	it('maps the original plugin’s invertColorsInDarkMode', () => {
		expect(migrateSettings({ invertColorsInDarkMode: true }).colors).toBe('adapt');
		expect(migrateSettings({ invertColorsInDarkMode: false }).colors).toBe('preserve');
	});

	it('lets an explicit colours setting win over the old flag', () => {
		expect(migrateSettings({ invertColorsInDarkMode: false, colors: 'paper' }).colors).toBe('paper');
	});

	// With Sync, a newer device can write keys and a settingsVersion this build has never seen. They
	// must survive the round trip through an older device, or mixed-version installs quietly destroy
	// each other's settings.
	it('keeps keys it does not know, and a newer settingsVersion, for the write-back', () => {
		const fromNewerDevice = {
			...DEFAULT_SETTINGS,
			settingsVersion: SETTINGS_VERSION + 3,
			futureOption: 'x',
		};
		const migrated = migrateSettings(fromNewerDevice) as TikzSettings & { futureOption?: string };
		expect(migrated.futureOption).toBe('x');
		expect(migrated.settingsVersion).toBe(SETTINGS_VERSION + 3);
		expect(JSON.parse(JSON.stringify(migrated))).toMatchObject({ futureOption: 'x' });
	});

	it('never moves settingsVersion backwards, and brings an old file up to this one', () => {
		expect(migrateSettings({ settingsVersion: 0 }).settingsVersion).toBe(SETTINGS_VERSION);
		expect(migrateSettings({}).settingsVersion).toBe(SETTINGS_VERSION);
		expect(migrateSettings({ settingsVersion: 'garbage' }).settingsVersion).toBe(SETTINGS_VERSION);
	});

	it('is idempotent', () => {
		const once = migrateSettings({ invertColorsInDarkMode: false, futureOption: 1 });
		expect(migrateSettings(once)).toEqual(once);
	});
});
