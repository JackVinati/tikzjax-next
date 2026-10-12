/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * NOTICE is how the plugin meets the notice obligations of everything it embeds, and it is written
 * by hand while the things it describes are not: the npm closure comes from the lockfile, the TeX
 * files and fonts from the engine build. It fell behind both — `buffer` brought `base64-js` and
 * `ieee754` into main.js and NOTICE never named them, and the fonts were credited under licences
 * other than the BaKoMa terms the shipped files actually carry.
 *
 * These compare it with what ships, so the next engine rebuild or dependency bump that adds
 * something fails here instead of going out unattributed.
 */

// Vite's glob rather than node:fs, like preflight.test.ts: the tests typecheck without Node's types.
// The texts are inlined when the file is transformed; the listings use only the keys, so nothing in
// them is loaded.
const texts = import.meta.glob<string>(
	[
		'../NOTICE',
		'../package-lock.json',
		'../engine-build/out/tex-versions.txt',
		'../vendor/LICENSES/BaKoMa.txt',
	],
	{ query: '?raw', import: 'default', eager: true },
);
const texFiles = Object.keys(import.meta.glob('../engine-build/out/dist/tex_files/*.gz'));
const fonts = Object.keys(import.meta.glob('../engine-build/out/dist/fonts/*.woff2'));
const repository = Object.keys(
	import.meta.glob(['../internal/**', '../vendor/**', '../engine-build/**', '../engine-src/*']),
);

const notice = texts['../NOTICE'] ?? '';
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Names as whole words, so `pgf` is not found inside `pgfplots`. */
function names(name: string): boolean {
	const escaped = name.split('.').join('\\.');
	return new RegExp(`(^|[^A-Za-z0-9@_.-])${escaped}($|[^A-Za-z0-9@_-])`, 'm').test(notice);
}

describe('NOTICE', () => {
	it('names every npm package bundled into main.js, with its licence text in vendor/LICENSES', () => {
		const lock = JSON.parse(texts['../package-lock.json'] ?? '{}') as {
			packages: Record<string, { dev?: boolean; devOptional?: boolean; license?: string }>;
		};
		const bundled = Object.entries(lock.packages)
			.filter(([path, entry]) => path !== '' && entry.dev !== true && entry.devOptional !== true)
			.map(([path, entry]) => ({ name: path.slice(path.lastIndexOf('node_modules/') + 13), entry }));
		expect(bundled.length).toBeGreaterThan(0);

		for (const { name, entry } of bundled) {
			expect(names(name), `${name} is bundled but not in NOTICE`).toBe(true);
			// GPL packages are covered by the GPL texts already there; anything else carries its own
			// copyright line, which is the part a permissive licence asks to be reproduced.
			if (entry.license?.startsWith('GPL') === true) continue;
			const file = `../vendor/LICENSES/npm/${basename(name)}.txt`;
			expect(repository.includes(file), `${file.slice(3)} is missing`).toBe(true);
		}
	});

	it('names every TeX package and class the engine bundles or has in its format', () => {
		const bundled = texFiles.map((path) => basename(path).slice(0, -'.gz'.length));
		// Loaded before \dump, so in core.dump rather than tex_files, and shipped all the same.
		const preloaded = (texts['../engine-build/out/tex-versions.txt'] ?? '')
			.split(/\r?\n/)
			.map((line) => line.split(/\s+/)[0] ?? '');
		const all = [...new Set([...bundled, ...preloaded])].filter((f) => /\.(sty|cls)$/.test(f));
		expect(all.length).toBeGreaterThan(30);

		const missing = all.filter((f) => !names(f));
		expect(missing, 'bundled but not in NOTICE').toEqual([]);
	});

	it('names every font family the plugin ships, and the BaKoMa terms they carry', () => {
		const families = [...new Set(fonts.map((path) => basename(path).replace(/\d*\.woff2$/, '')))];
		expect(families.length).toBeGreaterThan(10);

		const missing = families.filter((f) => !names(f));
		expect(missing, 'shipped but not in NOTICE').toEqual([]);

		// The BaKoMa licence asks for its notice and the location of the original fonts in "all copies
		// of modified fonts and related documentation".
		const licence = texts['../vendor/LICENSES/BaKoMa.txt'] ?? '';
		expect(licence).toContain('Copyright (C) 1994, 1995, Basil K. Malyshev. All Rights Reserved.');
		expect(licence).toContain('http://www.ctan.org/tex-archive/fonts/cm/ps-type1/bakoma');
		expect(notice).toContain('http://www.ctan.org/tex-archive/fonts/cm/ps-type1/bakoma');
	});

	it('points at files that exist', () => {
		for (const m of notice.matchAll(/\b((?:internal|vendor|engine-build|engine-src)\/[\w./-]*\w)/g)) {
			const path = `../${m[1] ?? ''}`;
			const exists = repository.some((file) => file === path || file.startsWith(`${path}/`));
			expect(exists, path.slice(3)).toBe(true);
		}
		expect(notice).not.toMatch(/\bdocs\//);
	});
});
