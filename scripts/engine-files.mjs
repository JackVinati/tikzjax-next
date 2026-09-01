/**
 * Reads the engine's two big artifacts, from whichever form the checkout has.
 *
 * The repository commits `tex.wasm.gz` and `core.dump.gz` — the compressed pair is 5.8 MB and the
 * uncompressed dump alone is 156 MB, so only the archives can live in git (internal/DECISIONS.md
 * D12). A Docker build leaves both forms in `engine-build/out/`; a fresh clone has only the
 * archives. The verification scripts read the raw files and therefore worked on a machine that had
 * just built the engine and nowhere else, which is how a release failed on `missing tex.wasm` in a
 * checkout that had the engine all along.
 *
 * Reading the archive is also the more faithful test: `.gz` is what `scripts/engine-assets.mjs`
 * embeds and what the shipped worker inflates, so this is the same bytes by the same path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * @param {string} out  engine-build/out
 * @param {'tex.wasm' | 'core.dump'} name
 * @returns {Buffer}
 */
export function readEngineFile(out, name) {
	const raw = join(out, name);
	if (existsSync(raw)) return readFileSync(raw);

	const archive = join(out, `${name}.gz`);
	if (existsSync(archive)) return gunzipSync(readFileSync(archive));

	throw new Error(
		`neither ${name} nor ${name}.gz is in ${out}.\n` +
			'The committed engine is missing — check out the repository properly, or rebuild it with\n' +
			'  npm run engine:image && npm run engine:build',
	);
}

/** True when the engine can be read at all, in either form. */
export function engineFilesPresent(out) {
	return (
		(existsSync(join(out, 'tex.wasm')) || existsSync(join(out, 'tex.wasm.gz'))) &&
		(existsSync(join(out, 'core.dump')) || existsSync(join(out, 'core.dump.gz')))
	);
}
