/*
 * TeX worker.
 *
 * Forked from drgrice1/tikzjax src/run-tex.js @ 461ac15f (GPL-3.0-or-later). Copyright the
 * original authors: Jim Fowler, Glenn Rice. Modified by JackVinati in 2026, as listed below.
 * This file remains GPL-3.0-or-later. See NOTICE.
 *
 * CHANGES FROM UPSTREAM (internal/DECISIONS.md D10):
 *  - assets come with the plugin instead of being fetched from a urlRoot: the host sends them as the
 *    worker's first message, which it starts from (D30);
 *  - the WebAssembly.Module is compiled ONCE, not on every render;
 *  - no `coredump.slice(0)` — at pages=2500 that copy is 156.25 MiB per render — and the dump
 *    ships as its non-zero runs, packed by the build, which are all that is inflated at boot and
 *    all that a new Memory has written into it, since it is zero everywhere else already
 *    (./core-dump, ./inflate);
 *  - one Memory per worker, not one per run: the dump is written back over only what the run before
 *    can have written, and a run that did not end normally leaves a new Memory to the next (./reset);
 *  - \begin{document} wrapping is conditional (upstream nests it into every existing vault), and the
 *    input is assembled in ./document, with a TS1 shim for a block that can use one (./ts1-shim);
 *  - \nonstopmode, so a TeX error is logged instead of blocking on the interactive `? ` prompt;
 *  - errors are classified and returned, not swallowed into a broken-image marker;
 *  - threads.js is replaced by the tagged protocol in ./protocol.ts;
 *  - TeX can be run TWICE, opt-in per block, so a second run can read the first run's .aux;
 *  - dvi2html is bundled with its TFM reader patched to read the last character of every font, and
 *    its glyph map to fall back to the face's own codepoint for a character the map lacks
 *    (scripts/dvi2html-patch.mjs), without which ä, ö, ü, \spadesuit, Ł and ł lose the whole diagram;
 *  - a first pass is saved where TeX stands once its \begin{document} is done, and a later one with
 *    the same input up to there starts from it, within a budget the host sends (./snapshot, D32);
 *  - a run it saved is handed to the host as bytes, which keeps it across the engine's stops and sends
 *    it back with a later diagram for a worker that holds none (./stored-run, D36).
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
import { buildInput, routeKey, routeOf } from './document';
import { gunzipExactly } from './inflate';
import { decodeSavedRun, encodeSavedRun, type ContentSources } from './stored-run';
import { compileProbeAsync, probeJit } from './jit';
import { checkCoreDump, packedLength, startingMemory, unpackCoreDump, type CoreDump } from './core-dump';
import { restoreSpans, writtenSpans, type RunMarks, type Span } from './reset';
import {
	diffAgainstDump,
	logBytes,
	saveSpans,
	SnapshotCache,
	stretchSpans,
	unionSpans,
	writeStretches,
	type SavedRun,
} from './snapshot';
import {
	CORE_DUMP_RUNS,
	CORE_DUMP_SIZE,
	CORE_LAYOUT,
	ENGINE_ID,
	INVENTORY,
	TEX_WASM_SIZE,
} from 'virtual:engine-assets';
import type {
	BootTimings,
	EngineAssets,
	ErrorMessage,
	OkMessage,
	RenderOptions,
	RenderTimings,
	SavedRunMessage,
	SnapshotState,
	StoredOutcome,
	StoredRun,
	TexErrorKind,
	WorkerRequest,
} from './protocol';
import { restoreUnicode } from './unicode';

// --- base64 -------------------------------------------------------------------------------------

/**
 * Uint8Array.fromBase64, where the platform has it: Safari 18.2, Chrome 140. It decodes several times
 * faster than anything written in JavaScript, which matters for a 7.9 MB dump on a phone.
 */
const nativeFromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

