/**
 * Reads engine-build/out/ into the `virtual:engine-assets` module, and builds the worker around it.
 *
 * The engine is ~8 MB of base64. It is committed in compressed form (internal/DECISIONS.md D12) and
 * reproducible from pinned inputs with `npm run engine:image && npm run engine:build`; this file is
 * what turns those archives into what main.js carries: the worker's code as a string, and the
 * payload the worker is sent when it starts.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import esbuild from 'esbuild';
import { gzip } from 'pako';
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
	return inflated(readFileSync(join(engineOutDir(root), 'core.dump.gz')));
}

function inflated(archive) {
	const dump = gunzipSync(archive);
	return new Uint8Array(dump.buffer, dump.byteOffset, dump.length);
}

/**
 * A run of zeros at least this long ends one of the dump's runs; a shorter one stays inside it.
 *
 * Splitting at every zero byte would cut the dump into thousands of runs to save a few zeros. With
 * 4 KiB the committed dump is 28 runs and 22.3 MiB, against 10.8 MiB of bytes that are literally
 * not zero: TeX's arrays are full of short zero stretches.
 */
const DUMP_GAP = 4096;

/**
 * The core dump as the worker carries it: the stretches of it that are not zero, back to back in
 * `bytes`, and `runs`, an offset and a length for each, in order.
 *
 * 134 of the dump's 156.25 MiB are zero, and the memory a TeX run starts from is zero wherever the
 * worker writes nothing (engine-src/core-dump.ts), so the zeros need not ship. They used to: the
 * whole dump went into main.js gzipped, and every boot inflated all 156.25 MiB of it, half a
 * second on the desktop and the worker's largest allocation, to keep 22.3 MiB of it.
 *
 * Each run starts at a byte that is not zero and ends after the last one that is, so the dump is
 * `size` zeros with the runs written over them, and nothing is lost.
 */
export function packCoreDump(dump, gap = DUMP_GAP) {
	const runs = [];
	const n = dump.length;
	let i = 0;
	let total = 0;
	while (i < n) {
		while (i < n && dump[i] === 0) i++;
		if (i === n) break;

		const start = i;
		let end;
		for (;;) {
			while (i < n && dump[i] !== 0) i++;
			end = i;
			while (i < n && dump[i] === 0 && i - end < gap) i++;
			// The end of the dump, or a gap long enough to end the run on.
			if (i === n || i - end >= gap) break;
		}
		runs.push(start, end - start);
		total += end - start;
	}

	const bytes = new Uint8Array(total);
	let at = 0;
	for (let r = 0; r < runs.length; r += 2) {
		bytes.set(dump.subarray(runs[r], runs[r] + runs[r + 1]), at);
		at += runs[r + 1];
	}
	return { size: n, runs, bytes };
}

/** One encoding per dump, however many times a process builds the worker: a test does it a dozen. */
const encodings = new Map();

/**
 * The committed core dump, packed (packCoreDump) and gzipped, as the worker string carries it.
 *
 * Gzipped by pako, not by node:zlib. What deflate emits is not fixed by any standard, only what it
 * inflates to, and node:zlib is whichever zlib the running Node bundles, so another Node release
 * could make another main.js from the same commit. pako is pinned in the lockfile and is the same
 * JavaScript wherever it runs.
 */
