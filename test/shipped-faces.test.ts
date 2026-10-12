/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/*
 * What the committed engine ships for the fonts that do not render, pinned so that the fixture
 * notes, the comments and the README stay true of it. They once said "the fonts and their metrics
 * ship" for \mathfrak, \mathscr and siunitx alike, and two of the three faces do not exist: what
 * needs fixing differs with that. A rebuild that changes any of this fails here, and the notes
 * have to change with it.
 */

// Vite's glob, not node:fs, as in preflight.test.ts: only the file NAMES are used.
const names = (paths: Record<string, unknown>, suffix: string): Set<string> =>
	new Set(Object.keys(paths).map((path) => path.slice(path.lastIndexOf('/') + 1, -suffix.length)));

const FACES = names(import.meta.glob('../engine-build/out/dist/fonts/*.woff2'), '.woff2');
const METRICS = names(import.meta.glob('../engine-build/out/dist/tex_files/*.tfm.gz'), '.tfm.gz');

describe('the font faces the engine ships', () => {
	it('has a real font set to test against', () => {
		expect(FACES.size).toBeGreaterThan(100);
		expect(FACES.has('cmr10')).toBe(true);
	});

	it('ships the Euler face for \\mathfrak, so only the converter stands in its way', () => {
		expect(METRICS.has('eufm10')).toBe(true);
		expect(FACES.has('eufm10')).toBe(true);
	});

	it('ships no rsfs face for \\mathscr, so it needs one built as well as a converter fix', () => {
		expect(METRICS.has('rsfs10')).toBe(true);
		for (const size of ['5', '7', '10']) expect(FACES.has(`rsfs${size}`)).toBe(false);
	});

	it('ships no TS1 face, which is why the worker draws TS1 symbols from the math fonts', () => {
		expect(METRICS.has('tcrm1000')).toBe(true);
		expect([...FACES].filter((face) => face.startsWith('tc'))).toEqual([]);
		// What engine-src/ts1-shim.ts draws them with, measured on the ts1-symbols fixture.
		for (const face of ['cmsy10', 'cmsy7', 'cmmi10', 'cmr7']) expect(FACES.has(face)).toBe(true);
	});
});
