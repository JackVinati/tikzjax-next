/*
 * TeX worker.
 *
 * Forked from drgrice1/tikzjax src/run-tex.js @ 461ac15f (GPL-3.0-or-later). Copyright the
 * original authors: Jim Fowler, Glenn Rice. Modified by JackVinati in 2026, as listed below.
 * This file remains GPL-3.0-or-later. See NOTICE.
 *
 * CHANGES FROM UPSTREAM (internal/DECISIONS.md D10):
 *  - assets are injected at build time instead of fetched from a urlRoot;
 *  - the WebAssembly.Module is compiled ONCE, not on every render;
 *  - no `coredump.slice(0)` — at pages=2500 that copy is 156.25 MiB per render — and the dump
 *    ships as its non-zero runs, packed by the build, which are all that is inflated at boot and
 *    all that a run's fresh Memory has written into it, since it is zero everywhere else already
 *    (./core-dump, ./inflate);
 *  - \begin{document} wrapping is conditional (upstream nests it into every existing vault), and the
 *    input is assembled in ./document, with a TS1 shim for a block that can use one (./ts1-shim);
 *  - \nonstopmode, so a TeX error is logged instead of blocking on the interactive `? ` prompt;
 *  - errors are classified and returned, not swallowed into a broken-image marker;
 *  - threads.js is replaced by the tagged protocol in ./protocol.ts;
 *  - TeX can be run TWICE, opt-in per block, so a second run can read the first run's .aux;
 *  - dvi2html is bundled with its TFM reader patched to read the last character of every font, and
 *    its glyph map to fall back to the face's own codepoint for a character the map lacks
 *    (scripts/dvi2html-patch.mjs), without which ä, ö, ü, \spadesuit, Ł and ł lose the whole diagram.
 */

// `buffer/` with the trailing slash, which is the specifier that CANNOT resolve to Node's builtin:
// it forces the npm package — feross's browser implementation — and it is a direct dependency so it
// cannot vanish when dvi2html changes its own. esbuild bundles it into the worker string, so
// nothing is required at runtime and iOS behaves exactly like the desktop.
//
// It is here because dvi2html's parser reads its input with Buffer methods: hand it a bare
// ArrayBuffer and it parses zero opcodes and silently returns an empty document.
import { Buffer } from 'buffer/';
import { ungzip } from 'pako';
import { dvi2html } from '@drgrice1/dvi2html';
import * as library from './library';
import { describeConvertError } from './convert-error';
import { buildInput } from './document';
import { inflateExactly } from './inflate';
import { checkCoreDump, packedLength, startingMemory, unpackCoreDump } from './core-dump';
import {
	CORE_DUMP_GZ,
	CORE_DUMP_RUNS,
	CORE_DUMP_SIZE,
	ENGINE_ID,
	INVENTORY,
	TEX_FILES,
	TEX_WASM_GZ,
} from 'virtual:engine-assets';
import type {
	ErrorMessage,
	OkMessage,
	RenderOptions,
	RenderTimings,
	TexErrorKind,
	WorkerRequest,
} from './protocol';
import { restoreUnicode } from './unicode';

// --- base64 -------------------------------------------------------------------------------------

const fromBase64 = (b64: string): Uint8Array => {
	// Uint8Array.fromBase64 lands in newer engines and decodes several times faster than the
	// atob loop, which matters for a 5.9 MB core dump on a phone.
	const fromB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
	if (typeof fromB64 === 'function') return fromB64(b64);

	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};

// --- engine boot --------------------------------------------------------------------------------

/**
 * Bundled TeX inputs, still gzipped. They are inflated lazily on first use and then cached for
 * the lifetime of the worker (library.ts), so a vault full of diagrams pays for the pgf tree once.
 */
const bundled = new Map<string, Uint8Array>();
for (const [name, b64] of Object.entries(TEX_FILES)) bundled.set(name, fromBase64(b64));

library.setBundledFiles(bundled, (gz) => ungzip(gz));

/**
 * Compiled once. Upstream calls WebAssembly.instantiate() with the raw bytes on every render,
 * which recompiles its 526 KB of wasm each time (this engine, without asyncify, is 356 KB);
 * instantiating a Module reuses the compiled code.
 */
