/*
 * TeX WebAssembly host.
 *
 * Forked from drgrice1/tikzjax src/library.js @ 461ac15f (GPL-3.0-or-later), which is itself
 * derived from kisonecat/tikzjax. Copyright the original authors: Jim Fowler, Glenn Rice.
 * This file remains GPL-3.0-or-later. See NOTICE.
 *
 * CHANGES FROM UPSTREAM (see docs/DECISIONS.md D10):
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
}

/** Files written during this run, plus per-run copies of bundled files. Cleared between runs. */
let filesystem: Record<string, Uint8Array> = {};
let files: TexFile[] = [];

let memory: ArrayBuffer | null = null;
let inputBuffer: string | null = null;
let callback: (() => void) | null = null;
let wasmExports: WebAssembly.Exports | null = null;
let finished: { promise: Promise<void>; resolve: () => void } | null = null;

// ---------------------------------------------------------------------------------------------
// Injected environment (change 1, 4, 5, 6)

/** name -> gzip-compressed bytes, as shipped in the bundle. */
let bundledGz: ReadonlyMap<string, Uint8Array> | null = null;
/** name -> inflated bytes. Deliberately NOT cleared by deleteEverything(). */
const inflatedCache = new Map<string, Uint8Array>();
let inflate: ((gz: Uint8Array) => Uint8Array) | null = null;

let logSink: ((line: string) => void) | null = null;
let missingSink: ((name: string) => void) | null = null;
let showConsole = false;
let consoleBuffer = '';

/** Fixed epoch so TeX's \year/\month/\day/\time are reproducible. Overridable for real clocks. */
let clock = { year: 2026, month: 1, day: 1, minutes: 0 };

export const setBundledFiles = (
	map: ReadonlyMap<string, Uint8Array>,
	inflateFn: (gz: Uint8Array) => Uint8Array,
) => {
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
	const data = inflate(gz);
	inflatedCache.set(filename, data);
	return data;
};

/** Names TeX asked for and we could not supply. Drives the plugin's "not bundled" error copy. */
export const clearMissing = () => {
	/* the sink owns accumulation; this exists so callers can reset per job */
};

// ---------------------------------------------------------------------------------------------

const deferredPromise = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
};

export const deleteEverything = () => {
	files = [];
	filesystem = {};
	memory = null;
	inputBuffer = null;
	callback = null;
	showConsole = false;
	consoleBuffer = '';
	finished = null;
	wasmExports = null;
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
		// already rendered keeps rendering byte-identically — but it covers only the Computer
		// Modern set, and it THROWS on anything else. That throw escaped openSync, crossed the
		// wasm frames and killed the whole run: a single `\mathfrak` took the engine down rather
		// than producing an error anyone could read.
		//
		// So: built-in first, then the bundle, then not-found. The bundled fallback is what makes
		// eufm/eusm/msam/msbm usable at all — their WOFF2 faces were always in the font set;
		// only the metrics were missing (upstream #55, #84, #113).
		try {
			buffer = Uint8Array.from(tfmData(filename.replace(/\.tfm$/, '')) as ArrayLike<number>);
		} catch {
			buffer = resolveBundled(filename);
			if (!buffer) {
				missingSink?.(filename);
				files.push({ filename, erstat: 1, eof: true });
				return files.length - 1;
			}
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
};

export const setInput = (input: string, cb?: () => void) => {
	inputBuffer = input;
	if (cb) callback = cb;
};

export const executeAsync = async (exports: WebAssembly.Exports): Promise<void> => {
	wasmExports = exports;
	finished = deferredPromise();
	(wasmExports.main as () => void)();
	(wasmExports.asyncify_stop_unwind as () => void)();
	return finished.promise;
};

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

export const printChar = (descriptor: number, x: number) => {
	const file = fileFor(descriptor);
	if (file.stdout) return writeToConsole(String.fromCharCode(x));
	const b = new Uint8Array(1);
	b[0] = x;
	writeSync(file, b);
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

export const getfilesize = (length: number, pointer: number): number => {
	let filename = readFilename(length, pointer);
	if (filename.startsWith('{')) filename = filename.replace(/^\{/, '').replace(/\}.*/, '');
	filename = filename.replace(/ +$/g, '').replace(/^\*/, '');
	if (filename === 'TeXformats:TEX.POOL') filename = 'tex.pool';

	if (openSync(filename, 'r') !== -1)
		return filesystem[filename]?.length ?? resolveBundled(filename)?.length ?? 0;
	return 0;
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

	const buffer = new Uint8Array(memory!, bufferp, bufSize);
	const first = new Uint32Array(memory!, firstp, 4);
	const last = new Uint32Array(memory!, lastp, 4);

	last[0] = first[0]!;

	if (bypassEoln && !file.eof && file.eoln) file.position2 = (file.position2 ?? 0) + 1;
	if (file.eof) return false;

	let endOfLine = content.indexOf(10, file.position2 ?? 0);
	if (endOfLine < 0) endOfLine = content.length;

	if ((file.position2 ?? 0) >= content.length) {
		if (file.stdin) {
			callback?.();
			tex_final_end();
		}
		file.eof = true;
		return false;
	}

	buffer.subarray(first[0]).set(content.subarray(file.position2 ?? 0, endOfLine));
	last[0] = first[0]! + endOfLine - (file.position2 ?? 0);
	while (buffer[last[0] - 1] === 32) last[0] = last[0] - 1;

	file.position2 = endOfLine;
	file.eoln = true;
	return true;
};

export const get = (descriptor: number, pointer: number, length: number) => {
	const file = files[descriptor]!;
	const buffer = new Uint8Array(memory!);

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
	writeSync(file, new Uint8Array(memory!), pointer, length);
};

export const tex_final_end = () => {
	if (consoleBuffer.length) writeToConsole('\n');
	finished?.resolve();
};