/** Each base64 character's six bits, by its character code; anything else is 0. */
const SEXTETS = new Uint8Array(256);
for (let i = 0; i < 64; i++)
	SEXTETS['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

const fromBase64 = (b64: string): Uint8Array => {
	if (typeof nativeFromBase64 === 'function') return nativeFromBase64(b64);

	// Four characters at a time, straight into the bytes, where `atob` made a binary string that was
	// then copied out a character at a time: the dump decodes in 9 rather than 15 ms in Chromium, in
	// 7 rather than 12 in WebKit (internal/DECISIONS.md D30). The text is the build's own
	// (scripts/engine-assets.mjs: Buffer's base64, padded, without line breaks), and what it decodes
	// to is checked where it is inflated, which a corrupt payload does not survive.
	const n = b64.length;
	if (n % 4 !== 0) throw new Error('the payload is not base64');
	const pad = n > 1 && b64.charCodeAt(n - 1) === 61 ? (b64.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
	const out = new Uint8Array((n >> 2) * 3 - pad);
	const full = pad ? n - 4 : n;
	const s = SEXTETS;
	let o = 0;
	let i = 0;
	for (; i < full; i += 4) {
		const v =
			(s[b64.charCodeAt(i) & 255]! << 18) |
			(s[b64.charCodeAt(i + 1) & 255]! << 12) |
			(s[b64.charCodeAt(i + 2) & 255]! << 6) |
			s[b64.charCodeAt(i + 3) & 255]!;
		out[o++] = v >> 16;
		out[o++] = (v >> 8) & 255;
		out[o++] = v & 255;
	}
	if (pad) {
		const v =
			(s[b64.charCodeAt(i) & 255]! << 18) |
			(s[b64.charCodeAt(i + 1) & 255]! << 12) |
			(s[b64.charCodeAt(i + 2) & 255]! << 6);
		out[o++] = v >> 16;
		if (pad === 1) out[o] = (v >> 8) & 255;
	}
	return out;
};

// --- engine boot --------------------------------------------------------------------------------

/**
 * Compiled once. Upstream calls WebAssembly.instantiate() with the raw bytes on every render,
 * which recompiles its 526 KB of wasm each time (this engine is 238 KB); instantiating a Module
 * reuses the compiled code. Null until the worker has started.
 */
let texModule: WebAssembly.Module | null = null;

/**
 * The dump's non-zero runs, 22.3 MiB of its 156.25, which the build packed back to back
 * (scripts/engine-assets.mjs `packCoreDump`): they are all a new Memory needs written into it
 * (./core-dump), and what the reset writes back from (./reset). Null until the worker has started.
 */
let coreDump: CoreDump | null = null;

/**
 * Start the engine from the payload the host sent (protocol.ts EngineAssets), rather than from string
 * literals in this script, which every start had to parse before it could run a line (D30):
 *
 *  - tex.wasm is inflated and compiled asynchronously, which the platform does off this thread,
 *    while the dump is inflated here;
 *  - both are inflated by the platform's own zlib where it has one, pako otherwise or after a native
 *    attempt that failed (./inflate gunzipExactly), into exactly the size the build recorded, which
 *    is checked: the dump has to fill the Memory exactly, or live TeX state would start at zero, a
 *    corruption that would surface much later as garbage output, so it fails here instead;
 *  - the bundled TeX files stay base64 text until TeX first asks for one, when that one is decoded
 *    and inflated, and library.ts keeps it inflated for the rest of the worker's life;
 *  - a loop of known cost, compiled beside tex.wasm and off this thread too, is timed once both are
 *    compiled, to say whether WebAssembly runs with a JIT here, which Lockdown Mode on an iPhone
 *    turns off (./jit, internal/DECISIONS.md D33).
 */
async function boot(assets: EngineAssets): Promise<BootTimings> {
	const started = performance.now();
	const compiled = gunzipExactly(fromBase64(assets.wasm), TEX_WASM_SIZE).then(({ bytes }) =>
		WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>),
	);
	// A failure is handled where the result is awaited, below; this keeps an early one from being
	// reported as unhandled meanwhile.
	compiled.catch(() => undefined);
	// The JIT probe's module, compiled beside it, off this thread too (./jit).
	const probe = compileProbeAsync();

	const dumpGz = fromBase64(assets.dump);
	const decoded = performance.now();

	const inflated = await gunzipExactly(dumpGz, packedLength(CORE_DUMP_RUNS));
	const dump = unpackCoreDump(CORE_DUMP_SIZE, CORE_DUMP_RUNS, inflated.bytes);
	checkCoreDump(dump, library.pages);
	const ready = performance.now();

	texModule = await compiled;
	coreDump = dump;
	library.setBundledFiles(new Map(Object.entries(assets.files)), (b64: string) => ungzip(fromBase64(b64)));
	const done = performance.now();
	const spin = await probe;
	const jit = spin === undefined ? undefined : probeJit(undefined, spin);

	return {
		decodeMs: Math.round(decoded - started),
		inflateMs: Math.round(ready - decoded),
		compileMs: Math.round(done - ready),
		totalMs: Math.round(performance.now() - started),
		nativeInflate: inflated.native,
		nativeBase64: typeof nativeFromBase64 === 'function',
		jit,
	};
}

// --- the memory a run starts from -----------------------------------------------------------------

/**
 * The Memory the last run used, with where that run can have written (./reset), kept when TeX
 * ended the run itself. Null when the next run takes a new one: before the first, and after a run
 * that jumped out of TeX, overflowed the stack or trapped, whose counters are not trusted.
 */
let kept: { memory: WebAssembly.Memory; spans: Span[] } | null = null;

/**
 * The Memory a run starts from: the kept one, with the dump's bytes written back over what the run
 * before wrote, or a new one with the dump written into it. Either way the same bytes, which
 * scripts/verify-reset.mjs checks after every run of every fixture.
 */
const memoryForRun = (dump: CoreDump): { memory: WebAssembly.Memory; fresh: boolean } => {
	const last = kept;
	// Out of `kept` until the run is over, so that a run that throws leaves a new Memory to the next.
	kept = null;
	if (last !== null) {
		restoreSpans(new Uint8Array(last.memory.buffer), dump, last.spans);
		return { memory: last.memory, fresh: false };
	}
	return { memory: startingMemory(dump, library.pages), fresh: true };
};

/** The engine's marks of how far the string pool and the stack have gone in this run so far. */
const marksOf = (exports: WebAssembly.Exports): RunMarks => {
	const mark = (name: string): number => {
		const read = exports[name];
		return typeof read === 'function' ? (read as () => number)() : -1;
	};
	return {
		poolPtrHigh: mark('getPoolPtrHigh'),
		strPtrHigh: mark('getStrPtrHigh'),
		stackLow: mark('getStackLow'),
	};
};

/**
 * Keep `memory` for the next run, with where this run can have written: TeX's counters read from
 * it, the engine's marks of how far the string pool and the stack went, and what the host wrote,
 * and `resumed`, where a saved run was written into it before the run began (./snapshot), whose
 * bytes the next run must not find either. Nothing is kept when they do not add up (./reset
 * writtenSpans), and the next run takes a new one.
 *
 * It never throws. It runs after TeX has ended, in the same try as drawing the DVI, and an error out
 * of it there would read as a run that wrote nothing: a fault in the reset's bookkeeping must cost
 * the next run a new Memory, never this run's diagram.
 */
const keep = (memory: WebAssembly.Memory, exports: WebAssembly.Exports, resumed: readonly Span[]): void => {
	try {
		const spans = writtenSpans(
			new Uint8Array(memory.buffer),
			CORE_LAYOUT,
			marksOf(exports),
			library.hostWrites(),
		);
		kept = spans === undefined ? null : { memory, spans: unionSpans(spans, resumed) };
	} catch {
		kept = null;
	}
};

// --- saved runs ----------------------------------------------------------------------------------

/**
 * Runs saved at the end of a first pass's \begin{document}, for later diagrams with the same input
 * up to there (./snapshot, internal/DECISIONS.md D32), within the budget the host sends with each
 * render: none until it sends one, and none again once it sends 0.
 */
const saved = new SnapshotCache(0);

/** Saves that failed in this worker's life and kept nothing (the save's try, in runPass). */
let saveFailures = 0;

/** What a first pass does about saved runs: start from one, or save itself where TeX stands. */
type PassPlan =
	| { kind: 'resume'; run: SavedRun; input: Uint8Array }
	| {
			kind: 'save';
			input: Uint8Array;
			text: string;
			logging: boolean;
			/**
			 * The name the host gives the run this diagram wants (./document routeOf), or undefined
			 * where it cannot tell where the \begin{document} is. The run is named so, for the host to
			 * find it by when it gives the next diagram that name, and else by what it stands for.
			 */
			route: string | undefined;
			/** What the render has said on the terminal and failed to find by the snapshot point. */
			log: readonly string[];
			missing: readonly string[];
			/**
			 * The run, once it is saved, kept or not, with what TeX took to reach it and what saving
			 * it took: for the host, which keeps it across the engine's stops (D36).
			 */
			saved?: Saving | undefined;
	  };

const decoder = new TextDecoder();

/**
 * Save a first pass where it stands, at \tikzjaxsnapshot: TeX's globals where they differ from the
 * dump, the host's files, and what the render had said by then. Not when TeX learnt more of the
 * job's file than the lines it read (library.ts jobFileRead), so that a saved run stands for exactly
 * the text it is saved under, nor when the reset cannot account for the memory.
 *
 * Any failure keeps nothing and lets TeX go on as if no save had been asked for: a save that cannot
 * allocate its copy on a phone short of memory must not cost the diagram (the caller's try).
 *
 * Says whether the run was kept, or saved and not kept, as no room could be made for it within the
 * budget (./snapshot SnapshotCache), with the run either way, which the host may keep (D36); or
 * undefined, when there was nothing to save.
 */
const saveRun = (
	plan: Extract<PassPlan, { kind: 'save' }>,
	memory: Uint8Array,
	exports: WebAssembly.Exports,
): { outcome: 'kept' | 'not kept'; run: SavedRun } | undefined => {
	const dump = coreDump;
	const read = library.jobFileRead();
	if (dump === null || read === undefined) return undefined;
	const prefix = decoder.decode(plan.input.subarray(0, read));
	if (!plan.text.startsWith(prefix)) return undefined;
	const spans = saveSpans(memory, CORE_LAYOUT, marksOf(exports), library.hostWrites());
	if (spans === undefined) return undefined;
	const host = library.captureHostState();
	const log = [...plan.log];
	const missing = [...plan.missing];
	// Compared with the dump here, while TeX waits. Copying what is compared, to compare it once the
	// diagram's reply was posted, took the first diagram after a start 10 ms less in Chromium and
	// nothing in WebKit, for a copy of 26.5 MiB at every save (internal/DECISIONS.md D32).
	const stretches = diffAgainstDump(
		spans.map(([a, b]) => ({ offset: a, bytes: memory.subarray(a, b) })),
		dump,
	);
	const bytes =
		stretches.reduce((n, s) => n + s.bytes.length, 0) + library.hostStateBytes(host) + logBytes(log);
	const run: SavedRun = {
		prefix,
		logging: plan.logging,
		route: plan.route ?? routeKey(prefix, plan.logging),
		stretches,
		spans: stretchSpans(stretches),
		host,
		log,
		missing,
		bytes,
	};
	return { outcome: saved.set(run) ? 'kept' : 'not kept', run };
};

// --- runs handed to the host --------------------------------------------------------------------

/** Which files of a saved run are this worker's own, named rather than copied in its bytes. */
const storedContent: ContentSources = {
	originOf: library.storedOriginOf,
	contentOf: library.storedContentOf,
};

/**
 * A run the host sent with a render (protocol.ts StoredRun), as the worker holds one, or undefined
 * when its bytes do not inflate to what the host said, or do not read back as a run of this
 * engine's (./stored-run): the render then goes on as if none had been sent, and the host deletes it.
 * Gzipped bytes carry a CRC-32 of what they hold, which the platform's inflate and pako both check,
 * so the run's own checksum is checked on bytes kept uncompressed only.
 */
const readStored = async (stored: StoredRun): Promise<SavedRun | undefined> => {
	try {
		const bytes = stored.compressed
			? (await gunzipExactly(new Uint8Array(stored.data), stored.rawBytes)).bytes
			: new Uint8Array(stored.data);
		return decodeSavedRun(bytes, ENGINE_ID, CORE_LAYOUT.globalsEnd, storedContent, !stored.compressed);
	} catch {
		return undefined;
	}
};

/**
 * Handing a run over costs the worker's own time: writing it out, a few milliseconds, and gzipping
 * it, which the platform does on this thread, over 200 ms for circuitikz's 8.9 MiB on the desktop
 * (D36). Spent right after the reply, it held up the next diagram by as much. So it waits until no
 * render has been under way for HANDOVER_QUIET_MS, as when the host has nothing more for this engine,
 * and gzips a slice at a time, each in a task of its own once the worker is idle again: a render
 * posted meanwhile starts first, and waits at most for the slice under way.
 */
const HANDOVER_QUIET_MS = 100;
const HANDOVER_SLICE = 256 * 1024;

/** Renders under way, and when the last one replied, for whenIdle. */
let rendering = 0;
let quietSince = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => self.setTimeout(resolve, ms));

