/*
 * TeX WebAssembly host.
 *
 * Forked from drgrice1/tikzjax src/library.js @ 461ac15f (GPL-3.0-or-later), which is itself
 * derived from kisonecat/tikzjax. Copyright the original authors: Jim Fowler, Glenn Rice.
 * Modified by JackVinati in 2026, as listed below. This file remains GPL-3.0-or-later. See NOTICE.
 *
 * CHANGES FROM UPSTREAM (see internal/DECISIONS.md D10):
 *
 *  1. Bundled TeX files resolve SYNCHRONOUSLY from an injected map. Upstream unwinds the entire
 *     asyncify stack, setTimeout(0)s, awaits a fetch of `tex_files/<name>.gz`, then rewinds —
 *     for every file, and a pgfplots run opens dozens. Our files are already in memory, so the
 *     round trip buys nothing. With no async file path left, the unwind/rewind machinery is gone
 *     entirely.
 *  2. No network. Upstream falls back to `await fetch(filename)` for any unresolved name, which
 *     is an outbound request triggered by note content in an offline-first plugin. A name that is
 *     not bundled is simply not found, which is also what real kpathsea reports.
 *  3. Inflated bundled files survive deleteEverything(). Upstream clears the whole virtual
 *     filesystem between runs, so the pgf/pgfplots tree is re-inflated on every single render.
 *  4. The clock is injectable. Upstream reads `new Date()` in four places and TeX stamps those
 *     into its output, so a golden corpus could never be byte-stable across two days.
 *  5. Log lines go to an injected sink rather than a bare `postMessage`, so the same code runs
 *     in a Worker and in the Node test harness.
 *  6. Missing files are reported, not swallowed, so the plugin can say "package X is not bundled"
 *     instead of showing a mystery failure (upstream #81).
 *  7. The engine is built without asyncify (internal/DECISIONS.md D14), so nothing here unwinds or
 *     rewinds: a run is TeX's main program, start to end. TeX's jump out of every procedure on a
 *     fatal error, which asyncify made, is a call to jumpOut, which ends the run there once TeX has
 *     closed its files (D17). Upstream's host waited for a `tex_final_end` that jump skips, so such
 *     a run never ended.
 *  8. getfilesize answers -1 for a file it does not have, where upstream answered 0, and the engine's
 *     \filesize then prints nothing, as pdfTeX's does (internal/DECISIONS.md D16).
 *  9. The calls TeX makes once a line or once a character allocate nothing: views of the memory are
 *     made once a run rather than two or three a call, and a character is appended where it was
 *     wrapped in an array of its own. They answer and fail exactly as before (D29).
 * 10. Where this host wrote into TeX's memory in a run is kept, and executeAsync says whether TeX
 *     ended or jumped out, for the worker's reset of only what a run wrote (./reset, D31).
 * 11. A line longer than what is left of TeX's buffer throws LineTooLong, where it threw the
 *     RangeError of a view that refused it, so that the worker tells it from a run cut off by the
 *     engine's stack (D29).
 * 12. A run can be saved where the engine's \tikzjaxsnapshot stands, once its \begin{document} is
 *     done, and later runs started from there: the host calls a hook with TeX's memory as it is,
 *     copies its own table of files, and puts that back for a run that starts from the saved memory
 *     (worker.ts, ./snapshot, D32). It also notes whether TeX learnt anything about the job's own
 *     file other than by reading it line by line, which a saved run could not stand for.
 * 13. A font's metrics, from dvi2html's table or the bundle, are what TeX gets when it opens a .tfm
 *     to READ. A .tfm opened to write starts empty, as any other file does: it was handed the
 *     bundled bytes, which every later run reads the font from, and wrote into them (D35).
 * 14. Which files of a saved run's table are the worker's own, a bundled file or a font's metrics,
 *     and which TeX has closed, so that a run written out as bytes names the first rather than
 *     copying them, and a run read back finds the bytes of a closed one only if asked (./stored-run,
 *     D36).
 */

import { tfmData } from '@drgrice1/dvi2html';
import type { ContentOrigin } from './stored-run';

export const pages = 2500;

