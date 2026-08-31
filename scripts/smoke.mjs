/**
 * Runs the built TeX engine headlessly in Node against the fixtures in test/fixtures/tex.
 *
 *   node scripts/smoke.mjs [fixture-name ...]
 *
 * This exists to answer, with evidence rather than argument, the questions docs/DECISIONS.md D8
 * opened: does pgfplots compile, does expl3 actually run on this engine, does a broken source
 * produce a diagnosable error instead of hanging.
 *
 * It runs OUR fork (engine-src/library.ts), not the upstream copy. It used to run upstream, on the
 * argument that a failure would then be upstream's rather than ours — but the fork now deliberately
 * FIXES upstream behaviour (a font outside dvi2html's built-in metric table threw out of openSync,
 * across the wasm frames, and killed the run; a single \mathfrak took the engine down). Measuring
 * against an engine we no longer ship would report our fixes as failures. `verify-fork.mjs` is what
 * proves fork and upstream agree wherever upstream works at all.
 *
 * It is also the harness the golden corpus uses: same inputs, same engine, byte-comparable output.
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
const RESULTS = join(root, 'engine-build', 'out', 'smoke');

for (const p of [join(OUT, 'tex.wasm'), join(OUT, 'core.dump'), join(DIST, 'tex_files')]) {
	if (!existsSync(p)) {
		console.error(`missing ${p}\nRun: npm run engine:image && npm run engine:build`);
		process.exit(2);
	}
}

// The fork takes its log sink by injection rather than reaching for postMessage.
let transcript = [];

// Transpiled into node_modules/.cache so that `@drgrice1/dvi2html`, left external, still resolves.
const cacheDir = join(root, 'node_modules', '.cache', 'tikz-smoke');
mkdirSync(cacheDir, { recursive: true });
const forkPath = join(cacheDir, 'library.mjs');
await esbuild.build({
	entryPoints: [join(root, 'engine-src', 'library.ts')],
	outfile: forkPath,
	bundle: true,
	format: 'esm',
	platform: 'node',
	external: ['@drgrice1/dvi2html'],
	logLevel: 'warning',
});
const library = await import(pathToFileURL(forkPath).href);
const { dvi2html } = await import('@drgrice1/dvi2html');

const code = new WebAssembly.Module(readFileSync(join(OUT, 'tex.wasm')));
const coredump = new Uint8Array(readFileSync(join(OUT, 'core.dump')));

if (coredump.length !== library.pages * 65536) {
	console.error(`core.dump is ${coredump.length} B but library.pages says ${library.pages * 65536} B`);
	process.exit(2);
}

/**
 * The bundled TeX inputs, as the plugin ships them.
 *
 * Every miss is recorded. TeX probes for files it does not need (see pgfplots'
 * \pgfplots@iffileexists, which \openin's a name precisely to find out whether it exists), so a
 * miss is not by itself a fault — but when a fixture fails, the miss list is the first place the
 * cause shows up, and it is the raw material for the plugin's "package X is not bundled" error.
 */
let missed = [];
const bundled = new Map();
for (const entry of readdirSync(join(DIST, 'tex_files'))) {
	if (entry.endsWith('.gz')) bundled.set(entry.slice(0, -3), new Uint8Array(readFileSync(join(DIST, 'tex_files', entry))));
}
library.setBundledFiles(bundled, (gz) => new Uint8Array(gunzipSync(gz)));
library.setLogSink((line) => transcript.push(line));
library.setMissingFileSink((name) => missed.push(name));

