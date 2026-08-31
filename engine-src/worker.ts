/*
 * TeX worker.
 *
 * Forked from drgrice1/tikzjax src/run-tex.js @ 461ac15f (GPL-3.0-or-later). Copyright the
 * original authors: Jim Fowler, Glenn Rice. This file remains GPL-3.0-or-later. See NOTICE.
 *
 * CHANGES FROM UPSTREAM (docs/DECISIONS.md D10):
 *  - assets are injected at build time instead of fetched from a urlRoot;
 *  - the WebAssembly.Module is compiled ONCE, not on every render;
 *  - no `coredump.slice(0)` — at pages=2500 that copy is 156.25 MiB per render;
 *  - \begin{document} wrapping is conditional (upstream nests it into every existing vault);
 *  - \nonstopmode, so a TeX error is logged instead of blocking on the interactive `? ` prompt;
 *  - errors are classified and returned, not swallowed into a broken-image marker;
 *  - threads.js is replaced by the tagged protocol in ./protocol.ts.
 */

import { Buffer } from 'buffer';
import { ungzip } from 'pako';
import { dvi2html } from '@drgrice1/dvi2html';
import * as library from './library';
import { CORE_DUMP_GZ, ENGINE_ID, INVENTORY, TEX_FILES, TEX_WASM_GZ } from 'virtual:engine-assets';
import type { ErrorMessage, OkMessage, RenderOptions, TexErrorKind, WorkerRequest } from './protocol';

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
 * which recompiles 526 KB of wasm each time; instantiating a Module reuses the compiled code.
 */
const texModule = new WebAssembly.Module(ungzip(fromBase64(TEX_WASM_GZ)));
const coreDump = ungzip(fromBase64(CORE_DUMP_GZ));

if (coreDump.length !== library.pages * 65536) {
	// The runtime .set()s the dump over the whole non-growable Memory, so a short dump would
	// leave live TeX state uninitialised — a corruption that would surface much later as garbage
	// output rather than as a failure here.
	throw new Error(`core dump is ${coreDump.length} B, expected ${library.pages * 65536} B`);
}

// --- document assembly --------------------------------------------------------------------------

const DOCUMENT_START = /\\begin\s*\{document\}/;

const buildInput = (source: string, options: RenderOptions): string => {
	const packages = Object.entries(options.texPackages ?? {})
		.map(([name, opts]) => `\\usepackage${opts ? `[${opts}]` : ''}{${name}}`)
		.join('');

	const libraries = options.tikzLibraries ? `\\usetikzlibrary{${options.tikzLibraries}}` : '';

	// \nonstopmode is why a bad diagram now produces a transcript instead of hanging. Without it
	// TeX reaches the interactive `? ` prompt and suspends the asyncify'd wasm, and a suspended
	// asyncify continuation cannot be resumed — only terminated. Upstream #18 #23 #27 #39 #51
	// #82 #85 #89, roughly 22 reporters, are all downstream of this one token.
	const preamble = `\\nonstopmode${packages}${libraries}${options.addToPreamble ?? ''}`;

	const wrap = options.wrap ?? 'auto';
	const needsWrap = wrap === 'always' || (wrap === 'auto' && !DOCUMENT_START.test(source));

	return needsWrap
		? `${preamble}\\begin{document}\n${source}\n\\end{document}\n`
		: `${preamble}\n${source}\n`;
};

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
		return { kind: 'capacity', message: t.firstError ?? 'TeX capacity exceeded', firstError: t.firstError, line: t.line };
	}
	if (t.kind === 'missing-file') {
		return { kind: 'missing-file', message: t.fileName ?? 'a file', firstError: t.firstError, line: t.line };
	}
	if (t.kind === 'tex-error') {
		return { kind: 'tex-error', message: t.firstError ?? 'TeX error', firstError: t.firstError, line: t.line };
	}

	// `missing` is dominated by benign probes, so it becomes evidence only once TeX has both
	// produced nothing and said nothing.
	const suspicious = missing.filter((n) => !/\.(aux|log|dvi|toc|out|nav|snm)$/.test(n));
	if (suspicious.length) {
		return { kind: 'missing-file', message: suspicious[0] ?? 'a file', firstError: t.firstError, line: t.line };
	}
	return { kind: 'empty-output', message: 'TeX produced no output.', firstError: t.firstError, line: t.line };
};

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
	async function* stream() {
		yield Buffer.from(dvi);
	}
	await (dvi2html as (i: AsyncGenerator<Buffer>, o: unknown) => Promise<unknown>)(stream(), sink);
	return out;
};

async function render(id: number, source: string, options: RenderOptions): Promise<OkMessage | ErrorMessage> {
	const started = performance.now();
	const log: string[] = [];
	const missing: string[] = [];

	library.setLogSink((line) => {
		log.push(line);
		// Streamed as well as buffered: a long compile should be watchable in the debug view
		// rather than arriving all at once at the end.
		if (options.captureLog) post({ type: 'log', id, line });
	});
	library.setMissingFileSink((name) => missing.push(name));
	if (options.captureLog !== false) library.setShowConsole();

	library.writeFileSync('input.tex', new TextEncoder().encode(buildInput(source, options)));

	const memory = new WebAssembly.Memory({ initial: library.pages, maximum: library.pages });
	// No .slice(0): upstream copies the dump before writing it, which at pages=2500 is an extra
	// 156.25 MiB allocated and discarded on every single render.
	new Uint8Array(memory.buffer, 0, library.pages * 65536).set(coreDump);

	library.setMemory(memory.buffer);
	library.setInput('input.tex\n\\end\n');

	let svg = '';
	let wroteDvi = false;
	let convertError: string | undefined;
	try {
		const instance = await WebAssembly.instantiate(texModule, {
			library,
			env: { memory },
		} as unknown as WebAssembly.Imports);
		await library.executeAsync(instance.exports);

		const dvi = library.readFileSync('input.dvi');
		wroteDvi = dvi.byteLength > 0;
		if (wroteDvi) svg = await dviToSvg(dvi);
	} catch (error) {
		// Two very different things land here, and telling them apart is the difference between a
		// useful message and a shrug:
		//   - readFileSync throws when TeX never wrote a DVI at all;
		//   - dvi2html throws when the DVI names a font its built-in metric table does not carry
		//     (eufm10, rsfs10, tcrm1000 ...), which is a SUCCESSFUL TeX run we cannot draw.
		// Swallowing both produced "TeX produced no output" for a compile that worked perfectly.
		if (wroteDvi) convertError = error instanceof Error ? error.message : String(error);
	} finally {
		library.deleteEverything();
	}

	const durationMs = Math.round(performance.now() - started);
	const gotSvg = svg.includes('<svg');
	const transcript = readTranscript(log);

	// Output decides success; the transcript decides what to say about it. Under \nonstopmode a
	// mistyped macro usually yields BOTH a diagram and an error, and the user needs both.
	if (convertError !== undefined) {
		const font = /Could not find font (\S+)/.exec(convertError)?.[1];
		return {
			type: 'error',
			id,
			kind: 'missing-file',
			message: font
				? `The font ${font} is not supported by the SVG converter.`
				: `The diagram compiled but could not be converted: ${convertError}`,
			firstError: transcript.firstError,
			line: transcript.line,
			log,
			missing,
			durationMs,
		};
	}

	if (!wroteDvi || !gotSvg) {
		return { type: 'error', id, ...diagnose(transcript, missing), log, missing, durationMs };
	}
	return {
		type: 'ok',
		id,
		svg,
		log,
		missing,
		durationMs,
		firstError: transcript.firstError,
		line: transcript.line,
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