/** One TeX input file: bytes, plus the read/write cursors TeX drives. */
export interface TexFile {
	filename: string;
	content?: Uint8Array;
	position?: number;
	position2?: number;
	erstat: number;
	eoln?: boolean;
	eof?: boolean;
	descriptor?: number;
	stdin?: boolean;
	stdout?: boolean;
	/** Opened for writing, so the file exists from now on in this run (getfilesize). */
	written?: boolean;
	/**
	 * Closed by TeX, which never reads or writes it again: a file opened again is a new entry
	 * (change 14). A saved run written out as bytes keeps no bytes of a file it read and closed.
	 */
	closed?: boolean;
}

/** Files written during this run, plus per-run copies of bundled files. Cleared between runs. */
let filesystem: Record<string, Uint8Array> = {};
let files: TexFile[] = [];

let memory: ArrayBuffer | null = null;
/**
 * Views of the whole of `memory`, made once a run in setMemory rather than once a call (change 9):
 * TeX calls inputln once a line and get once a byte it reads, a pgfplots run reads some 60,000
 * lines, and each call made two or three views of its own. The Memory never grows, its maximum being
 * its initial size, so a view of it never goes stale within a run.
 */
let bytes: Uint8Array | null = null;
let words: Uint32Array | null = null;
/**
 * The stretches of the memory this host wrote into this run, each [from, to), for the reset (change
 * 10). A write joins the stretch it lies within NEAR of, or starts one of its own: TeX's buffer and
 * its file variables lie 84 MB apart, and one stretch from the first to the last would have the
 * reset write everything between.
 */
let written: [number, number][] = [];
const NEAR = 65536;
const wrote = (from: number, to: number) => {
	for (const span of written) {
		if (from > span[1] + NEAR || to < span[0] - NEAR) continue;
		if (from < span[0]) span[0] = from;
		if (to > span[1]) span[1] = to;
		return;
	}
	written.push([from, to]);
};
let inputBuffer: string | null = null;
let callback: (() => void) | null = null;

// ---------------------------------------------------------------------------------------------
// Injected environment (change 1, 4, 5, 6)

/**
 * name -> the file as shipped, gzipped, in whatever form the worker holds it: since 0.2.1 the base64
 * text it was sent, which it decodes only when TeX first asks for that file (D30).
 */
let bundledGz: ReadonlyMap<string, unknown> | null = null;
/** name -> inflated bytes. Deliberately NOT cleared by deleteEverything(). */
const inflatedCache = new Map<string, Uint8Array>();
let inflate: ((packed: never) => Uint8Array) | null = null;

let logSink: ((line: string) => void) | null = null;
let missingSink: ((name: string) => void) | null = null;
let showConsole = false;
let consoleBuffer = '';

/** Fixed epoch so TeX's \year/\month/\day/\time are reproducible. Overridable for real clocks. */
let clock = { year: 2026, month: 1, day: 1, minutes: 0 };

/** The bundled files, and how to turn one of them into its bytes: decoded, if need be, and inflated. */
export const setBundledFiles = <T>(map: ReadonlyMap<string, T>, inflateFn: (packed: T) => Uint8Array) => {
	bundledGz = map;
	inflate = inflateFn;
};

export const setLogSink = (fn: ((line: string) => void) | null) => {
	logSink = fn;
};

export const setMissingFileSink = (fn: ((name: string) => void) | null) => {
	missingSink = fn;
};

export const setClock = (c: Partial<typeof clock>) => {
	clock = { ...clock, ...c };
};

/**
 * Resolve a bundled file, inflating on first use and caching the result across runs.
 * Synchronous by construction — this is the change that removes the per-file asyncify round trip.
 */
const resolveBundled = (filename: string): Uint8Array | undefined => {
	const hit = inflatedCache.get(filename);
	if (hit) return hit;
	const gz = bundledGz?.get(filename);
	if (!gz || !inflate) return undefined;
	const data = inflate(gz as never);
	inflatedCache.set(filename, data);
	return data;
};

/**
 * A font's metrics from dvi2html's built-in table, or undefined for a font the table does not have,
 * for which dvi2html throws.
 */
const builtinMetrics = (filename: string): Uint8Array | undefined => {
	if (!filename.endsWith('.tfm')) return undefined;
	try {
		return Uint8Array.from(tfmData(filename.replace(/\.tfm$/, '')) as ArrayLike<number>);
	} catch {
		return undefined;
	}
};

