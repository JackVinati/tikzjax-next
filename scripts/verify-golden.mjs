/**
 * Renders every fixture through the committed engine and the fork, and compares what comes out with
 * the golden corpus in test/fixtures/golden, byte for byte.
 *
 *   node scripts/verify-golden.mjs                 compare every fixture
 *   node scripts/verify-golden.mjs name ...        compare these
 *   node scripts/verify-golden.mjs --update [name] record what this engine produces, for an
 *                                                  intended change, and say what changed
 *
 * Three things are kept for each fixture in test/fixtures/tex: the DVI TeX wrote, as a sha256 in
 * dvi.sha256; the transcript, as <name>.log; and the SVG the patched dvi2html draws from it, as
 * <name>.svg. The DVI is the engine's own output, the transcript what the plugin reads its errors
 * from, and the SVG what the user sees. A difference in the DVI is the engine; the same DVI with a
 * different SVG is the converter.
 *
 * The corpus was recorded from the 0.1.5 engine, the last one built with asyncify, on which
 * scripts/verify-fork.mjs had shown that engine-src/library.ts and upstream's library.js, each
 * driving the same tex.wasm, produce the same output. That comparison cannot be made on an engine
 * without asyncify, because upstream's host unwinds the wasm stack to load a file and that engine
 * has no stack to unwind; this one takes its place. See internal/DECISIONS.md D13.
 *
 * An intended change to what a fixture renders is recorded with --update, in the commit that makes
 * it, which then says why. A new fixture has no golden output until it is recorded, and is reported
 * until it is.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importEngineForNode } from './dvi2html-patch.mjs';
import { engineFilesPresent, readEngineFile } from './engine-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'engine-build', 'out');
const DIST = join(OUT, 'dist');
const FIXTURES = join(root, 'test', 'fixtures', 'tex');
const GOLDEN = join(root, 'test', 'fixtures', 'golden');
const DVI_SUMS = join(GOLDEN, 'dvi.sha256');
const RESULTS = join(root, 'node_modules', '.cache', 'tikz-golden');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const wanted = args.filter((a) => a !== '--update');
for (const a of wanted) {
	if (a.startsWith('-')) {
		console.error(`unknown option ${a}\nusage: node scripts/verify-golden.mjs [--update] [fixture ...]`);
		process.exit(2);
	}
}

if (!engineFilesPresent(OUT) || !existsSync(join(DIST, 'tex_files'))) {
	console.error(`no engine in ${OUT}\nRun: npm run engine:image && npm run engine:build`);
	process.exit(2);
}

// The fork and the patched dvi2html, bundled as smoke and the worker bundle them.
const library = await importEngineForNode(root, 'tikz-golden');
const code = new WebAssembly.Module(readEngineFile(OUT, 'tex.wasm'));
const coredump = new Uint8Array(readEngineFile(OUT, 'core.dump'));

const bundled = new Map();
for (const entry of readdirSync(join(DIST, 'tex_files'))) {
	if (entry.endsWith('.gz'))
		bundled.set(entry.slice(0, -3), new Uint8Array(readFileSync(join(DIST, 'tex_files', entry))));
}
library.setBundledFiles(bundled, (gz) => new Uint8Array(gunzipSync(gz)));

/** A fixture through the engine: the DVI's sha256, the transcript and the SVG, or null for none. */
async function render(source, dataset) {
	const log = [];
	library.setLogSink((line) => log.push(line));
	library.setMissingFileSink(() => {});
	library.setShowConsole();
	library.writeFileSync('input.tex', new TextEncoder().encode(library.buildInput(source, dataset).text));

	const memory = new WebAssembly.Memory({ initial: library.pages, maximum: library.pages });
	new Uint8Array(memory.buffer, 0, library.pages * 65536).set(coredump);
	library.setMemory(memory.buffer);
	library.setInput('input.tex\n\\end\n');

	let dvi = null;
	try {
		const instance = await WebAssembly.instantiate(code, { library, env: { memory } });
		await library.executeAsync(instance.exports);
		dvi = library.readFileSync('input.dvi');
	} catch {
		// No DVI: the transcript says why, and that is what is compared.
	} finally {
		library.deleteEverything();
	}

	let svg = null;
	if (dvi?.length) {
		try {
			let html = '';
			const sink = new Writable({
				write(chunk, _enc, cb) {
					html += chunk.toString();
					cb();
				},
			});
			await library.dvi2html(
				(async function* () {
					yield Buffer.from(dvi);
				})(),
				sink,
			);
			svg = html;
		} catch {
			// A DVI the converter cannot draw, the documented limits among them: the DVI and the
			// transcript are still compared.
		}
	}

	return {
		dvi: dvi?.length ? createHash('sha256').update(dvi).digest('hex') : null,
		log: `${log.join('\n')}\n`,
		svg,
	};
}

// --- the corpus ------------------------------------------------------------------------------------

