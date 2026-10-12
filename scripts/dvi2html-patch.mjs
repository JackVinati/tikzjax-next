/**
 * The one change the build makes to @drgrice1/dvi2html, applied wherever dvi2html is bundled: the
 * shipped worker (scripts/engine-assets.mjs) and every script that renders through the engine.
 *
 * dvi2html's TFM reader skips the last character of every font. The reader takes the font's
 * character range from its header, where `ec` — the largest character code — is inclusive, and
 * counts it that way itself (`number_of_chars = ec - bc + 1`). Then it reads the metrics with
 *
 *     for (let c = this.smallest_character_code; c < this.largest_character_code; ++c)
 *
 * which stops one short. All 112 fonts in its built-in table end on a character with a real
 * width, and in every one of them that character has no metrics, so a DVI that sets it fails with
 * "Could not find font metric for 127" and the whole diagram is lost. In cmr10 that character is
 * the dieresis accent, so ä, ö, ü — typed, or written as \"u — all failed; in cmsy10 it is
 * \spadesuit, in msbm10 \backepsilon. The glyphs were never missing: the shipped WOFF2 faces carry
 * them, and dvi2html's own glyph map points at them.
 *
 * Upstream (drgrice1/dvi2html src/tfm/index.ts, read at d6ad7690) has the same `<`, and the
 * package has not been released since January 2025. Fixing it is one character, so it is patched
 * here rather than forked, in the manner of internal/DECISIONS.md D11: the edit must match exactly
 * once before and be present after, and a build that bundles dvi2html without passing through it
 * fails, so it can never silently become a no-op. Every fixture renders byte-identically with and
 * without it, since no fixture used one of those characters until it could.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

/** The file the patch applies to: the package's one bundled entry point. */
const DVI2HTML_ENTRY = /[\\/]@drgrice1[\\/]dvi2html[\\/]dist[\\/]index\.js$/;

/**
 * The loop in TFM's read_characters, as the minified bundle spells it. The loop variable's name is
 * whatever the minifier chose, so it is matched rather than written down.
 */
const READ_CHARACTERS = /(for\(let (\w+)=this\.smallest_character_code;\2)<(this\.largest_character_code;)/g;
const READ_CHARACTERS_FIXED =
	/for\(let (\w+)=this\.smallest_character_code;\1<=this\.largest_character_code;/;

/** dvi2html's bundle with its TFM reader reading the last character too. Throws if it cannot be sure. */
export function patchDvi2html(code) {
	const found = code.match(READ_CHARACTERS) ?? [];
	if (found.length !== 1) {
		throw new Error(
			`dvi2html patch: expected exactly one TFM read_characters loop, found ${found.length}. ` +
				'@drgrice1/dvi2html has changed; check whether it still drops the last character of every ' +
				'font (scripts/dvi2html-patch.mjs) and update or retire the patch.',
		);
	}
	const patched = code.replace(READ_CHARACTERS, '$1<=$3');
	if (!READ_CHARACTERS_FIXED.test(patched))
		throw new Error('dvi2html patch: applied, but not present after');
	return patched;
}

/** esbuild plugin applying patchDvi2html. A build that bundles nothing to patch is an error. */
export function dvi2htmlPatch() {
	return {
		name: 'dvi2html-tfm-last-character',
		setup(build) {
			let applied = 0;
			build.onStart(() => {
				applied = 0;
			});
			build.onLoad({ filter: DVI2HTML_ENTRY }, (args) => {
				applied++;
				return { contents: patchDvi2html(readFileSync(args.path, 'utf8')), loader: 'js' };
			});
			build.onEnd((result) => {
				// Zero means dvi2html reached the bundle by some other path — a new entry file, a
				// different package layout — and went in unpatched.
				if (result.errors.length === 0 && applied !== 1)
					throw new Error(`dvi2html patch: applied ${applied} times in one build, expected once`);
			});
		},
	};
}

/**
 * engine-src/library.ts and the patched dvi2html, bundled together for Node and imported: the
 * fork's exports plus `dvi2html`. For the scripts that run the engine outside a worker, so they draw
 * with exactly the converter the plugin ships. `name` keeps concurrent scripts out of each other's
 * way under node_modules/.cache.
 */
export async function importEngineForNode(root, name) {
	const dir = join(root, 'node_modules', '.cache', name);
	mkdirSync(dir, { recursive: true });
	const outfile = join(dir, 'engine.mjs');
	await esbuild.build({
		stdin: {
			contents:
				"export * from './engine-src/library.ts';\nexport { dvi2html } from '@drgrice1/dvi2html';\n",
			resolveDir: root,
			sourcefile: 'engine-for-node.ts',
			loader: 'ts',
		},
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		logLevel: 'warning',
		plugins: [dvi2htmlPatch()],
	});
	return import(pathToFileURL(outfile).href);
}