/** Names TeX asked for and we could not supply. Drives the plugin's "not bundled" error copy. */
export const clearMissing = () => {
	/* the sink owns accumulation; this exists so callers can reset per job */
};

// ---------------------------------------------------------------------------------------------

export const deleteEverything = () => {
	files = [];
	filesystem = {};
	memory = null;
	bytes = null;
	words = null;
	inputBuffer = null;
	callback = null;
	showConsole = false;
	consoleBuffer = '';
	snapshotHook = null;
	jobFile = null;
	// inflatedCache is NOT cleared (change 3): the pgf tree costs ~100 ms to re-inflate and is
	// identical on every run.
};

export const writeFileSync = (filename: string, buffer: Uint8Array) => {
	filesystem[filename] = buffer;
};

export const readFileSync = (filename: string): Uint8Array => {
	for (const f of files) {
		if (f.filename === filename && f.content) return f.content.slice(0, f.position ?? 0);
	}
	throw new Error(`Could not find file ${filename}`);
};

/** Extensions for which "not found" is a real error TeX should see, rather than an empty file. */
const ERRSTAT_EXTENSIONS = /\.(aux|log|dvi|tex|sty|def|cls|cfg|ltx|fd|clo)$/;

/**
 * Job-local files TeX opens as a matter of course. LaTeX probes input.aux on every single run to
 * discover that it does not exist yet; reporting that as "a package is not bundled" would put a
 * confident, wrong diagnosis in front of the user on a perfectly good render.
 */
const JOB_LOCAL = /\.(aux|log|dvi|toc|out|nav|snm)$/;

const openSync = (filename: string, mode: 'r' | 'w'): number => {
	let buffer: Uint8Array | undefined;
	// The job's own file opened again (change 12): a reader that is not TeX's main input, which can
	// read past the line TeX's main input has reached.
	if (filename === jobFile && jobFileOpens++ > 0) jobFileLearnt = true;

	if (filesystem[filename]) {
		buffer = filesystem[filename];
	} else if (mode === 'r' && filename.endsWith('.tfm')) {
		// dvi2html carries a built-in metric table. It is tried FIRST so every font the engine
		// already rendered keeps rendering byte-identically — but it covers only Computer Modern,
		// lasy and the AMS symbol fonts (msam, msbm), and it THROWS on anything else. That throw
		// escaped openSync, crossed the wasm frames and killed the whole run: a single `\mathfrak`
		// took the engine down rather than producing an error anyone could read.
		//
		// So: built-in first, then the bundle, then not-found. The bundled fallback lets TeX load
		// the Euler (eufm, eusm) and rsfs metrics, so `\mathfrak` and `\mathscr` compile, and the
		// failure that follows is dvi2html's readable "Could not find font eufm10" rather than a
		// dead engine. Drawing them is a separate gap: dvi2html's own table has neither family,
		// and of their faces only the Euler ones ship — rsfs has metrics and no web font at all
		// (upstream #55, #84, #113).
		//
		// Only to read (change 13). A .tfm opened to write starts empty below, as any other name
		// does: handed the bundled bytes, which resolveBundled keeps for the worker's life, TeX wrote
		// into the very array every later run reads that font from.
		buffer = builtinMetrics(filename) ?? resolveBundled(filename);
		if (!buffer) {
			missingSink?.(filename);
			files.push({ filename, erstat: 1, eof: true });
			return files.length - 1;
		}
	} else if (mode === 'r') {
		buffer = resolveBundled(filename);

		if (!buffer) {
			// A file that was opened before without error was written to, so it exists now.
			const existing = files.findIndex((f) => f.filename === filename && !f.erstat);
			if (existing === -1) {
				// Not bundled and never written: not found. Reported immediately, with no unwind
				// (change 1) and no network probe (change 2).
				//
				// This path is HOT and mostly benign: TeX probes for files precisely to discover
				// whether they exist — pgfplots' \pgfplots@iffileexists \openin's a name for that
				// reason alone. So a miss is recorded for diagnostics but is never itself an error.
				if (ERRSTAT_EXTENSIONS.test(filename) && !JOB_LOCAL.test(filename)) missingSink?.(filename);
				files.push({
					filename,
					erstat: ERRSTAT_EXTENSIONS.test(filename) ? 1 : 0,
					eof: true,
				});
				return files.length - 1;
			}
		}
	}

	files.push({
		filename,
		position: 0,
		position2: 0,
		erstat: 0,
		eoln: false,
		content: buffer ?? new Uint8Array(),
		descriptor: files.length,
		written: mode === 'w',
	});

	return files.length - 1;
};