/** dvi.sha256 in `sha256sum` form: `<hash>  <name>.dvi`, one fixture to a line, sorted. */
const readDviSums = () => {
	const sums = new Map();
	if (!existsSync(DVI_SUMS)) return sums;
	for (const line of readFileSync(DVI_SUMS, 'utf8').split('\n')) {
		const m = /^([0-9a-f]{64}) {2}(.+)\.dvi$/.exec(line);
		if (m) sums.set(m[2], m[1]);
	}
	return sums;
};

const readGolden = (name, sums) => {
	const at = (ext) => join(GOLDEN, `${name}.${ext}`);
	return {
		dvi: sums.get(name) ?? null,
		log: existsSync(at('log')) ? readFileSync(at('log'), 'utf8') : null,
		svg: existsSync(at('svg')) ? readFileSync(at('svg'), 'utf8') : null,
	};
};

const writeGolden = (name, got, sums) => {
	const at = (ext) => join(GOLDEN, `${name}.${ext}`);
	writeFileSync(at('log'), got.log);
	if (got.svg === null) rmSync(at('svg'), { force: true });
	else writeFileSync(at('svg'), got.svg);
	if (got.dvi === null) sums.delete(name);
	else sums.set(name, got.dvi);
};

// --- compare ----------------------------------------------------------------------------------------

const names = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.tex'))
	.map((f) => basename(f, '.tex'))
	.filter((n) => wanted.length === 0 || wanted.includes(n));

mkdirSync(GOLDEN, { recursive: true });
mkdirSync(RESULTS, { recursive: true });
const sums = readDviSums();

let differences = 0;
console.log(
	`${UPDATE ? 'Recording' : 'Comparing'} ${names.length} fixtures ` +
		`${UPDATE ? 'into' : 'with'} test/fixtures/golden\n`,
);

for (const name of names) {
	// With LF line endings whatever the checkout. A Windows checkout gives the fixtures CRLF, and a CR
	// that reaches TeX is printed in an error's context as ^^M, so broken.log came out one way on
	// Windows and another on CI's Linux. The DVI and the SVG are the same either way.
	const source = readFileSync(join(FIXTURES, `${name}.tex`), 'utf8').replace(/\r\n/g, '\n');
	const metaPath = join(FIXTURES, `${name}.json`);
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

	const got = await render(source, meta.dataset ?? {});
	const want = readGolden(name, sums);
	const recorded = want.log !== null;
	const differ = ['dvi', 'log', 'svg'].filter((part) => got[part] !== want[part]);
	const output = got.svg !== null ? `${got.svg.length} B svg` : got.dvi ? 'dvi, no svg' : 'no dvi';

	if (UPDATE) {
		writeGolden(name, got, sums);
		const what = !recorded ? 'NEW ' : differ.length ? 'CHANGED' : 'same';
		console.log(
			`${what.padEnd(7)} ${name.padEnd(24)} ${output}${differ.length && recorded ? `  (${differ.join(', ')})` : ''}`,
		);
		continue;
	}

	if (!recorded) {
		differences++;
		console.log(`\x1b[31mNONE\x1b[0m  ${name.padEnd(24)} no golden output: record it with --update`);
		continue;
	}
	if (differ.length === 0) {
		console.log(`\x1b[32mSAME\x1b[0m  ${name.padEnd(24)} ${output}`);
		continue;
	}

	differences++;
	console.log(`\x1b[31mDIFF\x1b[0m  ${name.padEnd(24)} ${differ.join(', ')} differ  ${output}`);
	writeFileSync(join(RESULTS, `${name}.log`), got.log);
	if (got.svg !== null) writeFileSync(join(RESULTS, `${name}.svg`), got.svg);
	console.log(`      this engine's output is in ${RESULTS}`);
}

// A golden entry with no fixture left is a claim nothing checks any more.
if (wanted.length === 0) {
	const fixtures = new Set(names);
	const stale = [
		...new Set([
			...readdirSync(GOLDEN)
				.filter((f) => f.endsWith('.log') || f.endsWith('.svg'))
				.map((f) => f.replace(/\.(log|svg)$/, '')),
			...sums.keys(),
		]),
	].filter((n) => !fixtures.has(n));
	for (const name of stale) {
		if (UPDATE) {
			rmSync(join(GOLDEN, `${name}.log`), { force: true });
			rmSync(join(GOLDEN, `${name}.svg`), { force: true });
			sums.delete(name);
			console.log(`GONE    ${name}`);
		} else {
			differences++;
			console.log(
				`\x1b[31mSTALE\x1b[0m ${name.padEnd(24)} golden output for a fixture that no longer exists`,
			);
		}
	}
}

if (UPDATE) {
	const lines = [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, h]) => `${h}  ${n}.dvi`);
	writeFileSync(DVI_SUMS, `${lines.join('\n')}\n`);
	console.log('\nRecorded. Say in the commit why the output changed.');
	process.exit(0);
}

console.log(
	differences
		? `\n${differences} fixture(s) differ from the golden corpus.`
		: `\n${names.length}/${names.length} byte-identical to the golden corpus.`,
);
process.exit(differences ? 1 : 0);