/** Resolves in a task of its own once no render is under way and none has been for HANDOVER_QUIET_MS. */
const whenIdle = async (): Promise<void> => {
	for (;;) {
		await sleep(
			rendering > 0
				? HANDOVER_QUIET_MS
				: Math.max(0, quietSince + HANDOVER_QUIET_MS - performance.now()),
		);
		if (rendering === 0 && performance.now() - quietSince >= HANDOVER_QUIET_MS) return;
	}
};

/** The platform's own gzip, where it has one: Safari and iOS 16.4, Chrome 80. */
const hasNativeGzip = (): boolean => typeof CompressionStream === 'function';

/**
 * `bytes` gzipped by the platform, CompressionStream, a slice at a time, each when the worker is idle
 * (whenIdle). The time spent in it is added to `spent.ms`.
 */
const gzipWhenIdle = async (bytes: Uint8Array, spent: { ms: number }): Promise<Uint8Array> => {
	const stream = new CompressionStream('gzip');
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	const drained = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			chunks.push(value);
			length += value.length;
		}
	})();
	// A failure is the caller's, through the writes and `drained` below.
	drained.catch(() => undefined);
	try {
		for (let at = 0; at < bytes.length; at += HANDOVER_SLICE) {
			await whenIdle();
			const t = performance.now();
			await writer.write(bytes.subarray(at, at + HANDOVER_SLICE) as Uint8Array<ArrayBuffer>);
			spent.ms += performance.now() - t;
		}
		await whenIdle();
		const t = performance.now();
		await writer.close();
		await drained;
		spent.ms += performance.now() - t;
	} catch (error) {
		reader.cancel().catch(() => undefined);
		throw error;
	}
	const out = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
};

