/**
 * Finds the characters beyond ASCII that the committed engine typesets by itself, and writes them to
 * src/source/native-unicode.ts.
 *
 *   npm run scan:native               regenerate src/source/native-unicode.ts
 *   npm run scan:native -- --check    regenerate in memory; exit 1 if the committed file differs
 *   npm run scan:native -- --verbose  also print the verdict, and its reason, for every probe
 *
 * The pre-flight lint used to warn about every codepoint above U+00FF, on the theory that an 8-bit
 * engine prints them all as garbage. It does not: the format's LaTeX reads UTF-8 by default and
 * builds a great many characters out of OT1 glyphs and accents — Dvořák, Erdős, İstanbul, the
 * curly quotes and dashes iOS types on its own, the ﬁ ligature. So the warning sat under diagrams
 * that rendered perfectly, and on a phone it sat under nearly all of them. Since 0.2.1 there is no
 * warning at all: the worker draws every character that is not native over a box TeX sets for it
 * (engine-src/unicode.ts), and this list is what tells it which ones to leave to TeX.
 *
 * Which characters work is a property of the engine BUILD — of the LaTeX kernel frozen into
 * core.dump, of the fonts dvi2html can draw — not something to write down from memory. A list
 * typed by hand would be right for the engine it was typed against and silently wrong after the
 * next rebuild. So the list is measured, every character rendered on its own through the committed
 * engine, and the module records the verdicts together with the ENGINE_ID they were measured on.
 * `--check` repeats the measurement, which is how CI knows the committed list still describes the
 * committed engine.
 *
 * It runs the fork (engine-src/library.ts) directly against the committed archives, as
 * scripts/smoke.mjs does, and never the worker: the worker is where character handling is allowed
 * to grow (a bridge that swaps non-native characters for something drawable would make every
 * probe look native), and this has to see what the bare engine does.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importEngineForNode } from './dvi2html-patch.mjs';
import { buildWorker, engineIsBuilt } from './engine-assets.mjs';
import { readEngineFile } from './engine-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'engine-build', 'out');
const DIST = join(OUT, 'dist');
const TARGET = join(root, 'src', 'source', 'native-unicode.ts');
const TARGET_NAME = 'src/source/native-unicode.ts';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const VERBOSE = args.has('--verbose');
for (const arg of args) {
	if (arg !== '--check' && arg !== '--verbose') {
		console.error(
			`unknown argument ${arg}\nusage: node scripts/scan-native-unicode.mjs [--check] [--verbose]`,
		);
		process.exit(2);
	}
}

if (!engineIsBuilt(root)) {
	console.error(`no engine in ${OUT}\nRun: npm run engine:image && npm run engine:build`);
	process.exit(2);
}

/**
 * Probed a codepoint at a time, every one of them, whatever the format declares.
 *
 * These are the blocks LaTeX's UTF-8 support declares characters in, plus the scripts users most
 * often type and that fail here (Greek, Cyrillic). Probing their undeclared codepoints too is what
 * checks the declaration census below: if one of them ever came out native, the census would be
 * missing characters, and the scan stops rather than trust it. Latin-1 is probed like the rest,
 * because it is not all native either (° compiles into a TS1 font dvi2html cannot draw), and the
 * Unicode bridge, which draws what is not native, needs to know which of it is.
 */
const RANGES = [
	[0x00a0, 0x00ff, 'Latin-1 Supplement'],
	[0x0100, 0x017f, 'Latin Extended-A'],
	[0x0180, 0x024f, 'Latin Extended-B'],
	[0x0250, 0x02af, 'IPA Extensions'],
	[0x02b0, 0x02ff, 'Spacing Modifier Letters'],
	[0x0370, 0x03ff, 'Greek and Coptic'],
	[0x0400, 0x045f, 'Cyrillic, basic'],
	[0x1e00, 0x1eff, 'Latin Extended Additional'],
	[0x2000, 0x206f, 'General Punctuation'],
	[0x20a0, 0x20bf, 'Currency Symbols'],
	[0x2100, 0x214f, 'Letterlike Symbols'],
	[0x2190, 0x21ff, 'Arrows'],
	[0xfb00, 0xfb06, 'Latin ligatures'],
];