const writeSync = (file: TexFile, buffer: Uint8Array, pointer = 0, length?: number) => {
	const len = length ?? buffer.length - pointer;
	let content = file.content ?? new Uint8Array();
	let position = file.position ?? 0;

	while (len > content.length - position) {
		const grown = new Uint8Array(1 + content.length * 2);
		grown.set(content);
		content = grown;
	}

	content.subarray(position).set(buffer.subarray(pointer, pointer + len));
	position += len;

	file.content = content;
	file.position = position;
};

const readSync = (file: TexFile, buffer: Uint8Array, pointer = 0, length: number, seek: number) => {
	const content = file.content ?? new Uint8Array();
	let len = length;
	if (len > content.length - seek) len = content.length - seek;
	buffer.subarray(pointer).set(content.subarray(seek, seek + len));
	return len;
};

const writeToConsole = (x: string) => {
	if (!showConsole) return;
	consoleBuffer += x;
	if (consoleBuffer.indexOf('\n') >= 0) {
		const lines = consoleBuffer.split('\n');
		consoleBuffer = lines.pop() ?? '';
		for (const line of lines) if (line.length) logSink?.(line);
	}
};

export const setShowConsole = () => {
	showConsole = true;
};

export const setMemory = (m: ArrayBuffer) => {
	memory = m;
	bytes = new Uint8Array(m);
	words = new Uint32Array(m, 0, m.byteLength >>> 2);
	written = [];
};

/**
 * Where this host has written into the memory since setMemory, as stretches [from, to): TeX's
 * buffer and the words beside it that inputln fills, and the file variables get reads a byte into.
 * All of them are among TeX's globals, and the worker's reset writes the dump back over them with
 * the rest (./reset).
 */
export const hostWrites = (): readonly (readonly [number, number])[] =>
	written.map(([a, b]) => [a, b] as const);

export const setInput = (input: string, cb?: () => void) => {
	inputBuffer = input;
	if (cb) callback = cb;
};

// --- saving a run (change 12) -------------------------------------------------------------------

/**
 * Called by \tikzjaxsnapshot (engine-build/changes/snapshot.ch), which the format runs at the end of
 * every \begin{document}, with TeX's memory as it stands there and the engine's flag for a resumed
 * run set in it. Whoever set the hook may copy the memory, and this host's own state with
 * captureHostState, during the call, and TeX goes on when it returns. With no hook the command is
 * \ignorespaces.
 */
let snapshotHook: (() => void) | null = null;

export const setSnapshotHook = (fn: (() => void) | null) => {
	snapshotHook = fn;
};

export const snapshotPoint = () => {
	const hook = snapshotHook;
	if (hook === null) return;
	try {
		hook();
	} catch {
		// A save that fails is a save not made, never a run cut off: the worker's hook catches and
		// counts its own failures, and this keeps anything it did not catch from unwinding TeX,
		// where a RangeError would read as the engine's stack running out (worker.ts runPass).
	}
};

/** The job's own input file, watched while a run that may be saved reads its preamble. */
let jobFile: string | null = null;
let jobFileOpens = 0;
/** TeX asked for the watched file's size, or opened it a second time: see watchJobFile. */
let jobFileLearnt = false;

/**
 * Watch `name`, the job's own input file, until the end of the run; null stops.
 *
 * A saved run stands for the input up to the end of the line TeX had read when it was saved, and
 * holds for a later input that starts with the same text. That is so only while TeX knows of the
 * file what its main input read, a line at a time. \filesize of the job's file is the size of all
 * of it, body included, and a second \openin or \input of it can read past that line: a run that
 * did either before it was saved would carry what the first diagram's body says into a later one
 * (internal/DECISIONS.md D32), so jobFileRead then says nothing can be saved.
 */
export const watchJobFile = (name: string | null) => {
	jobFile = name;
	jobFileOpens = 0;
	jobFileLearnt = false;
};

