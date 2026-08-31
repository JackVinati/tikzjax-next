/**
 * Proves engine-src/library.ts is byte-identical to the upstream engine it forked.
 *
 *   node scripts/verify-fork.mjs
 *
 * Every fixture is rendered twice — once through engine-src/upstream/library.js exactly as
 * shipped, once through our fork — and the two SVGs are compared byte for byte. A fork of a
 * WebAssembly host is only defensible if it can show it changed nothing observable, so this is
 * the gate that lets the changes in docs/DECISIONS.md D10 be called a refactor.
 *
 * It also reports the timing difference, which is the point of change 1 (synchronous bundled-file
 * resolution instead of an asyncify unwind per file).
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { Writable } from 'node:stream';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'engine-build', 'out');
const DIST = join(OUT, 'dist');
const FIXTURES = join(root, 'test', 'fixtures', 'tex');

if (!existsSync(join(OUT, 'tex.wasm'))) {
	console.error('No engine build. Run: npm run engine:image && npm run engine:build');
	process.exit(2);
}

// --- load the fork -----------------------------------------------------------------------------
// Transpiled with esbuild rather than Node's type stripping so this works regardless of the
// runtime's --experimental-strip-types support.
// Inside node_modules so that `@drgrice1/dvi2html`, left external, still resolves from here.
const tmp = join(root, 'node_modules', '.cache', 'tikz-verify');
mkdirSync(tmp, { recursive: true });
const forkPath = join(tmp, 'library.mjs');
await esbuild.build({
	entryPoints: [join(root, 'engine-src', 'library.ts')],
	outfile: forkPath,
	bundle: true,
	format: 'esm',
	platform: 'node',
	external: ['@drgrice1/dvi2html'],
	logLevel: 'warning',
});

const upstream = await import(pathToFileURL(join(root, 'engine-src', 'upstream', 'library.js')).href);
const fork = await import(pathToFileURL(forkPath).href);
const { dvi2html } = await import('@drgrice1/dvi2html');

const code = new WebAssembly.Module(readFileSync(join(OUT, 'tex.wasm')));
const coredump = new Uint8Array(readFileSync(join(OUT, 'core.dump')));

// --- bundled files, as the plugin will ship them ------------------------------------------------
const bundled = new Map();
for (const f of readdirSync(join(DIST, 'tex_files'))) {
	if (f.endsWith('.gz')) bundled.set(f.slice(0, -3), new Uint8Array(readFileSync(join(DIST, 'tex_files', f))));
}

const dviToSvg = async (dvi) => {
	let html = '';
	const sink = new Writable({
		write(chunk, _e, cb) {
			html += chunk.toString();
			cb();
		},
	});
	await dvi2html(
		(async function* () {
			yield Buffer.from(dvi);
		})(),
		sink,
	);
	return html;
};

const buildInput = (source, dataset) => {
	const pkgs = Object.entries(dataset.texPackages ?? {})
		.map(([n, o]) => `\\usepackage${o ? `[${o}]` : ''}{${n}}`)
		.join('');
	const libs = dataset.tikzLibraries ? `\\usetikzlibrary{${dataset.tikzLibraries}}` : '';
	return `${pkgs}${libs}${dataset.addToPreamble ?? ''}\\begin{document}\n${source}\n\\end{document}\n`;
};

/** Upstream path: async fileLoader, unwind per file, coredump.slice(0). */
async function runUpstream(source, dataset) {
	const log = [];
	globalThis.postMessage = (l) => log.push(String(l));

	upstream.setShowConsole();
	upstream.writeFileSync('input.tex', Buffer.from(buildInput(source, dataset)));

	const memory = new WebAssembly.Memory({ initial: upstream.pages, maximum: upstream.pages });
	new Uint8Array(memory.buffer, 0, upstream.pages * 65536).set(coredump.slice(0));

	upstream.setMemory(memory.buffer);
	upstream.setInput('input.tex\n\\end\n');
	upstream.setFileLoader(async (file) => {
		const name = file.replace(/^tex_files\//, '').replace(/\.gz$/, '');
		const gz = bundled.get(name);
		if (!gz) throw new Error(`not bundled: ${name}`);
		return gunzipSync(gz);
	});

	const instance = await WebAssembly.instantiate(code, { library: upstream, env: { memory } });
	await upstream.executeAsync(instance.exports);

	let svg = null;
	try {
		svg = await dviToSvg(upstream.readFileSync('input.dvi').buffer);
	} catch {
		/* no dvi */
	}
	upstream.deleteEverything();
	return { svg, log };
}

/** Fork path: synchronous bundled resolution, no network, no redundant dump copy. */
async function runFork(source, dataset) {
	const log = [];
	const missing = [];
	fork.setBundledFiles(bundled, (gz) => new Uint8Array(gunzipSync(gz)));
	fork.setLogSink((l) => log.push(l));
	fork.setMissingFileSink((n) => missing.push(n));
	fork.setShowConsole();
	fork.writeFileSync('input.tex', new TextEncoder().encode(buildInput(source, dataset)));

	const memory = new WebAssembly.Memory({ initial: fork.pages, maximum: fork.pages });
	new Uint8Array(memory.buffer, 0, fork.pages * 65536).set(coredump);

	fork.setMemory(memory.buffer);
	fork.setInput('input.tex\n\\end\n');

	const instance = await WebAssembly.instantiate(code, { library: fork, env: { memory } });
	await fork.executeAsync(instance.exports);

	let svg = null;
	try {
		svg = await dviToSvg(fork.readFileSync('input.dvi').buffer);
	} catch {
		/* no dvi */
	}
	fork.deleteEverything();
	return { svg, log, missing };
}

// --- compare -------------------------------------------------------------------------------------
const names = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.tex'))
	.map((f) => basename(f, '.tex'))
	.filter((n) => process.argv.length <= 2 || process.argv.slice(2).includes(n));

let mismatches = 0;
let upstreamTotal = 0;
let forkTotal = 0;

console.log(`Comparing ${names.length} fixtures: upstream library.js vs engine-src/library.ts\n`);

for (const name of names) {
	const source = readFileSync(join(FIXTURES, `${name}.tex`), 'utf8');
	const metaPath = join(FIXTURES, `${name}.json`);
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
	const dataset = meta.dataset ?? {};

	let a, b, t0, t1, t2;
	try {
		t0 = Date.now();
		a = await runUpstream(source, dataset);
		t1 = Date.now();
		b = await runFork(source, dataset);
		t2 = Date.now();
	} catch (e) {
		console.log(`\x1b[31mERROR\x1b[0m ${name}: ${e.message}`);
		mismatches++;
		continue;
	}

	const up = t1 - t0;
	const fk = t2 - t1;
	upstreamTotal += up;
	forkTotal += fk;

	const same = a.svg === b.svg;
	if (!same) mismatches++;

	const speed = up > 0 ? `${(up / Math.max(fk, 1)).toFixed(2)}x` : '—';
	console.log(
		`${same ? '\x1b[32mSAME\x1b[0m' : '\x1b[31mDIFF\x1b[0m'}  ${name.padEnd(24)} ` +
			`upstream ${String(up).padStart(5)} ms   fork ${String(fk).padStart(5)} ms   ${speed.padStart(6)}   ` +
			`${a.svg ? `${a.svg.length} B` : 'no svg'}`,
	);

	if (!same) {
		writeFileSync(join(tmp, `${name}.upstream.svg`), a.svg ?? '');
		writeFileSync(join(tmp, `${name}.fork.svg`), b.svg ?? '');
		console.log(`      upstream ${a.svg?.length ?? 0} B vs fork ${b.svg?.length ?? 0} B — written to ${tmp}`);
		const la = a.log.join('\n');
		const lb = b.log.join('\n');
		if (la !== lb) console.log(`      transcripts also differ (${a.log.length} vs ${b.log.length} lines)`);
	}
}

console.log(
	`\n${names.length - mismatches}/${names.length} byte-identical. ` +
		`Total: upstream ${upstreamTotal} ms, fork ${forkTotal} ms ` +
		`(${(upstreamTotal / Math.max(forkTotal, 1)).toFixed(2)}x).`,
);
process.exit(mismatches ? 1 : 0);