const hex = (cp) => cp.toString(16).toUpperCase().padStart(4, '0');

// --- the engine -----------------------------------------------------------------------------------

// The fork and the patched dvi2html, bundled as smoke.mjs bundles them: the converter that decides
// whether a character is drawable has to be the one the plugin ships. Its own cache directory, so a
// smoke run at the same time cannot overwrite the module under this one.
const library = await importEngineForNode(root, 'tikz-scan-native');
const { dvi2html } = library;

const code = new WebAssembly.Module(readEngineFile(OUT, 'tex.wasm'));
const coredump = new Uint8Array(readEngineFile(OUT, 'core.dump'));
if (coredump.length !== library.pages * 65536) {
	console.error(`core.dump is ${coredump.length} B but library.pages says ${library.pages * 65536} B`);
	process.exit(2);
}

const bundled = new Map();
for (const entry of readdirSync(join(DIST, 'tex_files'))) {
	if (entry.endsWith('.gz'))
		bundled.set(entry.slice(0, -3), new Uint8Array(readFileSync(join(DIST, 'tex_files', entry))));
}
library.setBundledFiles(bundled, (gz) => new Uint8Array(gunzipSync(gz)));

let transcript = [];
library.setLogSink((line) => transcript.push(line));
library.setMissingFileSink(() => {});

/**
 * One Memory for every run. The dump is exactly `pages * 65536` bytes (checked above) and is copied
 * over the WHOLE of it before each run, so every run starts from the same bytes a fresh Memory would
 * hold; a fresh Instance resets everything else. Allocating 156 MiB per probe cost a quarter of the
 * scan's time and bought nothing.
 */
const memory = new WebAssembly.Memory({ initial: library.pages, maximum: library.pages });

/** One TeX run over `input`; the SVG is drawn only when asked for, since the census needs none. */
async function render(input, draw = true) {
	transcript = [];
	library.setShowConsole();
	library.writeFileSync('input.tex', new TextEncoder().encode(input));
	new Uint8Array(memory.buffer, 0, library.pages * 65536).set(coredump);
	library.setMemory(memory.buffer);
	library.setInput('input.tex\n\\end\n');

	let dvi;
	try {
		const instance = await WebAssembly.instantiate(code, { library, env: { memory } });
		await library.executeAsync(instance.exports);
		dvi = library.readFileSync('input.dvi');
	} catch {
		// readFileSync throws when TeX wrote no DVI. That is a verdict, not a scan failure.
		dvi = undefined;
	} finally {
		library.deleteEverything();
	}

	let svg = '';
	let convertError;
	if (draw && dvi && dvi.byteLength > 0) {
		const sink = {
			write(chunk, _enc, cb) {
				svg += String(chunk);
				cb?.();
				return true;
			},
			end(cb) {
				cb?.();
			},
		};
		try {
			await dvi2html(
				(async function* () {
					yield Buffer.from(dvi);
				})(),
				sink,
			);
		} catch (error) {
			convertError = error instanceof Error ? error.message : String(error);
		}
	}
	return { log: transcript.slice(), dvi, svg, convertError };
}

// --- the census: what the format declares ---------------------------------------------------------

/**
 * Every codepoint from `first` to `last` that the format has a definition for.
 *
 * With UTF-8 input, LaTeX makes the lead byte of every multi-byte sequence an active character that
 * gathers the rest and looks up `\csname u8:<the bytes>\endcsname` (utf8.def). When that name is
 * undefined TeX reports "Unicode character … not set up for use with LaTeX" and leaves it out, so a
 * codepoint without it cannot be native, whatever the fonts hold. Asking the format for the name is one
 * \ifcsname per codepoint, and all of Unicode takes seconds where probing it a character at a time
 * would take about twelve hours. That is what lets the module say "not listed means not native" for
 * every codepoint, not just for the ranges above — U+2423 ␣, drawn out of rules and no font at
 * all, is native and lies in none of them.
 *
 * Attribution is exact by construction: each line tests one codepoint and writes its own number.
 * The closing sentinel proves TeX read to the end of the file rather than stopping part-way.
 */
