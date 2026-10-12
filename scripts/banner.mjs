/**
 * The comment at the top of main.js and styles.css.
 *
 * Those two files and manifest.json are all the community store installs, so NOTICE and
 * vendor/LICENSES/ never reach a user's vault. The banner is the one place where someone holding
 * the plugin can learn where its source is — the GPL asks for that — and that it embeds a TeX
 * engine, TeX packages, fonts and JavaScript libraries, each under its own licence. It used to say
 * "Source: see the repository" without naming one.
 *
 * Made of the manifest's name and version and fixed text, never a date, a hash or a path: a
 * release has to be reproducible byte for byte from its tag, and the version is part of the tag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPOSITORY = 'https://github.com/JackVinati/tikzjax-next';

export function banners(root) {
	const { name, version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
	const notice = `${REPOSITORY}/blob/${version}/NOTICE`;

	const js = [
		`${name} ${version}`,
		`Source: ${REPOSITORY}`,
		'',
		'This file embeds a TeX engine derived from drgrice1/web2js and drgrice1/tikzjax,',
		'which are licensed GPL-3.0-or-later, so this bundle is GPL-3.0-or-later as well.',
		'It also embeds TeX packages, fonts and JavaScript libraries under their own',
		'licences. NOTICE lists every one of them with its licence:',
		`  ${notice}`,
	];
	const css = [
		`${name} ${version}, GPL-3.0-or-later. Source: ${REPOSITORY}`,
		'The @font-face rules below embed TeX fonts as WOFF2, under the licences listed in',
		`  ${notice}`,
	];

	const comment = (lines) => `/*\n${lines.join('\n')}\n*/\n`;
	return { js: comment(js), css: comment(css) };
}
