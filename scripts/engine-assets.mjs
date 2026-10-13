/**
 * Reads engine-build/out/ into the `virtual:engine-assets` module, and builds the worker around it.
 *
 * The engine is ~8 MB of base64. It is committed in compressed form (internal/DECISIONS.md D12) and
 * reproducible from pinned inputs with `npm run engine:image && npm run engine:build`; this file is
 * what turns those archives into the string main.js carries.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import esbuild from 'esbuild';
import { dvi2htmlPatch } from './dvi2html-patch.mjs';

export const engineOutDir = (root) => join(root, 'engine-build', 'out');

export function engineIsBuilt(root) {
	const out = engineOutDir(root);
	return existsSync(join(out, 'tex.wasm.gz')) && existsSync(join(out, 'dist', 'tex_files'));
}

/**
 * core.dump, inflated from the committed archive: the 156.25 MiB WebAssembly.Memory image every TeX
 * run starts from. The archive, not a raw `core.dump` an engine build may have left beside it,
 * because the archive is what ships.
 */
export function readCoreDump(root) {
	const dump = gunzipSync(readFileSync(join(engineOutDir(root), 'core.dump.gz')));
	return new Uint8Array(dump.buffer, dump.byteOffset, dump.length);
}

/**
 * Package versions, from what the build image actually resolved via kpsewhich.
 *
 * The contract matters more than it looks. An earlier version of this function keyed the table by
 * FILE name and used the literal string 'absent' as a value, which meant every consumer had to
 * know two conventions to answer "is this bundled?" — and two of them got it wrong in opposite
 * directions, one reading 'absent' as proof of presence. So:
 *
 *   - keys are BARE package names ('pgfplots', not 'pgfplots.sty');
 *   - values are version strings and nothing else;
 *   - a package the build could not resolve is simply ABSENT FROM THE TABLE.
 *
 * `INVENTORY.files` remains the authoritative answer to "is it bundled" — it is the tex_files list,
 * which is exactly what the virtual filesystem can serve. This table only answers "which version".
 */
/**
 * `\ProvidesPackage`'s bracket is a date, a version and a sentence, and the whole line is what the
 * build reports. Settings shows these joined by commas on one line, so "2022/10/10 v1.3b Class to
 * compile TeX sub-files standalone" would push everything after it off the end. Keep the leading
 * tokens that look like a date or a version and drop the prose.
 */
function shorten(value) {
	const kept = [];
	for (const token of value.split(/\s+/)) {
		if (!/^[0-9]|^v[0-9]/.test(token)) break;
		kept.push(token);
	}
	return kept.join(' ') || value;
}

function readVersions(out) {
	const path = join(out, 'tex-versions.txt');
	if (!existsSync(path)) return {};
	const packages = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const m = /^(\S+)\s+(.*)$/.exec(line.trim());
		if (!m) continue;
		const [, file, raw] = m;
		const version = shorten(raw.trim());
		if (!version || version === 'absent' || version === 'unknown') continue;
		packages[file.replace(/\.(sty|cls|def|tex)$/, '')] = version;
	}
	return packages;
}

/**
 * What the worker carries where its ENGINE_ID belongs, until the id is known.
 *
 * The id is a hash of the worker, and the worker contains the id — as ENGINE_ID and again inside
 * INVENTORY — so it cannot be hashed with the id in place. It is built with this instead, hashed,
 * and the hash is written over it. Letters, digits and underscores only, so that neither
 * JSON.stringify nor the minifier can respell it into something the substitution would miss.
 */
export const ENGINE_ID_PLACEHOLDER = 'ENGINE_ID_PLACEHOLDER_0f6c8e1d5a2b';

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

	const inventory = {
		engineId: ENGINE_ID_PLACEHOLDER,
		engine: 'etex-3.141592653-2.6',
		packages: readVersions(out),
		files: names,
		capabilities: {
			// web2js applies changes/expanded.ch and changes/strcmp.ch; proven by the expl3 and
			// xparse smoke fixtures compiling. See internal/DECISIONS.md D8.
			expl3: true,
			// The worker carries the first pass's .aux into a second when the first left anything
			// worth re-reading, so cross-references resolve. Gated per block; never a default.
			twoPass: true,
		},
	};

	const source =
		`export const TEX_WASM_GZ = ${JSON.stringify(wasmGz.toString('base64'))};\n` +
		`export const CORE_DUMP_GZ = ${JSON.stringify(dumpGz.toString('base64'))};\n` +
		`export const TEX_FILES = ${JSON.stringify(texFiles)};\n` +
		`export const ENGINE_ID = ${JSON.stringify(ENGINE_ID_PLACEHOLDER)};\n` +
		`export const INVENTORY = ${JSON.stringify(inventory)};\n`;

	return {
		source,
		inventory,
		stats: {
			wasmGz: wasmGz.length,
			dumpGz: dumpGz.length,
			texFiles: names.length,
			texFilesBytes: Object.values(texFiles).reduce((n, b) => n + b.length, 0),
		},
	};
}