/** A run saved by a render, with what TeX took to reach it and what saving it took (PassPlan). */
interface Saving {
	run: SavedRun;
	preambleMs: number;
	saveMs: number;
}

/** Runs saved and not yet handed over, oldest first, and whether they are being. */
const toHandOver: { id: number; saving: Saving }[] = [];
let handingOver = false;

/**
 * Hand the host `saving`, once the worker is idle (whenIdle). The runs waiting hold at most `budget`
 * bytes between them, what the worker may hold of saved runs, the newest always: in a note of many
 * preambles the worker is idle only at the end, and a run waiting is memory, which a run the worker
 * no longer keeps would otherwise give back. The oldest is not handed over.
 */
const queueHandOver = (id: number, saving: Saving, budget: number): void => {
	toHandOver.push({ id, saving });
	let held = toHandOver.reduce((n, next) => n + next.saving.run.bytes, 0);
	while (toHandOver.length > 1 && held > budget) held -= toHandOver.shift()!.saving.run.bytes;
	if (!handingOver) void handOverAll();
};

const handOverAll = async (): Promise<void> => {
	handingOver = true;
	try {
		for (let next = toHandOver.shift(); next !== undefined; next = toHandOver.shift()) {
			await whenIdle();
			await handOver(next.id, next.saving);
		}
	} finally {
		handingOver = false;
	}
};