async function declaredBetween(first, last) {
	const lines = [String.raw`\nonstopmode`];
	for (let cp = first; cp <= last; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogates have no UTF-8 form of their own
		lines.push(
			String.raw`\ifcsname u8:\detokenize{` +
				String.fromCodePoint(cp) +
				String.raw`}\endcsname\immediate\write16{DECLARED ` +
				hex(cp) +
				String.raw`}\fi`,
		);
	}
	lines.push(String.raw`\immediate\write16{DECLARED END}\begin{document}\end{document}`);

	const { log } = await render(`${lines.join('\n')}\n`, false);
	const error = log.find((l) => l.startsWith('!'));
	if (error !== undefined || !log.includes('DECLARED END')) {
		console.error(
			`the census of U+${hex(first)}–U+${hex(last)} did not run to the end: ${error ?? 'no sentinel'}`,
		);
		process.exit(2);
	}
	return log.filter((l) => /^DECLARED [0-9A-F]+$/.test(l)).map((l) => parseInt(l.slice(9), 16));
}

const started = performance.now();
const declared = new Set();
// A plane per run: the whole of Unicode in one file would be 80 MB of TeX source.
for (let first = 0x80; first <= 0x10ffff; first = (first | 0xffff) + 1) {
	for (const cp of await declaredBetween(first, first | 0xffff)) declared.add(cp);
}
const censusSeconds = (performance.now() - started) / 1000;

// A census that found é missing or 开 present is reading the wrong name, and everything it ruled
// out would be ruled out wrongly. A future kernel that renames `u8:` stops the scan here.
if (!declared.has(0xe9) || declared.has(0x5f00)) {
	console.error('census control failed: é must be declared and 开 must not. utf8.def has changed.');
	process.exit(2);
}

// --- the probe ------------------------------------------------------------------------------------

/**
 * The document the worker builds for a block with no `\begin{document}` of its own: \nonstopmode,
 * then the block wrapped (engine-src/worker.ts `buildInput`). Probing a different document would
 * measure a different engine.
 */
const documentFor = (block) =>
	String.raw`\nonstopmode\begin{document}` + '\n' + block + '\n' + String.raw`\end{document}` + '\n';

/** The probe the review used: one character between two x's, so it is never at a node boundary. */
const probeFor = (ch) =>
	documentFor(String.raw`\begin{tikzpicture}\node {x` + ch + String.raw`x};\end{tikzpicture}`);

/**
 * The font names a DVI uses, from its postamble.
 *
 * TeX writes a font's definition into the DVI only once the font has actually set a character, and
 * repeats every definition in the postamble, so this is exactly the set of fonts the page draws
 * with — read from the file itself rather than from dvi2html's SVG, which stops writing at the first
 * font it cannot draw and would then report only the fonts that came before it.
 */
function dviFonts(dvi) {
	const view = new DataView(dvi.buffer, dvi.byteOffset, dvi.byteLength);
	let end = dvi.byteLength - 1;
	while (end > 0 && dvi[end] === 223) end--; // the 223 padding after post_post
	// dvi[end] is the DVI id byte; the four bytes before it point at the `post` command.
	let p = view.getUint32(end - 4);
	if (dvi[p] !== 248) throw new Error('no DVI postamble where post_post points');
	p += 29; // post p[4] num[4] den[4] mag[4] l[4] u[4] s[2] t[2]
	const fonts = [];
	while (dvi[p] !== 249) {
		const op = dvi[p];
		if (op === undefined || op < 243 || op > 246)
			throw new Error(`opcode ${op} inside the DVI postamble`);
		p += 1 + (op - 242) + 12; // fnt_defN: an N-byte font number, then checksum, size and design size
		const area = dvi[p] ?? 0;
		const length = dvi[p + 1] ?? 0;
		fonts.push(Buffer.from(dvi.subarray(p + 2 + area, p + 2 + area + length)).toString('latin1'));
		p += 2 + area + length;
	}
	return fonts;
}