/** The body of run-tex.js's texify(), with the network removed. */
async function texify(source, dataset = {}) {
	transcript = [];
	missed = [];

	const texPackages = dataset.texPackages ?? {};
	const preamble =
		Object.entries(texPackages)
			.map(([name, opts]) => `\\usepackage${opts ? `[${opts}]` : ''}{${name}}`)
			.join('') +
		(dataset.tikzLibraries ? `\\usetikzlibrary{${dataset.tikzLibraries}}` : '') +
		(dataset.addToPreamble ?? '');

	const input = `${preamble}\\begin{document}\n${source}\n\\end{document}\n`;

	library.setShowConsole();
	library.writeFileSync('input.tex', Buffer.from(input));

	const memory = new WebAssembly.Memory({ initial: library.pages, maximum: library.pages });
	new Uint8Array(memory.buffer, 0, library.pages * 65536).set(coredump);

	library.setMemory(memory.buffer);
	library.setInput('input.tex\n\\end\n');

	// `code` is a pre-compiled WebAssembly.Module, so instantiate() resolves to the Instance
	// itself — not the { module, instance } pair you get when passing bytes. Upstream passes
	// bytes and recompiles 526 KB of wasm on every single render; compiling once is the win
	// docs/DECISIONS.md D10 item 3 describes, and this is what it looks like.
	const instance = await WebAssembly.instantiate(code, { library, env: { memory } });
	await library.executeAsync(instance.exports);

	const dvi = library.readFileSync('input.dvi').buffer;
	library.deleteEverything();

	let html = '';
	const sink = new Writable({
		write(chunk, _enc, cb) {
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

	return { svg: html, log: transcript.slice() };
}

const wanted = process.argv.slice(2);
const names = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.tex'))
	.map((f) => basename(f, '.tex'))
	.filter((n) => wanted.length === 0 || wanted.includes(n));

mkdirSync(RESULTS, { recursive: true });

let failures = 0;
let passes = 0;
for (const name of names) {
	const source = readFileSync(join(FIXTURES, `${name}.tex`), 'utf8');
	const metaPath = join(FIXTURES, `${name}.json`);
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

	const started = Date.now();
	let result, error;
	try {
		result = await texify(source, meta.dataset ?? {});
	} catch (e) {
		error = e;
	}
	const ms = Date.now() - started;

	const log = result?.log ?? transcript;
	const texError = log.find((l) => l.startsWith('! '));
	const wroteDvi = log.some((l) => l.includes('Output written on'));
	const expectFailure = meta.expect === 'failure';
	// A documented boundary rather than a regression. It still RUNS — so the day the limit is
	// lifted the suite says so instead of quietly continuing to skip it — but it does not fail the
	// build, and it is printed differently so it can never be mistaken for a pass.
	const expectUnsupported = meta.expect === 'unsupported';

	// A run "succeeded" if TeX wrote a DVI and dvi2html produced an <svg>. Structural, not heuristic.
	const gotSvg = !!result?.svg && result.svg.includes('<svg');
	const succeeded = !error && wroteDvi && gotSvg;
	const passed = expectFailure ? !!texError : expectUnsupported ? true : succeeded;

	if (result?.svg) writeFileSync(join(RESULTS, `${name}.svg`), result.svg);
	writeFileSync(join(RESULTS, `${name}.log`), log.join('\n'));

	// A documented limit is never printed as a pass. If one starts succeeding, that is news, and
	// LIFTED says so — a suite that silently absorbs a fixed limitation stops being a record of
	// what the engine can do.
	const mark = expectUnsupported
		? succeeded
			? '\x1b[36mLIFTED\x1b[0m'
			: '\x1b[33mLIMIT \x1b[0m'
		: passed
			? '\x1b[32mPASS\x1b[0m'
			: '\x1b[31mFAIL\x1b[0m';
	console.log(
		`${mark}  ${name.padEnd(24)} ${String(ms).padStart(6)} ms  ` +
			`${gotSvg ? `${result.svg.length} B svg` : 'no svg'}` +
			`${texError ? `  \x1b[33m${texError.slice(0, 70)}\x1b[0m` : ''}` +
			`${error ? `  \x1b[31m${error.message}\x1b[0m` : ''}`,
	);
	if (meta.note) console.log(`      ${meta.note}`);
	if (passed && !expectUnsupported) passes++;
	if (!passed) {
		failures++;
		if (missed.length) {
			console.log(`      [33mnot bundled (${missed.length}):[0m ${[...new Set(missed)].join(', ')}`);
		}
		for (const l of log.slice(-12)) console.log(`      | ${l}`);
	}
}

console.log(`\n${names.length - failures}/${names.length} passed. Output in ${RESULTS}`);
process.exit(failures ? 1 : 0);
