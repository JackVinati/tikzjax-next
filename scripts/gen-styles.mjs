/**
 * Builds styles.css, and splits the TeX fonts.
 *
 * The shipped plugin's styles.css is 4,791,337 bytes of which ~15 KB is real CSS; the rest is 140
 * base64 TrueType @font-face rules that Obsidian parses into the CSSOM at launch whether or not
 * any note contains a diagram. On iOS that is a launch cost paid by every user for a feature most
 * of them are not using at that moment (upstream #111, #91, #74).
 *
 * So: a small core of faces ships in styles.css, and the rest becomes a cold string in main.js
 * injected per-Document on FIRST MOUNT. The distinction matters — a cache hit mounts without
 * rendering, and a PDF export mounts cached diagrams almost exclusively, so keying injection on
 * "first render" would ship PDFs with fallback glyphs.
 *
 * Externalising them as sibling files is not an option: Obsidian's community installer fetches
 * only main.js, manifest.json and styles.css.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Faces that appear in almost every diagram: upright/italic/bold roman, math italic, math symbols
 * and large operators, at the three standard optical sizes. Everything else — bold math, sans,
 * typewriter, AMS symbols, script, fraktur, and the many optical sizes — is cold.
 */
const CORE_FACES = new Set([
	'cmr5',
	'cmr7',
	'cmr10',
	'cmmi5',
	'cmmi7',
	'cmmi10',
	'cmsy5',
	'cmsy7',
	'cmsy10',
	'cmex10',
	'cmbx10',
	'cmti10',
]);

const faceRule = (family, woff2) =>
	`@font-face{font-family:${family};src:url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2');font-display:block}`;

/**
 * `font-display: block` rather than the default `auto`: these faces carry mathematical glyphs, and
 * a fallback rendering of a maths symbol is not a slightly-wrong letter, it is a wrong diagram.
 * Blocking briefly beats showing something incorrect.
 */
export function buildStyles(root) {
	const distFonts = join(root, 'engine-build', 'out', 'dist', 'fonts');
	const base = readFileSync(join(root, 'src', 'styles', 'base.css'), 'utf8');

	if (!existsSync(distFonts)) {
		return { css: base, coldCss: '', core: 0, cold: 0, coreBytes: base.length, coldBytes: 0 };
	}

	const core = [];
	const cold = [];

	for (const file of readdirSync(distFonts).sort()) {
		if (!file.endsWith('.woff2')) continue;
		const family = file.slice(0, -'.woff2'.length);
		const rule = faceRule(family, readFileSync(join(distFonts, file)));
		(CORE_FACES.has(family) ? core : cold).push(rule);
	}

	const css = `${base}\n/* Core TeX faces. The remaining ${cold.length} are injected on first mount; see scripts/gen-styles.mjs. */\n${core.join('\n')}\n`;
	const coldCss = cold.join('\n');

	writeFileSync(join(root, 'styles.css'), css);

	return {
		css,
		coldCss,
		core: core.length,
		cold: cold.length,
		coreBytes: css.length,
		coldBytes: coldCss.length,
	};
}

/** esbuild plugin exposing the cold faces to the plugin as `virtual:fonts`. */
export function fontsPlugin(root, coldCss) {
	return {
		name: 'virtual-fonts',
		setup(build) {
			build.onResolve({ filter: /^virtual:fonts$/ }, () => ({
				path: 'virtual:fonts',
				namespace: 'virtual',
			}));
			build.onLoad({ filter: /^virtual:fonts$/, namespace: 'virtual' }, () => ({
				contents: `export const COLD_FONT_CSS = ${JSON.stringify(coldCss)};\n`,
				loader: 'js',
			}));
		},
	};
}