/**
 * How far TeX's main input has read the watched file, in bytes, through the newline that ends the
 * line it read last: what a run saved now stands for. Undefined when TeX learnt more of the file
 * than that (watchJobFile), has not opened it, or has read it to its end.
 */
export const jobFileRead = (): number | undefined => {
	if (jobFile === null || jobFileLearnt) return undefined;
	const main = files.find((f) => f.filename === jobFile && !f.written);
	const content = main?.content;
	const at = main?.position2;
	if (main?.eof || content === undefined || at === undefined || at >= content.length || content[at] !== 10)
		return undefined;
	return at + 1;
};

/** What this host keeps of a run outside TeX's memory: the files TeX has open, and the terminal. */
export interface HostState {
	files: readonly TexFile[];
	filesystem: Readonly<Record<string, Uint8Array>>;
	inputBuffer: string | null;
	consoleBuffer: string;
}

/**
 * A copy of a file's entry that a later run can go on from. The bytes of a file TeX is writing are
 * copied, because the run that goes on writes into them; the bytes of a file it reads are shared,
 * because nothing writes them. The entry of a file TeX read and closed is shared whole, as nothing
 * changes it again, and so is not read either: a run read back from storage finds the bytes of such
 * a file only when something asks for them (./stored-run, change 14).
 */
const copyOfFile = (f: TexFile): TexFile =>
	f.written && f.content
		? { ...f, content: f.content.slice(0, Math.max(f.position ?? 0, 0)) }
		: f.closed === true
			? f
			: { ...f };

/**
 * This run's host state, as \tikzjaxsnapshot found it. Without the text of the job's own file, the
 * one watchJobFile watches: restoreHostState is always given that anew, the diagram's that resumes,
 * and keeping the saving diagram's, twice, held its whole input beyond what the saved runs' budget
 * counts, an inline table of data and all, for as long as the run was kept.
 */
export const captureHostState = (): HostState => ({
	files: files.map((f) =>
		f.filename === jobFile && !f.written && f.content !== undefined
			? { ...f, content: new Uint8Array(0) }
			: copyOfFile(f),
	),
	filesystem: Object.fromEntries(
		Object.entries(filesystem).map(([name, bytes]) => [
			name,
			name === jobFile ? new Uint8Array(0) : bytes,
		]),
	),
	inputBuffer,
	consoleBuffer,
});

/** The bytes a captured host state holds of its own: the files TeX was writing. */
export const hostStateBytes = (state: HostState): number =>
	state.files.reduce((n, f) => n + (f.written && f.content ? f.content.length : 0), 0);

/**
 * Whether a file of a captured host state is this worker's own, for a saved run written out as bytes
 * (change 14, ./stored-run): a file of the bundle, which openSync hands TeX as the very array it keeps
 * inflated, or dvi2html's metrics for a font, which it hands as a copy of the same bytes every time.
 * Those are named in the stored bytes, and put back from the worker's own when they are read
 * (storedContentOf). Two functions rather than an object: this module is the engine's imports.
 */
export const storedOriginOf = (name: string, content: Uint8Array): ContentOrigin | undefined => {
	if (inflatedCache.get(name) === content) return 'bundled';
	const metrics = builtinMetrics(name);
	if (metrics === undefined || metrics.length !== content.length) return undefined;
	for (let i = 0; i < metrics.length; i++) if (metrics[i] !== content[i]) return undefined;
	return 'metrics';
};

/** The bytes of `name` from `origin` in this worker, or undefined where it has none. */
export const storedContentOf = (name: string, origin: ContentOrigin): Uint8Array | undefined =>
	origin === 'bundled' ? resolveBundled(name) : builtinMetrics(name);

/**
 * Put back a captured host state, for a run that starts from the memory saved with it. `inputs`
 * replaces the text of files TeX is reading, by name: the job's file, whose text past the saved line
 * is the new diagram's, and which it must hold, as the state holds none (captureHostState). Each
 * file's entry keeps the place TeX had reached in it.
 */
export const restoreHostState = (state: HostState, inputs: Readonly<Record<string, Uint8Array>>) => {
	files = state.files.map((f) => {
		const copy = copyOfFile(f);
		const replaced = inputs[f.filename];
		if (replaced !== undefined && !f.written && f.content !== undefined) copy.content = replaced;
		return copy;
	});
	filesystem = { ...state.filesystem, ...inputs };
	inputBuffer = state.inputBuffer;
	consoleBuffer = state.consoleBuffer;
};