/** The faces the plugin ships a web font for (scripts/gen-styles.mjs reads the same directory). */
const shippedFaces = new Set(
	readdirSync(join(DIST, 'fonts'))
		.filter((f) => f.endsWith('.woff2'))
		.map((f) => f.slice(0, -'.woff2'.length)),
);

/**
 * A Computer Modern face the plugin can draw with. Anything else — tcrm1000 for the TS1 symbols,
 * ecrm1000 for T1 — is a font dvi2html has no metrics for or the plugin no glyphs for, and the
 * character would come out as an error or in a fallback font.
 */
const drawable = (font) => /^cm[a-z]*[0-9]+$/.test(font) && shippedFaces.has(font);

/**
 * Native means all of: no `!` line and no lost glyph in the transcript, a DVI written, nothing in
 * that DVI set in a font other than a shipped Computer Modern face, and an SVG out of dvi2html.
 *
 * Each is there because a character fails it on this engine. `!` catches the undeclared (开 — "not
 * set up for use with LaTeX") and the declared-but-unavailable (ą — "Command \k unavailable in
 * encoding OT1"). The fonts catch ° and €, which compile cleanly into tcrm1000. The SVG catches Ł,
 * which compiles cleanly in cmr10 and then throws inside dvi2html. A lost glyph ("Missing
 * character", printed because the format sets \tracinglostchars=2) would be a silent blank.
 *
 * `Output written on` is required in the transcript as well as a DVI on disk, so that a transcript
 * that was never captured cannot pass as one with no errors in it.
 */
function classify(result) {
	const error = result.log.find((l) => l.startsWith('!'));
	if (error) return { native: false, reason: error.trim() };
	const lost = result.log.find((l) => l.startsWith('Missing character'));
	if (lost) return { native: false, reason: lost.trim() };
	if (
		!result.dvi ||
		result.dvi.byteLength === 0 ||
		!result.log.some((l) => l.includes('Output written on'))
	)
		return { native: false, reason: 'no DVI written' };
	const fonts = dviFonts(result.dvi);
	const foreign = fonts.filter((f) => !drawable(f));
	if (foreign.length > 0) return { native: false, reason: `font ${foreign.join(', ')}`, fonts };
	if (result.convertError !== undefined)
		return { native: false, reason: `dvi2html: ${result.convertError}` };
	if (!result.svg.includes('<svg')) return { native: false, reason: 'no SVG' };
	return { native: true, reason: 'clean', fonts };
}

/**
 * Two probes whose answers are known, run before anything is recorded. A harness that lost the
 * transcript would find no `!` lines anywhere and call every character native — 开 included, since
 * its DVI holds nothing but the two x's in cmr10. These make that failure stop the scan instead of
 * becoming the committed list.
 */
for (const [ch, expected] of [
	['é', true],
	['开', false],
]) {
	const verdict = classify(await render(probeFor(ch)));
	if (verdict.native !== expected) {
		console.error(
			`control failed: ${ch} came out ${verdict.native ? 'native' : 'not native'} (${verdict.reason}), ` +
				`expected ${expected ? 'native' : 'not native'}. The harness, not the engine, is wrong.`,
		);
		process.exit(2);
	}
}

const inRanges = (cp) => RANGES.some(([a, b]) => cp >= a && cp <= b);
const elsewhere = [...declared].filter((cp) => !inRanges(cp)).sort((a, b) => a - b);
const probes = [
	...RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)),
	...elsewhere,
];
probes.sort((a, b) => a - b);

const probeStarted = performance.now();
const native = [];
const reasons = new Map();
const fontsSeen = new Set();

