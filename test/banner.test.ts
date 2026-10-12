/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { banners, REPOSITORY } from '../scripts/banner.mjs';

/*
 * main.js, styles.css and manifest.json are all the community store installs, so the repository's
 * NOTICE and vendor/LICENSES/ never reach a vault. The banner at the top of the two built files is
 * the only place a user, or anyone they pass the plugin on to, can learn where the source is and
 * what is embedded under which licence. It used to say "Source: see the repository", and name none.
 */

/** Relative to the project root, which is where vitest runs (vitest.config.ts lives there). */
const { js, css } = banners('.');

describe('the banner on the built files', () => {
	it('names the source repository and the release it was built as', () => {
		expect(REPOSITORY).toBe('https://github.com/JackVinati/tikzjax-next');
		for (const banner of [js, css]) {
			expect(banner).toContain(REPOSITORY);
			expect(banner).toMatch(/TikZJax Next \d+\.\d+\.\d+/);
		}
		expect(js).not.toContain('see the repository');
	});

	it('points at the notices for everything embedded, at that release', () => {
		const version = /TikZJax Next (\d+\.\d+\.\d+)/.exec(js)?.[1] ?? '';
		for (const banner of [js, css]) expect(banner).toContain(`${REPOSITORY}/blob/${version}/NOTICE`);
		expect(js).toContain('GPL-3.0-or-later');
	});

	/**
	 * The MIT, ISC, BSD and zlib licences of what is bundled into main.js, and the BaKoMa licence of
	 * the fonts in both files, each ask for their notice to appear in every copy — and the build
	 * strips the libraries' own comments (`legalComments: 'none'`), while NOTICE and vendor/LICENSES
	 * never reach a vault. So the texts travel in the banner, LF whatever the checkout.
	 */
	it('carries the notice of every bundled library, and of the fonts, in full', () => {
		const licences = import.meta.glob<string>(
			['../vendor/LICENSES/npm/*.txt', '../vendor/LICENSES/BaKoMa.txt'],
			{
				query: '?raw',
				import: 'default',
				eager: true,
			},
		);
		const lf = (text: string): string => text.split('\r\n').join('\n').trimEnd();
		const npm = Object.entries(licences).filter(([path]) => path.includes('/npm/'));
		expect(npm.length).toBeGreaterThanOrEqual(5);

		for (const [path, text] of npm) expect(js, path).toContain(lf(text));
		const bakoma = lf(licences['../vendor/LICENSES/BaKoMa.txt'] ?? 'missing');
		expect(js).toContain(bakoma);
		expect(css).toContain(bakoma);
	});

	it('is a comment and nothing else, so it changes no behaviour', () => {
		for (const banner of [js, css]) {
			expect(banner.startsWith('/*\n')).toBe(true);
			expect(banner.endsWith('*/\n')).toBe(true);
			expect(banner.slice(2, -3)).not.toContain('*/');
		}
	});

	it('is the same on every build: no date, no hash, no path from this machine', () => {
		expect(banners('.')).toEqual({ js, css });
		for (const banner of [js, css]) {
			expect(banner).not.toMatch(
				/\b20\d\d-\d\d-\d\d\b|[0-9a-f]{12,}|(?:^|\s)[A-Za-z]:[\\/]|\/home\/|\/Users\//,
			);
			expect(banner).not.toContain('\r');
		}
	});
});