/** What jumpOut throws. Its own class, so that a trap in the engine is never taken for one. */
class JumpOut extends Error {}

/**
 * Where TeX jumps from inside a procedure to the end of its program: jump_out's `goto end_of_TEX`,
 * which a fatal error, a capacity overflow and a hundredth error all reach. WebAssembly has no jump
 * out of a function, so the build makes the jump a call to this, followed by `unreachable`
 * (engine-build/build-engine.sh), and it throws, which takes the stack down to executeAsync.
 */
export const jumpOut = (): never => {
	throw new JumpOut('TeX jumped to the end of its program');
};

/**
 * Runs TeX's main program, to its end or to a jump out. Synchronous since the engine has no
 * asyncify (change 7): once main returns, TeX has finished. It still returns a promise, which is
 * the worker's contract, and the promise fails only when the engine does, by a trap or by an
 * exception from this host. It says how TeX ended: `end` when its main program returned, `jump`
 * when it jumped out (change 10).
 */
export const executeAsync = (exports: WebAssembly.Exports): Promise<'end' | 'jump'> =>
	new Promise<'end' | 'jump'>((resolve) => {
		try {
			(exports.main as () => void)();
		} catch (error) {
			if (!(error instanceof JumpOut)) throw error;
			// The program ends here rather than at TeX's final_end, which would have flushed the line
			// it was printing: the error's context, which the transcript needs.
			tex_final_end();
			resolve('jump');
			return;
		}
		resolve('end');
	});

// --- clock (change 4) -------------------------------------------------------------------------

export const getCurrentMinutes = () => clock.minutes;
export const getCurrentDay = () => clock.day;
export const getCurrentMonth = () => clock.month;
export const getCurrentYear = () => clock.year;

// --- print ------------------------------------------------------------------------------------

const fileFor = (descriptor: number): TexFile =>
	descriptor < 0 ? { filename: 'stdout', stdout: true, erstat: 0 } : (files[descriptor] as TexFile);

export const printString = (descriptor: number, x: number) => {
	const file = fileFor(descriptor);
	const length = new Uint8Array(memory!, x, 1)[0]!;
	const buffer = new Uint8Array(memory!, x + 1, length);
	let string = '';
	for (const b of buffer) string += String.fromCharCode(b);

	if (file.stdout) return writeToConsole(string);
	writeSync(file, new TextEncoder().encode(string));
};

const printRaw = (descriptor: number, text: string) => {
	const file = fileFor(descriptor);
	if (file.stdout) return writeToConsole(text);
	writeSync(file, new TextEncoder().encode(text));
};

export const printBoolean = (descriptor: number, x: number) => printRaw(descriptor, x ? 'TRUE' : 'FALSE');
export const printInteger = (descriptor: number, x: number) => printRaw(descriptor, x.toString());
export const printFloat = (descriptor: number, x: number) => printRaw(descriptor, x.toString());
export const printNewline = (descriptor: number, _x: number) => printRaw(descriptor, '\n');

/**
 * One character to the terminal: what writeToConsole does with a string of one, without searching
 * the line so far for a newline, which writeToConsole never leaves in it.
 */
const consoleChar = (c: string) => {
	if (!showConsole) return;
	if (c !== '\n') {
		consoleBuffer += c;
		return;
	}
	if (consoleBuffer.length) logSink?.(consoleBuffer);
	consoleBuffer = '';
};

/** One byte to a file: writeSync of a one-byte array, the file grown the same way. */
const appendByte = (file: TexFile, x: number) => {
	let content = file.content ?? new Uint8Array();
	const position = file.position ?? 0;
	while (1 > content.length - position) {
		const grown = new Uint8Array(1 + content.length * 2);
		grown.set(content);
		content = grown;
	}
	content[position] = x;
	file.content = content;
	file.position = position + 1;
};

/**
 * TeX prints every character of its transcript through here, twice when it prints to the terminal
 * and the log: 18,000 calls in a pgfplots run, each of which made an array of one byte (change 9).
 */
export const printChar = (descriptor: number, x: number) => {
	const file = fileFor(descriptor);
	if (file.stdout) return consoleChar(String.fromCharCode(x));
	appendByte(file, x);
};