for (const cp of probes) {
	const verdict = classify(await render(probeFor(String.fromCodePoint(cp))));
	if (verdict.native && !declared.has(cp)) {
		console.error(
			`U+${hex(cp)} renders natively but the census says the format does not declare it. ` +
				'The census is missing characters and cannot be trusted to rule any out.',
		);
		process.exit(2);
	}
	if (verdict.native) {
		native.push(cp);
		for (const f of verdict.fonts ?? []) fontsSeen.add(f);
	} else {
		// Grouped for the summary, where the codepoint inside an inputenc message is noise.
		const key = verdict.reason.replace(/\^\^[0-9a-f]{2}/g, '').replace(/\(U\+[0-9A-F]+\)/, '(U+…)');
		reasons.set(key, (reasons.get(key) ?? 0) + 1);
	}
	if (VERBOSE) console.log(`U+${hex(cp)} ${verdict.native ? 'native' : '------'}  ${verdict.reason}`);
}
const probeSeconds = (performance.now() - probeStarted) / 1000;

for (const [first, last, name] of RANGES) {
	const found = native.filter((cp) => cp >= first && cp <= last).length;
	console.log(`  U+${hex(first)}–U+${hex(last)}  ${String(found).padStart(3)} native  ${name}`);
}
const foundElsewhere = native.filter((cp) => !inRanges(cp));
console.log(
	`  elsewhere      ${String(foundElsewhere.length).padStart(3)} native  ` +
		`of the ${elsewhere.length} declared outside those ranges`,
);

// --- the module -----------------------------------------------------------------------------------

/** Consecutive codepoints as [first, last] pairs. */
function runsOf(codepoints) {
	const runs = [];
	for (const cp of codepoints) {
		const lastRun = runs[runs.length - 1];
		if (lastRun && lastRun[1] === cp - 1) lastRun[1] = cp;
		else runs.push([cp, cp]);
	}
	return runs;
}

/**
 * The character itself, for the comment beside its range — but only when it is visible. A no-break
 * or thin space printed into a comment is invisible to a reviewer and is exactly what lint rules
 * against irregular whitespace exist to reject.
 */
const glyph = (cp) => {
	const ch = String.fromCodePoint(cp);
	return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(ch) ? ` ${ch}` : '';
};

const literal = (cp) => `0x${cp.toString(16).padStart(4, '0')}`;

/** `parts` joined with ", " into lines of at most `width`, the continuation lines indented. */
function wrap(parts, width, indent) {
	const lines = [];
	for (const part of parts) {
		const line = lines[lines.length - 1];
		if (line !== undefined && line.length + part.length + 2 <= width)
			lines[lines.length - 1] = `${line}, ${part}`;
		else lines.push(part);
	}
	return lines.join(`,\n${indent}`);
}

function renderModule(engineId) {
	const runs = runsOf(native);
	const ranges = runsOf(RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))).map(
		([a, b]) => `U+${hex(a)}–U+${hex(b)}`,
	);
	const lines = runs.map(([a, b]) => {
		const comment =
			a === b ? `U+${hex(a)}${glyph(a)}` : `U+${hex(a)}${glyph(a)} – U+${hex(b)}${glyph(b)}`;
		return `\t[${literal(a)}, ${literal(b)}], // ${comment}`;
	});
	const pad = ' *           ';

	return `/*
 * GENERATED by scripts/scan-native-unicode.mjs — do not edit; re-run \`npm run scan:native\` after an
 * engine rebuild. \`npm run scan:native -- --check\` fails when this file and the engine disagree.
 *
 * Engine    ENGINE_ID ${engineId}
 * Declared  ${declared.size} codepoints in U+0080–U+10FFFF have a definition in the format. TeX leaves
 *           every other one out with "not set up for use with LaTeX", so none of those is native.
 * Probed    ${probes.length} codepoints, one TeX run each: all of
 *           ${wrap(ranges, 88, pad)},
 *           and the ${elsewhere.length} declared codepoints outside them.
 * Native    ${native.length} codepoints in ${runs.length} runs.
 *
 * A codepoint is native when \`\\node {x<it>x};\` compiles on that engine with no \`!\` line and no
 * lost glyph in the transcript, writes a DVI that dvi2html converts to SVG, and sets every
 * character in a Computer Modern face the plugin ships. A codepoint from U+0080 up that is not
 * listed is not native on that engine. ASCII is TeX's own and is not listed at all.
 *
 * It imports nothing, and must not: the engine worker bundles it for its Unicode bridge
 * (engine-src/unicode.ts), which draws every character not listed here, and should pull nothing
 * else in with it.
 */

/** Native codepoints as inclusive [first, last] runs, ascending and non-overlapping. */
export const NATIVE_UNICODE_RANGES: ReadonlyArray<readonly [number, number]> = [
${lines.join('\n')}
];

/** Whether the engine typesets this non-ASCII codepoint by itself. Binary search over the runs. */
export function isNativeUnicode(codepoint: number): boolean {
	let lo = 0;
	let hi = NATIVE_UNICODE_RANGES.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const run = NATIVE_UNICODE_RANGES[mid];
		if (run === undefined) return false;
		if (codepoint < run[0]) hi = mid - 1;
		else if (codepoint > run[1]) lo = mid + 1;
		else return true;
	}
	return false;
}
`;
}