/** esbuild plugin resolving `virtual:engine-assets` to assets already read by buildEngineAssets. */
function engineAssetsPlugin(assets) {
	return {
		name: 'virtual-engine-assets',
		setup(build) {
			build.onResolve({ filter: /^virtual:engine-assets$/ }, () => ({
				path: 'virtual:engine-assets',
				namespace: 'virtual',
			}));
			build.onLoad({ filter: /^virtual:engine-assets$/, namespace: 'virtual' }, () => ({
				contents: assets.source,
				loader: 'js',
			}));
		},
	};
}

/** The sha256 of a worker bundle that still carries ENGINE_ID_PLACEHOLDER. */
export const engineIdOf = (bundle) => createHash('sha256').update(bundle).digest('hex');

/** `bundle` with its placeholder replaced by `engineId` everywhere it occurs. */
function withEngineId(bundle, engineId) {
	const parts = bundle.split(ENGINE_ID_PLACEHOLDER);
	// A bundle without the placeholder would ship a worker announcing no id at all, or an id from
	// some other build — and the plugin would key every diagram it renders by that.
	if (parts.length < 2) throw new Error(`the worker bundle does not carry ${ENGINE_ID_PLACEHOLDER}`);
	return parts.join(engineId);
}

async function bundleWorker(root, minify, plugins) {
	const result = await esbuild.build({
		entryPoints: [join(root, 'engine-src', 'worker.ts')],
		// Paths that end up in the bundle, which an unminified build prints as comments, are then
		// relative to the project rather than to wherever the command happened to be run from.
		absWorkingDir: resolve(root),
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		minify,
		sourcemap: false,
		legalComments: 'none',
		logLevel: 'warning',
		plugins,
	});
	return result.outputFiles[0].text;
}

/**
 * The TeX worker as it ships, and its ENGINE_ID.
 *
 * ENGINE_ID is a cache-key input: when it changes, every cached diagram is rendered again, so it
 * must change whenever anything the worker runs changes, and only then. It is the sha256 of the
 * minified worker itself — the exact string a production main.js embeds — with the id replaced by
 * ENGINE_ID_PLACEHOLDER.
 *
 * It used to be a hash of a list of inputs: the two engine archives, the NAMES of the bundled TeX
 * files and engine-src/*.ts. A list has gaps, and this one had three. A package update that kept a
 * file's name (a circuitikz or siunitx fix) changed what TeX reads and left the id alone. The npm
 * packages bundled into the worker — @drgrice1/dvi2html, which draws every SVG, and pako and
 * buffer — were not in it at all. Nor would a build-time patch to one of them have been. Each gap
 * keeps a user's diagrams as the old code drew them, with nothing to say they are stale. The bundle
 * holds all of it, so hashing the bundle needs no list to keep in step.
 *
 * The id is always taken from the MINIFIED bundle, even when the worker that ships is not
 * minified, so a development build and a release build of the same commit share a cache. It moves
 * on any change that reaches the minified worker — comments do not; an esbuild upgrade that prints
 * the same code differently does, which costs one recompile and is never wrong.
 *
 * A Windows checkout has CRLF sources and a Linux one LF. esbuild normalises them, so both produce
 * the same bundle and the same id; test/engine-id.test.ts holds it to that, since an id that
 * depended on the checkout would mean two different main.js for one commit.
 *
 * `plugins` run before the build's own, so a test can stand in for a source file or the assets.
 */
export async function buildWorker(root, { minify = true, plugins = [] } = {}) {
	const assets = buildEngineAssets(root);
	const all = [...plugins, dvi2htmlPatch(), engineAssetsPlugin(assets)];

	const canonical = await bundleWorker(root, true, all);
	// Hashed with the dvi2html patch already in it, so applying, changing or retiring the patch
	// moves the id like any other change to what the worker runs.
	const engineId = engineIdOf(canonical);
	const shipped = minify ? canonical : await bundleWorker(root, false, all);

	return {
		source: withEngineId(shipped, engineId),
		engineId,
		inventory: { ...assets.inventory, engineId },
		stats: assets.stats,
	};
}