/**
 * Hand the host a run this worker saved, as bytes (./stored-run), gzipped where the platform has its
 * own gzip, to keep across the engine's stops. Nothing is sent when it fails: the run is then kept
 * only while this engine runs, as before D36.
 */
const handOver = async (id: number, saving: Saving): Promise<void> => {
	const spent = { ms: 0 };
	try {
		const t = performance.now();
		const raw = encodeSavedRun(saving.run, ENGINE_ID, storedContent);
		spent.ms += performance.now() - t;
		let data = raw;
		let compressed = false;
		if (hasNativeGzip()) {
			try {
				data = await gzipWhenIdle(raw, spent);
				compressed = true;
			} catch {
				// Kept as it is: the host counts what it stores by the bytes it is given.
			}
		}
		const message: SavedRunMessage = {
			type: 'saved-run',
			id,
			run: {
				route: saving.run.route,
				data: data.buffer as ArrayBuffer,
				compressed,
				rawBytes: raw.length,
			},
			preambleMs: Math.round(saving.preambleMs),
			saveMs: Math.round(saving.saveMs),
			encodeMs: Math.round(spent.ms),
		};
		post(message, [message.run.data]);
	} catch {
		// Nothing handed over: the run stays this engine's alone.
	}
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

/**
 * A run cut off at a line longer than TeX's buffer (runPass): TeX ran out of room again, in its
 * buffer this time, which tex.web reports as "TeX capacity exceeded, sorry [buffer size=…]".
 */
const lineTooLong = (t: Transcript, bufSize: number): Diagnosis => ({
	kind: 'capacity',
	message: `TeX cannot read a line longer than its buffer of ${bufSize.toString().replace(/\B(?=(\d{3})+$)/g, ',')} bytes.`,
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
	/** TeX was to read a line longer than its buffer, of this many bytes, and the run was cut off. */
	lineTooLong?: number | undefined;
}

/**
 * Run TeX once over `<job>.tex`, which must already be in the virtual filesystem, and draw
 * `<job>.dvi`. Everything the run leaves behind stays there for the caller to harvest or discard.
 * What each step took is added to `spent`.
 */
const runPass = async (job: string, spent: RenderTimings, plan?: PassPlan): Promise<PassResult> => {
	const started = performance.now();
	const dump = coreDump;
	const module = texModule;
	if (dump === null || module === null) throw new Error('the engine has not started');
	// The worker's own Memory, the dump written back over what the run before wrote, or a new one
	// with the dump's non-zero runs written into it. Upstream copied the whole dump into a new
	// 156.25 MiB Memory for every run. A pass that resumes gets the saved run's stretches over the
	// dump, and the reset before the next run puts those back too.
	const { memory, fresh } = memoryForRun(dump);
	const resumed = plan?.kind === 'resume' ? plan.run.spans : [];
	if (plan?.kind === 'resume') writeStretches(new Uint8Array(memory.buffer), plan.run.stretches);
	const reset = performance.now();
	let keeping = 0;

	library.setMemory(memory.buffer);
	if (plan?.kind === 'resume') {
		// The files as the saved run left them, the job's own with this diagram's text, which is the
		// same up to where TeX had read it: what the run was saved under.
		library.restoreHostState(plan.run.host, { [`${job}.tex`]: plan.input });
		spent.resumed = true;
	} else library.setInput(`${job}.tex\n\\end\n`);

	// The instance's exports, once it has them, for the save's reading of the engine's marks.
	let exports: WebAssembly.Exports | null = null;
	/** Time spent in the save at the snapshot point, which is not TeX's. */
	let saving = 0;
	if (plan?.kind === 'save') {
		library.watchJobFile(`${job}.tex`);
		let tried = false;
		library.setSnapshotHook(() => {
			// The first time only: the format runs it at the end of \begin{document}, which a run
			// reaches once.
			if (tried || exports === null) return;
			tried = true;
			const t = performance.now();
			try {
				// A run saved is the save's time, not TeX's, whether it was kept or not.
				const result = saveRun(plan, new Uint8Array(memory.buffer), exports);
				if (result !== undefined) {
					saving = performance.now() - t;
					spent.saveMs = (spent.saveMs ?? 0) + saving;
					plan.saved = { run: result.run, preambleMs: t - reset, saveMs: saving };
				}
				if (result?.outcome === 'not kept') spent.saveNotKept = true;
			} catch {
				// Whatever it was, nothing is kept and TeX goes on as if no save had been asked for:
				// a save must never cost the diagram (library.ts snapshotPoint).
				saveFailures++;
				spent.saveFailed = true;
			}
		});
	}

	let svg = '';
	let wroteDvi = false;
	let convertError: string | undefined;
	let overflowed = false;
	let lineTooLong: number | undefined;
	// When TeX was done, and when drawing its DVI began. A run that throws out of TeX sets neither,
	// and all of its time is TeX's; one that wrote no DVI drew nothing, and spent nothing drawing.
	let texDone: number | undefined;
	let drawing: number | undefined;
	try {
		const instance = await WebAssembly.instantiate(module, {
			library,
			env: { memory },
		});
		exports = instance.exports;
		const ended = await library.executeAsync(instance.exports);
		texDone = performance.now();
		// Only a run TeX ended itself leaves counters to trust; one that jumped out of TeX leaves a new
		// Memory to the next, as does one that never gets here: a trap, or the stack overflowing.
		if (ended === 'end') {
			keep(memory, instance.exports, resumed);
			keeping = performance.now() - texDone;
		}

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
		//     own, so TeX says nothing and closes no file. V8 and JavaScriptCore throw a RangeError;
		//   - the host refuses a line longer than TeX's buffer, which TeX has no chance to report
		//     itself (library.ts LineTooLong).
		// Swallowing them all produced "TeX produced no output" for a compile that worked perfectly.
		if (wroteDvi) convertError = error instanceof Error ? error.message : String(error);
		else if (texDone === undefined && error instanceof library.LineTooLong) lineTooLong = error.bufSize;
		else if (texDone === undefined && error instanceof RangeError) overflowed = true;
	} finally {
		library.setSnapshotHook(null);
		library.watchJobFile(null);
	}

	const done = performance.now();
	spent.resetMs += reset - started + keeping;
	spent.newMemory = (spent.newMemory ?? 0) + (fresh ? 1 : 0);
	spent.texMs += (texDone ?? done) - reset - saving;
	spent.svgMs += drawing === undefined ? 0 : done - drawing;
	spent.passes += 1;
	return { svg, wroteDvi, convertError, overflowed, lineTooLong };
};

/** `spent` as the plugin is told it: whole milliseconds, which is all a person reading it needs. */
const rounded = (spent: RenderTimings): RenderTimings => ({
	resetMs: Math.round(spent.resetMs),
	newMemory: spent.newMemory ?? 0,
	texMs: Math.round(spent.texMs),
	svgMs: Math.round(spent.svgMs),
	passes: spent.passes,
	...(spent.resumed === true ? { resumed: true } : {}),
	...(spent.restored === true ? { restored: true } : {}),
	...(spent.restoreMs !== undefined ? { restoreMs: Math.round(spent.restoreMs) } : {}),
	...(spent.saveMs !== undefined ? { saveMs: Math.round(spent.saveMs) } : {}),
	...(spent.saveNotKept === true ? { saveNotKept: true } : {}),
	...(spent.saveFailed === true ? { saveFailed: true } : {}),
});

/** What the worker holds of saved runs now, for the host. */
const snapshotState = (): SnapshotState => ({
	held: saved.routes(),
	bytes: saved.bytes,
	failures: saveFailures,
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

/** A render's reply, and the run it saved for the host to keep, when the host keeps them. */
interface Rendered {
	reply: OkMessage | ErrorMessage;
	handOver?: Saving | undefined;
}

async function render(
	id: number,
	source: string,
	options: RenderOptions,
	budget: number,
	stored: StoredRun | undefined,
	persist: boolean,
): Promise<Rendered> {
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
	const spent: RenderTimings = { resetMs: 0, newMemory: 0, texMs: 0, svgMs: 0, passes: 0 };

	// The first pass starts from a run an earlier diagram saved with the same input up to the end of
	// its \begin{document}, or saves itself there for later ones (./snapshot). A saved run stands for
	// that text and for whether the log is kept, since a run that kept none has none to say again;
	// everything else a run depends on is fixed for the worker's life: the engine, its files, its
	// clock and the first pass's job name. Only the first pass: a second reads at \begin{document}
	// the .aux the first wrote.
	saved.setBudget(budget);
	saved.tick();
	let firstPlan: PassPlan | undefined;
	let resumable = budget > 0 ? saved.find(text, logging) : undefined;

	// A run the host kept of an earlier engine's, sent for a diagram whose run this worker does not
	// hold (D36): read back and kept as if saved here, where there is room, so that the diagrams after
	// it start from it too, and resumed from either way. One that does not read back, or stands for
	// other text, leaves the render as if none had been sent.
	let storedOutcome: StoredOutcome | undefined;
	if (stored !== undefined) {
		if (budget <= 0 || resumable !== undefined) storedOutcome = 'unneeded';
		else {
			const restoring = performance.now();
			const run = await readStored(stored);
			spent.restoreMs = performance.now() - restoring;
			if (run === undefined) storedOutcome = 'corrupt';
			else if (run.logging !== logging || !text.startsWith(run.prefix)) storedOutcome = 'mismatch';
			else {
				storedOutcome = 'used';
				spent.restored = true;
				saved.set(run);
				resumable = saved.find(text, logging) ?? run;
			}
		}
	}

	if (resumable !== undefined) {
		// What the saved run had said and missed by then, as this run would have.
		for (const line of resumable.log) emit(line);
		for (const name of resumable.missing) if (!missing.includes(name)) missing.push(name);
		saved.pin(resumable);
		firstPlan = { kind: 'resume', run: resumable, input };
	} else if (budget > 0) {
		// Saved at a preamble's first diagram, not its second: waiting for a second sighting spared the
		// first its save and cost a third of the resumes in a run of every fixture twice (D32). Whether
		// or not the host can tell where its \begin{document} is (./document predictedPoint): the run is
		// saved where TeX stands, under what TeX had read. Not when it could not be kept (wants).
		const route = routeOf(text, logging);
		if (saved.wants(route)) firstPlan = { kind: 'save', input, text, logging, route, log, missing };
	}

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
		const first = await runPass(FIRST_JOB, spent, firstPlan);
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
		if (resumable !== undefined) saved.unpin(resumable);
		// Still exactly once, and still at the end however many passes ran. The inflated
		// bundled-file cache survives it by design (library.ts change 3).
		library.deleteEverything();
	}

	const durationMs = Math.round(performance.now() - started);
	const timings = rounded(spent);
	// The run this render saved, for the host to keep across the engine's stops (D36): only one the
	// host named, which it can find again for a later diagram, and only when it keeps them.
	const saving =
		persist && firstPlan?.kind === 'save' && firstPlan.route !== undefined ? firstPlan.saved : undefined;
	const done = (reply: OkMessage | ErrorMessage): Rendered => ({ reply, handOver: saving });
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
		return done({
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
			snapshots: snapshotState(),
			stored: storedOutcome,
		});
	}

	if (!reported.wroteDvi || !gotSvg) {
		// Only ever reached with a failed FIRST pass — a failed second one is discarded above — so
		// `transcript` here is that pass's own, not a later run's.
		return done({
			type: 'error',
			id,
			...(reported.overflowed
				? overflowed(transcript)
				: reported.lineTooLong !== undefined
					? lineTooLong(transcript, reported.lineTooLong)
					: diagnose(transcript, missing)),
			bodyLine,
			log,
			missing,
			durationMs,
			timings,
			snapshots: snapshotState(),
			stored: storedOutcome,
		});
	}
	// The characters ./unicode declared, written back over the boxes TeX set for them. When the
	// SVG's groups do not pair up, which a raw special in the diagram can do, that is what the card
	// says, with TeX's log: not that TeX produced nothing, and not an SVG with the text missing.
	let svg: string;
	try {
		svg = restoreUnicode(reported.svg, unicode);
	} catch (error) {
		return done({
			type: 'error',
			id,
			kind: 'tex-error',
			message: error instanceof Error ? error.message : String(error),
			bodyLine,
			log,
			missing,
			durationMs,
			timings,
			snapshots: snapshotState(),
			stored: storedOutcome,
		});
	}
	return done({
		type: 'ok',
		id,
		svg,
		log,
		missing,
		durationMs,
		timings,
		snapshots: snapshotState(),
		stored: storedOutcome,
		firstError: diagnostics.firstError,
		line: diagnostics.line,
		bodyLine,
	});
}

// --- message loop ----------------------------------------------------------------------------------

// Declared locally rather than by adding "WebWorker" to tsconfig's lib: that would put `self`,
// `close()` and `postMessage()` in scope for every file in the project, including the plugin,
// where they are exactly the wrong things to have available.
declare const self: {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	setTimeout(handler: () => void, timeout: number): number;
	onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const post = (message: unknown, transfer?: Transferable[]) =>
	transfer === undefined ? self.postMessage(message) : self.postMessage(message, transfer);

/** The start, once the payload has arrived. */
let booted: Promise<unknown> | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	if (request.type === 'boot') {
		if (booted !== null) return;
		booted = boot(request.assets).then(
			(timings) => post({ type: 'ready', engineId: ENGINE_ID, inventory: INVENTORY, boot: timings }),
			(error: unknown) => {
				// Thrown again outside the promise, so that it reaches the host as the worker's error
				// event, which is how a start that failed has always been reported (worker-host.ts
				// `crashed`): a promise that rejects in a worker raises no error event, and the host
				// would wait for a `ready` that never comes. A payload that does not inflate to what the
				// build recorded ends here.
				queueMicrotask(() => {
					throw error;
				});
			},
		);
		return;
	}
	if (request.type === 'ping') {
		post({ type: 'ok', id: request.id, svg: '', log: [], missing: [], durationMs: 0 });
		return;
	}
	if (request.type === 'render') {
		rendering++;
		void render(
			request.id,
			request.source,
			request.options,
			request.snapshots ?? 0,
			request.stored,
			request.persist === true,
		).then(
			({ reply, handOver: saving }) => {
				rendering--;
				quietSince = performance.now();
				post(reply);
				if (saving !== undefined) queueHandOver(request.id, saving, request.snapshots ?? 0);
			},
			(error: unknown) => {
				rendering--;
				quietSince = performance.now();
				post({
					type: 'error',
					id: request.id,
					kind: 'engine-unavailable',
					message: error instanceof Error ? error.message : String(error),
					log: [],
					missing: [],
					durationMs: 0,
				} satisfies ErrorMessage);
			},
		);
	}
};