// Hash the newly measured table, not a stale copy on disk, with a placeholder for its own stamp.
const measuredTable = {
	name: 'measured-native-table',
	setup(build) {
		build.onLoad({ filter: /[\\/]src[\\/]source[\\/]native-unicode\.ts$/ }, () => ({
			contents: renderModule('0'.repeat(64)),
			loader: 'ts',
		}));
	},
};
const { engineId } = await buildWorker(root, { plugins: [measuredTable] });
const generated = renderModule(engineId);

console.log(
	`\n${native.length} native of ${probes.length} probed; ${declared.size} declared. ` +
		`Census ${censusSeconds.toFixed(1)} s, probes ${probeSeconds.toFixed(1)} s ` +
		`(${((probeSeconds * 1000) / probes.length).toFixed(1)} ms each). ` +
		`Fonts used: ${[...fontsSeen].sort().join(', ')}.`,
);
console.log('Not native, by reason:');
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
	console.log(`  ${String(count).padStart(4)}  ${reason}`);

// --- write or check -------------------------------------------------------------------------------

/** The codepoints a committed module lists, read back out of its own range literals. */
function committedCodepoints(text) {
	const out = [];
	for (const m of text.matchAll(/^\t\[0x([0-9a-f]+), 0x([0-9a-f]+)\],/gm)) {
		for (let cp = parseInt(m[1], 16); cp <= parseInt(m[2], 16); cp++) out.push(cp);
	}
	return out;
}

if (CHECK) {
	// Line endings normalised, as engine-assets.mjs does for the sources it hashes: a Windows
	// checkout has this file in CRLF and the same commit must pass there and on Linux.
	const committed = existsSync(TARGET) ? readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : undefined;
	if (committed === generated) {
		console.log(`\n${TARGET_NAME} matches the committed engine.`);
		process.exit(0);
	}

	console.error(`\n${TARGET_NAME} does not match the committed engine.`);
	if (committed === undefined) {
		console.error('  The file does not exist.');
	} else {
		const was = new Set(committedCodepoints(committed));
		const now = new Set(native);
		const label = (cp) => `U+${hex(cp)}${glyph(cp)}`;
		const added = native.filter((cp) => !was.has(cp));
		const removed = [...was].filter((cp) => !now.has(cp));
		const stampedId = /ENGINE_ID ([0-9a-f]+)/.exec(committed)?.[1];
		if (added.length) console.error(`  Now native, not in the file: ${added.map(label).join(', ')}`);
		if (removed.length)
			console.error(`  In the file, no longer native: ${removed.map(label).join(', ')}`);
		if (stampedId !== engineId)
			console.error(
				`  It was measured on ENGINE_ID ${stampedId ?? '(none)'}; the engine is now ${engineId}.`,
			);
		if (!added.length && !removed.length && stampedId === engineId)
			console.error('  The set and the engine are the same; the file was edited by hand.');
		else if (!added.length && !removed.length)
			console.error('  The set itself is unchanged — only the engine it was measured on.');
	}
	console.error('Run `npm run scan:native` and commit the result.');
	process.exit(1);
}

const before = existsSync(TARGET) ? readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : undefined;
writeFileSync(TARGET, generated);
console.log(`\n${before === generated ? 'Unchanged' : 'Wrote'} ${TARGET_NAME}.`);
