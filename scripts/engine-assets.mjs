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
		// Read as text with the line endings normalised, NOT as bytes. Hashing the bytes made the id
		// a function of the checkout rather than of the source: a Windows clone gets CRLF and Linux
		// gets LF, so the same commit produced two different engine ids — and with them two different
		// main.js, which is the one thing a reproducible build has to rule out. It also meant a user
		// switching between a locally built plugin and a released one recompiled every diagram for no
		// reason, since the id is a cache-key input.
		hash.update(readFileSync(join(root, 'engine-src', file), 'utf8').replace(/\r\n/g, '\n'));
	}
	const engineId = hash.digest('hex');

	const inventory = {
		engineId,
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