export function encodeCoreDump(root) {
	const archive = readFileSync(join(engineOutDir(root), 'core.dump.gz'));
	const key = createHash('sha256').update(archive).digest('hex');
	let encoding = encodings.get(key);
	if (encoding === undefined) {
		const { size, runs, bytes } = packCoreDump(inflated(archive));
		encoding = { size, runs, gz: gzip(bytes, { level: 9 }) };
		encodings.set(key, encoding);
	}
	return encoding;
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

/**
 * engine-build/out/memory-layout.json as the worker reads it (engine-src/reset.ts MemoryLayout):
 * where each of TeX's globals lies, by name, with the memory's pages and hash_prime. The worker
 * resets only the parts of its Memory a run can have written, and finds them from this and TeX's
 * counters (internal/DECISIONS.md D31).
 */
export function readMemoryLayout(root) {
	const raw = JSON.parse(readFileSync(join(engineOutDir(root), 'memory-layout.json'), 'utf8'));
	const variables = {};
	for (const { name, ...where } of raw.variables) variables[name] = where;
	return {
		pages: raw.pages,
		globalsEnd: raw.globalsEnd,
		dataEnd: raw.dataEnd,
		hashPrime: raw.hashPrime,
		variables,
	};
}

/**
 * The globals engine-src/reset.ts reads, by name: the arrays it does not reset whole, and the
 * counters it bounds them by (its LAYOUT_NAMES, which test/reset.test.ts holds this list to). The
 * worker carries the place of these and no more, since every other global is reset whole.
 */
export const RESET_NAMES = [
	'mem',
	'str_pool',
	'str_start',
	'font_info',
	'trie',
	'hash',
	'save_stack',
	'trie_c',
	'trie_o',
	'trie_l',
	'trie_r',
	'trie_hash',
	'trie_taken',
	'trie_op_hash',
	'lo_mem_max',
	'hi_mem_min',
	'mem_end',
	'pool_ptr',
	'str_ptr',
	'fmem_ptr',
	'trie_max',
	'hash_used',
	'max_save_stack',
];

/** The layout as the worker carries it: RESET_NAMES' places, with the rest of the layout's numbers. */
export function workerLayout(layout) {
	const variables = {};
	for (const name of RESET_NAMES) {
		if (layout.variables[name] === undefined) throw new Error(`memory-layout.json has no ${name}`);
		variables[name] = layout.variables[name];
	}
	return { ...layout, variables };
}

export function buildEngineAssets(root) {
	const out = engineOutDir(root);
	const dist = join(out, 'dist');

	const wasmGz = readFileSync(join(out, 'tex.wasm.gz'));
	const dump = encodeCoreDump(root);

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

	// The payload the worker starts from, which the host sends it as its first message
	// (engine-src/protocol.ts EngineAssets) rather than the build writing it into the worker's script
	// (internal/DECISIONS.md D30). The keys are in a fixed order: ENGINE_ID hashes it (buildWorker).
	const assets = {
		wasm: wasmGz.toString('base64'),
		dump: Buffer.from(dump.gz).toString('base64'),
		files: texFiles,
	};

	const source =
		`export const TEX_WASM_SIZE = ${gunzipSync(wasmGz).length};\n` +
		`export const CORE_DUMP_SIZE = ${dump.size};\n` +
		`export const CORE_DUMP_RUNS = ${JSON.stringify(dump.runs)};\n` +
		`export const CORE_LAYOUT = ${JSON.stringify(workerLayout(readMemoryLayout(root)))};\n` +
		`export const ENGINE_ID = ${JSON.stringify(ENGINE_ID_PLACEHOLDER)};\n` +
		`export const INVENTORY = ${JSON.stringify(inventory)};\n`;

	return {
		source,
		assets,
		inventory,
		stats: {
			wasmGz: wasmGz.length,
			dumpGz: dump.gz.length,
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
 * ENGINE_ID names the build, so it must change whenever anything the worker runs changes, and only
 * then. Until 0.2.1 it was the cache-key input, and every change to it rendered every cached diagram
 * again; the key holds OUTPUT_REVISION now (src/cache/key.ts), and test/engine-id.test.ts fails on
 * a new ENGINE_ID until that revision has been reconsidered (internal/DECISIONS.md D20). It is the
 * sha256 of the minified worker itself — the exact string a production main.js embeds — with the id
 * replaced by ENGINE_ID_PLACEHOLDER.
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
 * Since 0.2.1 the worker's code and the payload it starts from travel apart (D30): the payload is
 * data the host posts to the worker. Both are what it runs, so the id is the hash of the two
 * together, the minified code and then the payload as JSON, and moves when a bundled file, the dump
 * or tex.wasm changes as it does when the code changes.
 *
 * `plugins` run before the build's own, so a test can stand in for a source file or the assets;
 * `payload` stands in for the payload the same way.
 */
export async function buildWorker(root, { minify = true, plugins = [], payload } = {}) {
	const assets = buildEngineAssets(root);
	if (payload !== undefined) assets.assets = payload;
	const all = [...plugins, dvi2htmlPatch(), engineAssetsPlugin(assets)];

	const canonical = await bundleWorker(root, true, all);
	// Hashed with the dvi2html patch already in it, so applying, changing or retiring the patch
	// moves the id like any other change to what the worker runs.
	const engineId = engineIdOf(`${canonical}\n${JSON.stringify(assets.assets)}`);
	const shipped = minify ? canonical : await bundleWorker(root, false, all);

	return {
		source: withEngineId(shipped, engineId),
		assets: assets.assets,
		engineId,
		inventory: { ...assets.inventory, engineId },
		stats: assets.stats,
	};
}