// --- file name plumbing -------------------------------------------------------------------------

const readFilename = (length: number, pointer: number) => {
	const buffer = new Uint8Array(memory!, pointer, length);
	let filename = '';
	for (const b of buffer) filename += String.fromCharCode(b);
	// Upstream writes /\000+$/ — an octal escape TypeScript 7 rejects. \x00 is the same NUL.
	// The control character is the point: TeX hands filenames over NUL-padded to a fixed width.
	// eslint-disable-next-line no-control-regex -- the NUL is the point, see above.
	return filename.replace(/\x00+$/g, '');
};

export const reset = (length: number, pointer: number): number => {
	let filename = readFilename(length, pointer);

	if (filename.startsWith('{')) filename = filename.replace(/^\{/, '').replace(/\}.*/, '');
	if (filename.startsWith('"')) filename = filename.replace(/^"/, '').replace(/".*/, '');

	filename = filename
		.replace(/ +$/g, '')
		.replace(/^\*/, '')
		.replace(/^TeXfonts:/, '');

	if (filename === 'TeXformats:TEX.POOL') filename = 'tex.pool';

	if (filename === 'TTY:') {
		files.push({
			filename: 'stdin',
			stdin: true,
			position: 0,
			position2: 0,
			erstat: 0,
			eoln: false,
			content: new TextEncoder().encode(inputBuffer ?? ''),
		});
		return files.length - 1;
	}

	return openSync(filename, 'r');
};

export const rewrite = (length: number, pointer: number): number => {
	let filename = readFilename(length, pointer).replace(/ +$/g, '');
	if (filename.startsWith('"')) filename = filename.replace(/^"/, '').replace(/".*/, '');

	if (filename === 'TTY:') {
		files.push({ filename: 'stdout', stdout: true, erstat: 0 });
		return files.length - 1;
	}

	return openSync(filename, 'w');
};

/**
 * \filesize's answer (change 8): the size of the file in bytes, as TeX would read it, or -1 when
 * there is none, for which \filesize prints nothing, as pdfTeX's does.
 *
 * Upstream answered 0 for a file it did not have, and LaTeX's \IfFileExists takes any answer that is
 * not empty for a file that exists: every missing package, every \input of a missing file and every
 * probe for an optional .cfg was found, and then read as an empty file. The name is looked up rather
 * than opened, as upstream did, so asking adds nothing to the run's table of files. A file TeX wrote
 * earlier in the run exists, and openSync gives it back empty, so its size here is 0.
 */
export const getfilesize = (length: number, pointer: number): number => {
	let filename = readFilename(length, pointer);
	if (filename.startsWith('{')) filename = filename.replace(/^\{/, '').replace(/\}.*/, '');
	filename = filename.replace(/ +$/g, '').replace(/^\*/, '');
	if (filename === 'TeXformats:TEX.POOL') filename = 'tex.pool';
	// The size of the job's own file is the size of all of it (change 12).
	if (filename === jobFile) jobFileLearnt = true;

	const bytes = filesystem[filename] ?? builtinMetrics(filename) ?? resolveBundled(filename);
	if (bytes) return bytes.length;
	if (files.some((f) => f.filename === filename && f.written)) return 0;
	if (ERRSTAT_EXTENSIONS.test(filename) && !JOB_LOCAL.test(filename)) missingSink?.(filename);
	return -1;
};

export const close = (descriptor: number) => {
	// Noted, for a saved run written out as bytes (change 14); nothing else reads it.
	const file = files[descriptor];
	if (file !== undefined) file.closed = true;
};

/**
 * What inputln throws for a line longer than what is left of TeX's buffer (change 11). tex.web's own
 * input_ln copies a line in a character at a time and stops with "TeX capacity exceeded, sorry
 * [buffer size=…]" once the buffer is full; here the host copies the line, before TeX can look, so
 * the host stops the run instead, with the buffer's size. It threw a RangeError, which the worker
 * took for a run cut off by the engine's stack, and reported as TeX nesting too deep.
 */
export class LineTooLong extends Error {
	readonly bufSize: number;
	constructor(bufSize: number) {
		super(`a line longer than TeX's buffer of ${bufSize} bytes`);
		this.bufSize = bufSize;
	}
}

