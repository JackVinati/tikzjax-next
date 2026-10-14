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
 */

import { tfmData } from '@drgrice1/dvi2html';

export const pages = 2500;

/** One TeX input file: bytes, plus the read/write cursors TeX drives. */
interface TexFile {
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

	if (filesystem[filename]) {
		buffer = filesystem[filename];
	} else if (filename.endsWith('.tfm')) {
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
};

export const setInput = (input: string, cb?: () => void) => {
	inputBuffer = input;
	if (cb) callback = cb;
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
 * exception from this host.
 */
export const executeAsync = (exports: WebAssembly.Exports): Promise<void> =>
	new Promise<void>((resolve) => {
		try {
			(exports.main as () => void)();
		} catch (error) {
			if (!(error instanceof JumpOut)) throw error;
			// The program ends here rather than at TeX's final_end, which would have flushed the line
			// it was printing: the error's context, which the transcript needs.
			tex_final_end();
		}
		resolve();
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

	const bytes = filesystem[filename] ?? builtinMetrics(filename) ?? resolveBundled(filename);
	if (bytes) return bytes.length;
	if (files.some((f) => f.filename === filename && f.written)) return 0;
	if (ERRSTAT_EXTENSIONS.test(filename) && !JOB_LOCAL.test(filename)) missingSink?.(filename);
	return -1;
};

export const close = (descriptor: number) => {
	void files[descriptor];
};

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
	// when the line did not fit in what was left of the buffer. A short line a byte at a time, which
	// costs less than the view `set` needs.
	const length = endOfLine - from;
	if (length > (first < bufSize ? bufSize - first : 0)) throw new RangeError('offset is out of bounds');
	const at = bufferp + first;
	if (length < 64) for (let i = 0; i < length; i++) mem[at + i] = content[from + i]!;
	else mem.set(content.subarray(from, endOfLine), at);

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