const texModule = new WebAssembly.Module(ungzip(fromBase64(TEX_WASM_GZ)));

/**
 * The dump's non-zero runs, 22.3 MiB of its 156.25, which the build packed back to back
 * (scripts/engine-assets.mjs `packCoreDump`): they are all a run's fresh Memory needs written into
 * it (./core-dump). Inflating the whole dump took half a second of every boot on the desktop.
 *
 * Inflated straight into one buffer of the size the runs add up to, and asserted to be exactly that
 * size. Not `ungzip`, which glues 64 KiB chunks into a copy and so holds the bytes twice (./inflate).
 * The dump has to fill the Memory exactly, or live TeX state would start at zero — a corruption
 * that would surface much later as garbage output — so that is checked here, at boot.
 */
const coreDump = unpackCoreDump(
	CORE_DUMP_SIZE,
	CORE_DUMP_RUNS,
	inflateExactly(fromBase64(CORE_DUMP_GZ), packedLength(CORE_DUMP_RUNS)),
);
checkCoreDump(coreDump, library.pages);

// --- transcript analysis --------------------------------------------------------------------------

const FIRST_ERROR = /^!\s?(.*)$/;
const LINE_BLAME = /^l\.(\d+)\s?(.*)$/;
const CAPACITY = /^!\s*TeX capacity exceeded/;
const MISSING_FILE = /^!\s*(?:I can't find file|LaTeX Error: File)\s*[`'"]?([^'"`\n]+)/;

interface Diagnosis {
	kind: TexErrorKind;
	message: string;
	firstError?: string | undefined;
	line?: number | undefined;
}

/** What the transcript says, independent of whether TeX managed to emit anything. */
interface Transcript {
	firstError?: string | undefined;
	line?: number | undefined;
	kind?: TexErrorKind | undefined;
	fileName?: string | undefined;
}

/**
 * Read the transcript — always, not only on failure.
 *
 * Matching `^!` and nothing else is deliberate. `Overfull \hbox` and `Underfull` are routine with
 * node text, and a parser that treats any unrecognised line as the start of an error would put a
 * red box on a perfectly good diagram — worse than the broken image it replaces.
 */
const readTranscript = (log: string[]): Transcript => {
	for (let i = 0; i < log.length; i++) {
		const raw = log[i] ?? '';
		const m = FIRST_ERROR.exec(raw);
		if (!m) continue;

		const firstError = m[1]?.trim();
		let line: number | undefined;
		// TeX wraps stdout at ~79 columns, so the blame line lands a few lines below.
		for (let j = i + 1; j < Math.min(i + 8, log.length); j++) {
			const lm = LINE_BLAME.exec(log[j] ?? '');
			if (lm) {
				line = Number(lm[1]);
				break;
			}
		}

		if (CAPACITY.test(raw)) return { firstError, line, kind: 'capacity' };
		const fm = MISSING_FILE.exec(raw);
		if (fm) return { firstError, line, kind: 'missing-file', fileName: fm[1] };
		return { firstError, line, kind: 'tex-error' };
	}
	return {};
};

/** Turn a transcript, plus the absence of output, into a classified failure. */
const diagnose = (t: Transcript, missing: string[]): Diagnosis => {
	if (t.kind === 'capacity') {
		return {
			kind: 'capacity',
			message: t.firstError ?? 'TeX capacity exceeded',
			firstError: t.firstError,
			line: t.line,
		};
	}
	if (t.kind === 'missing-file') {
		return {
			kind: 'missing-file',
			message: t.fileName ?? 'a file',
			firstError: t.firstError,
			line: t.line,
		};
	}
	if (t.kind === 'tex-error') {
		return {
			kind: 'tex-error',
			message: t.firstError ?? 'TeX error',
			firstError: t.firstError,
			line: t.line,
		};
	}

	// `missing` is dominated by benign probes, so it becomes evidence only once TeX has both
	// produced nothing and said nothing.
	const suspicious = missing.filter((n) => !/\.(aux|log|dvi|toc|out|nav|snm)$/.test(n));
	if (suspicious.length) {
		return {
			kind: 'missing-file',
			message: suspicious[0] ?? 'a file',
			firstError: t.firstError,
			line: t.line,
		};
	}
	return {
		kind: 'empty-output',
		message: 'TeX produced no output.',
		firstError: t.firstError,
		line: t.line,
	};
};

/**
 * A run cut off by the engine's stack (runPass). A limit TeX ran into, though not one of its own, so
 * it is reported as one of them is: TeX ran out of room. Whatever TeX said before it still counts.
 */
const overflowed = (t: Transcript): Diagnosis => ({
	kind: 'capacity',
	message: "TeX nested deeper than the engine's stack allows.",
	firstError: t.firstError,
	line: t.line,
});

// --- two passes ----------------------------------------------------------------------------------

/*
 * `\label`, `\ref`, `\pageref` and the `remember picture` family resolve against the `.aux` a
 * PREVIOUS run wrote. The engine ran TeX once and then wiped the virtual filesystem, so that file
 * never survived to be read and those constructs could never resolve. RenderOptions.twoPass keeps
 * the first run's files and runs TeX again on top of them.
 *
 * MEASURED, and it decides how much this is worth (engine-build/out/BUILD-MANIFEST.txt, the 2023
 * apt build):
 *
 *   - `\label`/`\ref`/`\pageref` DO get fixed. A `\refstepcounter{equation}\label{e}` followed by a
 *     picture whose node reads `\ref{e}` draws `??` on one pass and `1` on two, and pass two's
 *     transcript no longer carries "LaTeX Warning: There were undefined references."
 *   - upstream #9 (`\chemmove` arrows mispositioned) and #70 (`\polymerdelim` not rendered) are
 *     NOT fixed, and cannot be by any number of passes on this engine. Both need pgf position
 *     tracking, which writes `\pgfsyspdfmark`-style entries into the .aux — and this build's
 *     driver does not implement it. The first pass says so itself:
 *
 *         Package pgf Warning: Your graphic driver pgfsys-ximera.def does not support
 *         marking the current position.
 *
 *     so the .aux comes back holding nothing but boilerplate and the second pass is handed no new
 *     information. Verified: every chemfig/tikz fixture in test/fixtures/tex writes a 32-byte .aux
 *     and renders byte-identical SVG on one pass and two. #9 and #70 stay open behind engine work
 *     (internal/BACKLOG.md, track E1 — a driver that emits position marks), not behind this flag.
 *
 * The flag ships anyway because the cross-reference family is real, and because the plumbing is
 * what a future driver needs in place. It is opt-in per block for the obvious reason: it is two
 * compiles.
 */

/* TWOPASS:BEGIN — test/twopass.test.ts extracts this block and runs it; keep it self-contained. */

const FIRST_JOB = 'input';

/**
 * The second run's job name.
 *
 * It cannot be `input` again. library.readFileSync() returns the FIRST file in the run's table
 * with a matching name, and the first pass's `input.dvi` is still in that table — so a second run
 * writing `input.dvi` would hand us pass one's bytes back and the whole feature would silently
 * render nothing new. A distinct job name is also what keeps `library.deleteEverything()` at
 * exactly one call, at the end, rather than needing a wipe between passes to free the name.
 *
 * Measured, because the failure is silent: with both passes named `input`, a `\refstepcounter
 * \label` + `\ref` block still runs twice, still logs the second-pass marker, and still comes back
 * with pass one's 899-byte `??` render instead of the 761-byte resolved one. Nothing else in the
 * pipeline notices. Both names are inside the tested block so a change to either is caught.
 */
const SECOND_JOB = 'input2';

/**
 * What a run leaves behind that the NEXT run reads back: library.ts's JOB_LOCAL list, less the two
 * that are outputs rather than inputs (`.dvi`, `.log`) and less beamer's `.nav`/`.snm`, which this
 * bundle has no class to produce.
 */
const CARRIED = ['aux', 'toc', 'out'] as const;

/**
 * The lines LaTeX writes into its `.aux` whether or not anything used them: the leading `\relax`
 * and atveryend's page count.
 *
 * Measured rather than guessed — all 21 fixtures in test/fixtures/tex produce exactly these two
 * lines, 32 bytes, and nothing else.
 */
const AUX_BOILERPLATE = /^(?:\\relax|\\gdef\s*\\@abspage@last\s*\{\d+\})$/;

/** One file the first pass wrote, as it will be handed to the second. */
interface CarriedFile {
	name: string;
	text: string;
}

/**
 * Can a second pass differ from the first?
 *
 * Only if the first pass left something behind for it to read. That is the whole mechanism, so it
 * is the whole test: no payload, no second compile, and the flag costs nothing on a block it
 * cannot help — which on this engine is every `\chemmove` and `\polymerdelim` block there is.
 *
 * Deliberately NOT keyed on the transcript. "LaTeX Warning: There were undefined references." is
 * the obvious signal and it is the wrong one: `\ref{nope}` with no matching `\label` anywhere
 * warns on every pass and writes nothing, so it would buy a second compile that cannot possibly
 * resolve anything. Every case where a rerun genuinely helps writes payload first.
 */
const secondPassWarranted = (carried: readonly CarriedFile[]): boolean =>
	carried.some((file) =>
		file.text.split('\n').some((raw) => {
			const line = raw.trim();
			return line.length > 0 && !AUX_BOILERPLATE.test(line);
		}),
	);

/**
 * Which stretch of the shared transcript describes the diagram being reported.
 *
 * Both passes write into ONE log array, so "what went wrong" has to be answered by position.
 * Pass one's stretch is the answer unless pass one said nothing AND the diagram on screen is
 * pass two's.
 *
 * The `adoptedSecondPass` half of that is not optional, and it is what this got wrong. A second
 * pass whose output was DISCARDED — it wrote no DVI, or nothing drawable — still leaves its `!`
 * lines in the shared log, and reading them back attaches a diagnostic, with an `l.NN` blaming
 * `input2.tex`, to a diagram pass one compiled cleanly. `OkMessage.firstError` means "TeX
 * complained about the diagram you are looking at", and the plugin puts a warning on the block
 * because of it; a run whose bytes were thrown away has no standing to say anything.
 *
 * Reproduced on the real engine before fixing: a source that errors only once `\r@e` exists
 * (`\@ifundefined{r@e}{}{\errmessage{...}\csname @@end\endcsname}`) renders the same 899 B on one
 * pass and two — pass two writes no pages — and used to come back carrying pass two's error.
 */
const reportedRange = (
	logLength: number,
	firstEnd: number,
	adoptedSecondPass: boolean,
	firstPassSpoke: boolean,
): { from: number; to: number } =>
	adoptedSecondPass && !firstPassSpoke ? { from: firstEnd, to: logLength } : { from: 0, to: firstEnd };

/* TWOPASS:END */

// --- render --------------------------------------------------------------------------------------

const dviToSvg = async (dvi: Uint8Array): Promise<string> => {
	let out = '';
	// dvi2html only ever calls write() and end() on its output (verified against the shipped
	// bundle), so a small sink is enough and avoids pulling in stream-browserify, which upstream
	// bundles for exactly this.
	const sink = {
		write(chunk: unknown, _enc?: unknown, cb?: () => void) {
			out += String(chunk);
			cb?.();
			return true;
		},
		end(cb?: () => void) {
			cb?.();
		},
	};

	// The chunk must be Buffer-like, not a bare ArrayBuffer: dvi2html's parser reads it with
	// Buffer methods, and handing it an ArrayBuffer parses zero opcodes and silently yields an
	// empty string — a successful TeX run that looks like an engine failure.
	// eslint-disable-next-line @typescript-eslint/require-await -- dvi2html wants an async iterable; the single chunk is already in memory.
	async function* stream() {
		yield Buffer.from(dvi);
	}
	await (dvi2html as (i: AsyncGenerator<Buffer>, o: unknown) => Promise<unknown>)(stream(), sink);
	return out;
};

/** What one TeX run produced. `convertError` is set only when TeX wrote a DVI we could not draw. */
interface PassResult {
	svg: string;
	wroteDvi: boolean;
	convertError?: string | undefined;
	/** TeX nested deeper than the engine's stack holds, and the run was cut off there. */
	overflowed?: boolean | undefined;
}

/**
 * Run TeX once over `<job>.tex`, which must already be in the virtual filesystem, and draw
 * `<job>.dvi`. Everything the run leaves behind stays there for the caller to harvest or discard.
 * What each step took is added to `spent`.
 */
const runPass = async (job: string, spent: RenderTimings): Promise<PassResult> => {
	const started = performance.now();
	// A new Memory with the dump's non-zero runs written into it: 22.3 MiB rather than all 156.25,
	// the rest being zero from the start. Upstream also copies the dump with .slice(0) first, an
	// extra 156.25 MiB allocated and discarded on every single render.
	const memory = startingMemory(coreDump, library.pages);
	const reset = performance.now();

	library.setMemory(memory.buffer);
	library.setInput(`${job}.tex\n\\end\n`);

	let svg = '';
	let wroteDvi = false;
	let convertError: string | undefined;
	let overflowed = false;
	// When TeX was done, and when drawing its DVI began. A run that throws out of TeX sets neither,
	// and all of its time is TeX's; one that wrote no DVI drew nothing, and spent nothing drawing.
	let texDone: number | undefined;
	let drawing: number | undefined;
	try {
		const instance = await WebAssembly.instantiate(texModule, {
			library,
			env: { memory },
		});
		await library.executeAsync(instance.exports);
		texDone = performance.now();

		const dvi = library.readFileSync(`${job}.dvi`);
		wroteDvi = dvi.byteLength > 0;
		if (wroteDvi) {
			drawing = performance.now();
			svg = await dviToSvg(dvi);
		}
	} catch (error) {
		// Very different things land here, and telling them apart is the difference between a
		// useful message and a shrug:
		//   - readFileSync throws when TeX never wrote a DVI at all;
		//   - dvi2html throws when the DVI names a font its built-in metric table does not carry
		//     (eufm10, rsfs10, tcrm1000 ...), which is a SUCCESSFUL TeX run we cannot draw.
		//     See ./convert-error for what the user is told;
		//   - TeX itself is cut off by the stack it runs on. Each level of an expansion, or of a box
		//     inside a box, is a few calls deeper in the engine, and something that nests itself a
		//     few thousand deep runs out of the worker's stack before it reaches any limit of TeX's
		//     own, so TeX says nothing and closes no file. V8 and JavaScriptCore throw a RangeError.
		// Swallowing them all produced "TeX produced no output" for a compile that worked perfectly.
		if (wroteDvi) convertError = error instanceof Error ? error.message : String(error);
		else if (texDone === undefined && error instanceof RangeError) overflowed = true;
	}

	const done = performance.now();
	spent.resetMs += reset - started;
	spent.texMs += (texDone ?? done) - reset;
	spent.svgMs += drawing === undefined ? 0 : done - drawing;
	spent.passes += 1;
	return { svg, wroteDvi, convertError, overflowed };
};

/** `spent` as the plugin is told it: whole milliseconds, which is all a person reading it needs. */
const rounded = (spent: RenderTimings): RenderTimings => ({
	resetMs: Math.round(spent.resetMs),
	texMs: Math.round(spent.texMs),
	svgMs: Math.round(spent.svgMs),
	passes: spent.passes,
});

/** A file the run wrote, or undefined if it never wrote one. */
const readIfWritten = (name: string): Uint8Array | undefined => {
	try {
		const bytes = library.readFileSync(name);
		return bytes.byteLength > 0 ? bytes : undefined;
	} catch {
		// readFileSync throws for "never written", which is the ordinary case for every one of
		// CARRIED and is not worth distinguishing from "written empty".
		return undefined;
	}
};

async function render(id: number, source: string, options: RenderOptions): Promise<OkMessage | ErrorMessage> {
	const started = performance.now();
	const log: string[] = [];
	const missing: string[] = [];

	const emit = (line: string) => {
		log.push(line);
		// Streamed as well as buffered: a long compile should be watchable in the debug view
		// rather than arriving all at once at the end.
		if (options.captureLog) post({ type: 'log', id, line });
	};

	library.setLogSink(emit);
	// Recorded once per render, not once per open. Two passes probe for exactly the same files, so
	// without this every miss is reported twice the moment `twoPass` is on — the same name listed
	// twice tells a reader nothing it did not already know from the first entry.
	library.setMissingFileSink((name) => {
		if (!missing.includes(name)) missing.push(name);
	});
	const logging = options.captureLog !== false;
	if (logging) library.setShowConsole();

	// Both passes read this same text, so `bodyLine` holds for an `l.NN` from either.
	const { text, bodyLine, unicode } = buildInput(source, options);
	const input = new TextEncoder().encode(text);
	/** Where the time went, over both passes when there are two. */
	const spent: RenderTimings = { resetMs: 0, texMs: 0, svgMs: 0, passes: 0 };

	/** Where the first pass's transcript ends, so its diagnosis can never be read out of pass two. */
	let firstEnd: number;
	/** The pass whose diagram is being reported. Pass one unless pass two bettered it. */
	let reported: PassResult;
	/** Whether the diagram being reported is pass two's. Decides whose transcript describes it. */
	let adoptedSecondPass = false;
	/** What the first pass wrote to TeX's transcript file, `input.log`, when the log is kept. */
	let firstTranscriptFile: Uint8Array | undefined;
	try {
		library.writeFileSync(`${FIRST_JOB}.tex`, input);
		const first = await runPass(FIRST_JOB, spent);
		firstEnd = log.length;
		reported = first;
		if (logging) firstTranscriptFile = readIfWritten(`${FIRST_JOB}.log`);

		// A second pass is attempted only after a first pass that produced a drawable diagram: if
		// pass one failed, ITS transcript is the answer, and re-running would only replace one
		// failure with another. Its result is adopted only if it also produced one, so the feature
		// can improve a diagram but never take one away.
		if (options.twoPass === true && first.wroteDvi && first.svg.includes('<svg')) {
			const carried: { name: string; text: string; bytes: Uint8Array }[] = [];
			const decoder = new TextDecoder();
			for (const ext of CARRIED) {
				const bytes = readIfWritten(`${FIRST_JOB}.${ext}`);
				if (bytes) carried.push({ name: `${SECOND_JOB}.${ext}`, text: decoder.decode(bytes), bytes });
			}

			if (secondPassWarranted(carried)) {
				// The harvested bytes are copies (readFileSync slices), so writing them back under
				// the second job's name cannot alias the first pass's buffers.
				for (const file of carried) library.writeFileSync(file.name, file.bytes);
				library.writeFileSync(`${SECOND_JOB}.tex`, input);

				// Through the same sink as TeX's own output, so a streamed debug view sees the
				// boundary rather than a second unexplained "This is e-TeX" banner. Only when the
				// transcript is being kept at all — a run with logging off should not come back
				// with one invented line in it. It can never be mistaken for a diagnostic either:
				// readTranscript only ever matches `^!`.
				if (logging)
					emit(`(tikzjax) second pass: re-running with ${carried.map((f) => f.name).join(', ')}`);

				const second = await runPass(SECOND_JOB, spent);
				if (second.wroteDvi && second.svg.includes('<svg')) {
					reported = second;
					adoptedSecondPass = true;
				}
			}
		}
	} finally {
		// Still exactly once, and still at the end however many passes ran. The inflated
		// bundled-file cache survives it by design (library.ts change 3).
		library.deleteEverything();
	}

	const durationMs = Math.round(performance.now() - started);
	const timings = rounded(spent);
	const gotSvg = reported.svg.includes('<svg');
	let transcript = readTranscript(log.slice(0, firstEnd));

	// \batchmode sends everything TeX says after it to the transcript file and nothing to the
	// terminal, so a diagram that put TeX in batch mode and then failed came back with no error at
	// all, and a hundredth error read as "TeX produced no output". When the terminal shows no error,
	// the file is read too, and if it has one, its lines join the log, after pass one's, under a line
	// that says where they come from.
	if (transcript.firstError === undefined && firstTranscriptFile !== undefined) {
		// Without its blank lines, as the terminal comes (library.ts writeToConsole). The file keeps
		// them, and between a LaTeX error and TeX's `l.NN` they pushed the line past where
		// readTranscript looks for it, so the card named no line.
		const lines = new TextDecoder()
			.decode(firstTranscriptFile)
			.split('\n')
			.filter((line) => line.length > 0);
		const fromFile = readTranscript(lines);
		if (fromFile.firstError !== undefined) {
			transcript = fromFile;
			// Appended line by line rather than spread into one call: a traced run's file can hold
			// more lines than JavaScriptCore takes arguments.
			const later = log.splice(firstEnd);
			log.push(
				`(tikzjax) TeX said nothing more on the terminal; its transcript file, ${FIRST_JOB}.log, reads:`,
			);
			for (const line of lines) log.push(line);
			firstEnd = log.length;
			for (const line of later) log.push(line);
		}
	}

	// Pass one's transcript is what gets reported. A second pass that fails differently — or that
	// blames a line inside `input2.tex` — must not mask what the first run said. Pass two is
	// consulted only when pass one had nothing to say AND the diagram on screen is pass two's;
	// see reportedRange, which owns that rule and is where it is tested.
	const range = reportedRange(log.length, firstEnd, adoptedSecondPass, transcript.firstError !== undefined);
	const diagnostics = range.from === 0 ? transcript : readTranscript(log.slice(range.from, range.to));

	// Output decides success; the transcript decides what to say about it. Under \nonstopmode a
	// mistyped macro usually yields BOTH a diagram and an error, and the user needs both.
	if (reported.convertError !== undefined) {
		return {
			type: 'error',
			id,
			kind: 'missing-file',
			message: describeConvertError(reported.convertError),
			firstError: diagnostics.firstError,
			line: diagnostics.line,
			bodyLine,
			log,
			missing,
			durationMs,
			timings,
		};
	}

	if (!reported.wroteDvi || !gotSvg) {
		// Only ever reached with a failed FIRST pass — a failed second one is discarded above — so
		// `transcript` here is that pass's own, not a later run's.
		return {
			type: 'error',
			id,
			...(reported.overflowed ? overflowed(transcript) : diagnose(transcript, missing)),
			bodyLine,
			log,
			missing,
			durationMs,
			timings,
		};
	}
	// The characters ./unicode declared, written back over the boxes TeX set for them. When the
	// SVG's groups do not pair up, which a raw special in the diagram can do, that is what the card
	// says, with TeX's log: not that TeX produced nothing, and not an SVG with the text missing.
	let svg: string;
	try {
		svg = restoreUnicode(reported.svg, unicode);
	} catch (error) {
		return {
			type: 'error',
			id,
			kind: 'tex-error',
			message: error instanceof Error ? error.message : String(error),
			bodyLine,
			log,
			missing,
			durationMs,
			timings,
		};
	}
	return {
		type: 'ok',
		id,
		svg,
		log,
		missing,
		durationMs,
		timings,
		firstError: diagnostics.firstError,
		line: diagnostics.line,
		bodyLine,
	};
}

// --- message loop ----------------------------------------------------------------------------------

// Declared locally rather than by adding "WebWorker" to tsconfig's lib: that would put `self`,
// `close()` and `postMessage()` in scope for every file in the project, including the plugin,
// where they are exactly the wrong things to have available.
declare const self: {
	postMessage(message: unknown): void;
	onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const post = (message: unknown) => self.postMessage(message);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (request.type === 'ping') {
		post({ type: 'ok', id: request.id, svg: '', log: [], missing: [], durationMs: 0 });
		return;
	}
	if (request.type === 'render') {
		void render(request.id, request.source, request.options).then(post, (error: unknown) => {
			post({
				type: 'error',
				id: request.id,
				kind: 'engine-unavailable',
				message: error instanceof Error ? error.message : String(error),
				log: [],
				missing: [],
				durationMs: 0,
			} satisfies ErrorMessage);
		});
	}
};

post({ type: 'ready', engineId: ENGINE_ID, inventory: INVENTORY });
