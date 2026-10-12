/**
 * The comment at the top of main.js and styles.css.
 *
 * Those two files and manifest.json are all the community store installs, so NOTICE and
 * vendor/LICENSES/ never reach a user's vault. The banner is the one place where someone holding
 * the plugin can learn where its source is — the GPL asks for that — and that it embeds a TeX
 * engine, TeX packages, fonts and JavaScript libraries, each under its own licence. It used to say
 * "Source: see the repository" without naming one.
 *
 * It also carries, in full, the notices that have to travel with every copy: the MIT, ISC, BSD and
 * zlib licences of the libraries bundled into main.js — whose own comments the build strips
 * (`legalComments: 'none'`) — and the BaKoMa licence, which asks for its notice and the location of
 * the original fonts in every copy of the converted faces, and those are in both files. The texts
 * are vendor/LICENSES/'s, which test/notice.test.ts keeps in step with what is bundled.
 *
 * Made of the manifest's name and version, fixed text and those files, never a date, a hash or a
 * path: a release has to be reproducible byte for byte from its tag, and the version is part of
 * the tag. The licence texts are read with LF line endings, whatever the checkout has.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REPOSITORY = 'https://github.com/JackVinati/tikzjax-next';

/** A licence text as committed, with LF line endings and no trailing blank lines. */
function licence(root, ...path) {
	return readFileSync(join(root, 'vendor', 'LICENSES', ...path), 'utf8')
		.split('\r\n')
		.join('\n')
		.trimEnd();
}

/** One notice under a heading, the way each follows the next in the banner. */
const section = (title, text) => ['', `---- ${title} ----`, '', text];

export function banners(root) {
	const { name, version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
	const notice = `${REPOSITORY}/blob/${version}/NOTICE`;
	const fonts = section('The fonts: BaKoMa Fonts Collection', licence(root, 'BaKoMa.txt'));

	const libraries = readdirSync(join(root, 'vendor', 'LICENSES', 'npm'))
		.filter((file) => file.endsWith('.txt'))
		.sort()
		.flatMap((file) => section(file.slice(0, -'.txt'.length), licence(root, 'npm', file)));

	const js = [
		`${name} ${version}`,
		`Source: ${REPOSITORY}`,
		'',
		'This file embeds a TeX engine derived from drgrice1/web2js and drgrice1/tikzjax,',
		'which are licensed GPL-3.0-or-later, so this bundle is GPL-3.0-or-later as well.',
		'It also embeds TeX packages, fonts and JavaScript libraries under their own',
		'licences. NOTICE lists every one of them with its licence:',
		`  ${notice}`,
		'',
		'The JavaScript libraries bundled into this file, and the fonts it embeds, ask for',
		'their notices to accompany every copy. They follow, in full.',
		...libraries,
		...fonts,
	];
	const css = [
		`${name} ${version}, GPL-3.0-or-later. Source: ${REPOSITORY}`,
		'The @font-face rules below embed TeX fonts as WOFF2, under the licences listed in',
		`  ${notice}`,
		'The fonts are converted from the BaKoMa Fonts Collection, whose licence follows.',
		...fonts,
	];

	const comment = (lines) => `/*\n${lines.join('\n')}\n*/\n`;
	return { js: comment(js), css: comment(css) };
}