export const eof = (descriptor: number) => (files[descriptor]?.eof ? 1 : 0);
export const erstat = (descriptor: number) => files[descriptor]?.erstat ?? 1;
export const eoln = (descriptor: number) => (files[descriptor]?.eoln ? 1 : 0);

export const inputln = (
	descriptor: number,
	bypassEoln: number,
	bufferp: number,
	firstp: number,
	lastp: number,
	_maxBufStackp: number,
	bufSize: number,
): boolean => {
	const file = files[descriptor]!;
	const content = file.content ?? new Uint8Array();

	// The checks `new Uint8Array(memory, bufferp, bufSize)` and the two `new Uint32Array(memory, p, 4)`
	// this used to make for every line would have failed, failing the same way (change 9).
	const mem = bytes!;
	const word = words!;
	if (
		bufferp < 0 ||
		bufSize < 0 ||
		firstp < 0 ||
		lastp < 0 ||
		bufferp + bufSize > mem.length ||
		(firstp & 3) !== 0 ||
		(lastp & 3) !== 0 ||
		firstp + 16 > mem.length ||
		lastp + 16 > mem.length
	)
		throw new RangeError('inputln: a view outside the memory');

	const first = word[firstp >>> 2]!;
	word[lastp >>> 2] = first;
	wrote(lastp, lastp + 4);

	if (bypassEoln && !file.eof && file.eoln) file.position2 = (file.position2 ?? 0) + 1;
	if (file.eof) return false;

	const from = file.position2 ?? 0;
	let endOfLine = content.indexOf(10, from);
	if (endOfLine < 0) endOfLine = content.length;

	if (from >= content.length) {
		if (file.stdin) {
			callback?.();
			tex_final_end();
		}
		file.eof = true;
		return false;
	}

	// The line into TeX's buffer at `first`, as `buffer.subarray(first).set(line)` did, which threw
	// when the line did not fit in what was left of the buffer: that is LineTooLong now (change 11).
	// A short line a byte at a time, which costs less than the view `set` needs.
	const length = endOfLine - from;
	if (length > (first < bufSize ? bufSize - first : 0)) throw new LineTooLong(bufSize);
	const at = bufferp + first;
	if (length < 64) for (let i = 0; i < length; i++) mem[at + i] = content[from + i]!;
	else mem.set(content.subarray(from, endOfLine), at);
	wrote(at, at + length);

	// Trailing spaces off, looking only inside the buffer, as the view of it did: an index outside it
	// read as undefined there, and ended the loop.
	let last = first + length;
	while (last - 1 >= 0 && last - 1 < bufSize && mem[bufferp + last - 1] === 32) last--;
	word[lastp >>> 2] = last;

	file.position2 = endOfLine;
	file.eoln = true;
	return true;
};

export const get = (descriptor: number, pointer: number, length: number) => {
	const file = files[descriptor]!;
	const buffer = bytes!;
	wrote(pointer, pointer + Math.max(1, length));

	if (file.stdin) {
		const input = inputBuffer ?? '';
		if ((file.position ?? 0) >= input.length) {
			buffer[pointer] = 13;
			file.eof = true;
			callback?.();
			tex_final_end();
		} else {
			buffer[pointer] = input.charCodeAt(file.position ?? 0);
		}
	} else if (file.descriptor) {
		// Upstream writes `if (file.descriptor)`, and descriptor 0 is falsy — so the first file
		// opened in a run takes the else branch and is reported as EOF. That looks like a bug, but
		// it is load-bearing behaviour the shipped engine has always had, and "fixing" it here
		// would change rendered output while claiming to be a refactor. Left exactly as upstream;
		// if it is ever worth changing, it is a separate, corpus-gated change.
		if (readSync(file, buffer, pointer, length, file.position ?? 0) === 0) {
			buffer[pointer] = 0;
			file.eof = true;
			file.eoln = true;
			return;
		}
	} else {
		file.eof = true;
		file.eoln = true;
		return;
	}

	file.eoln = buffer[pointer] === 10 || buffer[pointer] === 13;
	file.position = (file.position ?? 0) + length;
};

export const put = (descriptor: number, pointer: number, length: number) => {
	const file = files[descriptor]!;
	writeSync(file, bytes!, pointer, length);
};

export const tex_final_end = () => {
	if (consoleBuffer.length) writeToConsole('\n');
};
