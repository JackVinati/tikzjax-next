/**
 * Reads engine-build/out/ and turns it into the `virtual:engine-assets` module.
 *
 * The engine is ~8 MB of base64 and is NOT committed — it is reproducible from pinned inputs with
 * `npm run engine:image && npm run engine:build`. Keeping it out of the source tree also keeps
 * `git clone` and every diff sane.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const engineOutDir = (root) => join(root, 'engine-build', 'out');

export function engineIsBuilt(root) {
	const out = engineOutDir(root);
	return existsSync(join(out, 'tex.wasm.gz')) && existsSync(join(out, 'dist', 'tex_files'));
}

/** Package versions, parsed from what the build image actually resolved via kpsewhich. */
function readVersions(out) {
	const path = join(out, 'tex-versions.txt');
	if (!existsSync(path)) return {};
	const packages = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const m = /^(\S+)\s+(.*)$/.exec(line.trim());
		if (!m) continue;
		const [, file, version] = m;
		// build-engine.sh records the raw \ProvidesPackage argument, which for the PGF family is
		// itself a macro (`\pgfplotsversion`) rather than a number. Report it as unknown rather
		// than surfacing `\pgfplotsversiondate\space v...` in an error message.
		packages[file] = /^[\d]/.test(version) ? version : version === 'absent' ? 'absent' : 'unknown';
	}
	return packages;
}

export function buildEngineAssets(root) {
	const out = engineOutDir(root);
	const dist = join(out, 'dist');

	const wasmGz = readFileSync(join(out, 'tex.wasm.gz'));
	const dumpGz = readFileSync(join(out, 'core.dump.gz'));

	const texFiles = {};
	for (const entry of readdirSync(join(dist, 'tex_files')).sort()) {
		if (!entry.endsWith('.gz')) continue;
		texFiles[entry.slice(0, -3)] = readFileSync(join(dist, 'tex_files', entry)).toString('base64');
	}

	const names = Object.keys(texFiles);

	// ENGINE_ID must change when anything that affects rendered bytes changes, and must NOT be
	// derived from the built worker — the worker embeds it, which would be circular. Hashing the
	// engine artifacts plus the engine source achieves the same thing without the cycle.
	const hash = createHash('sha256');
	hash.update(wasmGz);
	hash.update(dumpGz);
	hash.update(names.join('\n'));
	for (const file of ['library.ts', 'worker.ts', 'protocol.ts']) {
		hash.update(readFileSync(join(root, 'engine-src', file)));
	}
	const engineId = hash.digest('hex');

	const inventory = {
		engineId,
		engine: 'etex-3.141592653-2.6',
		packages: readVersions(out),
		files: names,
		capabilities: {
			// web2js applies changes/expanded.ch and changes/strcmp.ch; proven by the expl3 and
			// xparse smoke fixtures compiling. See docs/DECISIONS.md D8.
			expl3: true,
			twoPass: false,
		},
	};

	const source =
		`export const TEX_WASM_GZ = ${JSON.stringify(wasmGz.toString('base64'))};\n` +
		`export const CORE_DUMP_GZ = ${JSON.stringify(dumpGz.toString('base64'))};\n` +
		`export const TEX_FILES = ${JSON.stringify(texFiles)};\n` +
		`export const ENGINE_ID = ${JSON.stringify(engineId)};\n` +
		`export const INVENTORY = ${JSON.stringify(inventory)};\n`;

	return {
		source,
		engineId,
		stats: {
			wasmGz: wasmGz.length,
			dumpGz: dumpGz.length,
			texFiles: names.length,
			texFilesBytes: Object.values(texFiles).reduce((n, b) => n + b.length, 0),
		},
	};
}

/** esbuild plugin resolving `virtual:engine-assets`. */
export function engineAssetsPlugin(root) {
	let cached = null;
	return {
		name: 'virtual-engine-assets',
		setup(build) {
			build.onResolve({ filter: /^virtual:engine-assets$/ }, () => ({
				path: 'virtual:engine-assets',
				namespace: 'virtual',
			}));
			build.onLoad({ filter: /^virtual:engine-assets$/, namespace: 'virtual' }, () => {
				cached ??= buildEngineAssets(root);
				return { contents: cached.source, loader: 'js' };
			});
		},
	};
}
