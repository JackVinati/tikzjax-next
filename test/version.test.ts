import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { manifestVersion, VERSION_DEFINE, versionDefine } from '../scripts/plugin-version.mjs';
import { BUILT_VERSION, outOfStep, versionPair } from '../src/platform/version';
import { readText } from './support/read-text';

/*
 * The plugin compares the version main.js was built as with the one manifest.json says, to tell a
 * device on which Obsidian Sync Standard copied a new manifest.json and left the old main.js, over
 * its 5 MB limit (internal/DECISIONS.md D34). Such a device says it runs the new release, offers no
 * update, and runs the old code. A build that said its files were out of step when they were not
 * would tell everyone who installed it to reinstall it, so the first thing held here is that the
 * build bakes in exactly the version manifest.json says.
 */

/** Relative to the project root, which is where vitest runs. */
const ROOT = '.';

/** src/platform/version.ts as the build bundles it into main.js: with the version, or without. */
function built(define: Record<string, string>): { BUILT_VERSION: string | null } {
	const [out] = buildSync({
		entryPoints: ['src/platform/version.ts'],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'VERSION',
		target: 'es2022',
		minify: true,
		define,
	}).outputFiles;
	if (!out) throw new Error('esbuild produced no output');
	return new Function(`${out.text}\nreturn VERSION;`)() as { BUILT_VERSION: string | null };
}

describe('the version main.js is built as', () => {
	it("is manifest.json's, as the build defines it, so that a normal build never warns", () => {
		const manifest = manifestVersion(ROOT);
		expect(manifest).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
		const version = built(versionDefine(ROOT)).BUILT_VERSION;
		expect(version).toBe(manifest);
		expect(outOfStep(version, manifest)).toBe(false);
	});

	it('is what the build gives esbuild, from manifest.json and nothing else', () => {
		expect(versionDefine(ROOT)).toEqual({ [VERSION_DEFINE]: JSON.stringify(manifestVersion(ROOT)) });
		expect(readText('scripts/esbuild.config.mjs')).toMatch(/\bdefine: versionDefine\(root\),/);
		expect(readText('src/platform/version.ts')).toContain(`typeof ${VERSION_DEFINE} === 'string'`);
	});

	it('is unknown where nothing defined it, as in these tests, and that never warns either', () => {
		expect(built({}).BUILT_VERSION).toBeNull();
		expect(BUILT_VERSION).toBeNull();
		expect(outOfStep(BUILT_VERSION, '0.2.1')).toBe(false);
	});
});

describe('outOfStep', () => {
	it('is true only when both versions are known and differ', () => {
		expect(outOfStep('0.2.1-beta.3', '0.2.1')).toBe(true);
		expect(outOfStep('0.2.1', '0.2.1-beta.3')).toBe(true);
		expect(outOfStep('0.2.1', '0.2.1')).toBe(false);
		expect(outOfStep(null, '0.2.1')).toBe(false);
		expect(outOfStep('0.2.1', '')).toBe(false);
		expect(outOfStep('0.2.1', undefined)).toBe(false);
	});

	it('names the pair main.js first, as data.json keeps it', () => {
		expect(versionPair('0.2.1-beta.3', '0.2.1')).toBe('0.2.1-beta.3 → 0.2.1');
	});
});
