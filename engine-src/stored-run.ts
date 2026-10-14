/**
 * A saved run as bytes, which the host keeps in IndexedDB so that it outlives the engine that saved
 * it (internal/DECISIONS.md D36): a phone stops its engine after 15 s idle (D37) and whenever Obsidian
 * goes to the background, and the runs an engine holds in memory (./snapshot) went with it.
 *
 * The bytes are the run as ./snapshot keeps it, written out: TeX's globals where they differ from the
 * core dump, the host's table of files, what TeX had said by then, and the text the run stands for.
 * The files TeX was reading from the bundle are named rather than copied, and put back from the
 * worker's own when the run is read: they are the same bytes in every worker of one ENGINE_ID, which
 * every stored run carries and is read under only.
 *
 * Laid out as a fixed head, a header of JSON and the blobs it points at, each on 8 bytes:
 *
 *   0   'TJSR'           4   the format, 1
 *   8   the header's length in bytes
 *   12  a checksum of everything from byte 24 on, or 0 in bytes to be gzipped
 *   16  the whole length          20  0, which a later format may use
 *   24  the header, then the blobs
 *
 * Anything that does not read back as written, or names what this worker cannot put back, is
 * refused whole: a run started from wrong bytes draws a wrong diagram, where a run refused costs
 * only the preamble's compile. The checksum is there for the bytes the host keeps uncompressed,
 * where nothing else would see a byte changed in storage, and is checked on all of them. Bytes kept
 * gzipped are covered by gzip's CRC-32, which the inflate checks, and their checksum is neither
 * taken nor read: taken over the whole run in one step, it was most of what writing a run out cost
 * without a JIT, about 120 ms for circuitikz's 8.9 MiB in WebKit (D36). So the bytes are written
 * without it (`encodeSavedRun`), and the worker takes it, a slice at a time (`sealing`), only for a
 * run it hands over uncompressed.
 *
 * A module of its own, apart from worker.ts, so that it can be tested and run by
 * scripts/verify-snapshot.mjs without booting an engine.
 */
import type { HostState, TexFile } from './library';
import { BLOCK, logBytes, stretchSpans, type SavedRun, type Stretch } from './snapshot';

/** 'TJSR', read as a little-endian word. */
export const STORED_RUN_MAGIC = 0x52534a54;
/** Moves whenever the layout below changes; a run of another format is refused, not read. */
export const STORED_RUN_FORMAT = 1;
const HEAD = 24;

/**
 * Where the bytes of a file in the host's table come from when the run is read back: in the stored
 * bytes, or the worker's own copy of a bundled file or of dvi2html's metrics for a font.
 */
export type ContentOrigin = 'bundled' | 'metrics';

/** What the stored format needs of the host (./library storedContent). */
export interface ContentSources {
	/** Whether `content`, opened under `name`, is one of the worker's own files rather than bytes of the run's. */
	originOf(name: string, content: Uint8Array): ContentOrigin | undefined;
	/** The bytes `name` has from `origin` in this worker, or undefined where it has none. */
	contentOf(name: string, origin: ContentOrigin): Uint8Array | undefined;
}

/** A file's bytes, as stored: a blob of the run's, or a file of the worker's. */
type StoredContent = number | ContentOrigin | null;

/** A file of the host's table, as stored: its fields but its bytes, and where they come from. */
type StoredFile = Omit<TexFile, 'content'> & { content: StoredContent };

interface Header {
	engineId: string;
	prefix: string;
	logging: boolean;
	route: string;
	log: string[];
	missing: string[];
	/** [offset in the memory, blob] for each stretch. */
	stretches: [number, number][];
	files: StoredFile[];
	filesystem: [string, StoredContent][];
	inputBuffer: string | null;
	consoleBuffer: string;
	/** [where, length] of each blob, from the start of the bytes. */
	blobs: [number, number][];
}

const align8 = (n: number): number => (n + 7) & ~7;

/**
 * A checksum of `words`: each word mixed into the running value by a step that is one-to-one for a
 * given word, so that a run of words that differs from the stored one in any one word gives another
 * value, and in more than one, almost always. About a millisecond a MiB with a JIT.
 */
export function checksum(words: Int32Array): number {
	return mix(0x2545f491 ^ words.length, words) | 0;
}

/**
 * `h` with each of `words` mixed in, in order, one word at a time: a checksum taken a slice at a time,
 * the running value carried from one to the next, is the one taken whole.
 */
function mix(h: number, words: Int32Array): number {
	const n = words.length;
	let i = 0;
	for (; i + 4 <= n; i += 4) {
		h = Math.imul(h ^ words[i]!, 0x9e3779b1);
		h = Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64;
		h = Math.imul(h ^ words[i + 1]!, 0x9e3779b1);
		h = Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64;
		h = Math.imul(h ^ words[i + 2]!, 0x9e3779b1);
		h = Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64;
		h = Math.imul(h ^ words[i + 3]!, 0x9e3779b1);
		h = Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64;
	}
	for (; i < n; i++) {
		h = Math.imul(h ^ words[i]!, 0x9e3779b1);
		h = Math.imul((h << 13) | (h >>> 19), 5) + 0xe6546b64;
	}
	return h;
}

/**
 * Write the checksum of `bytes`, a run as `encodeSavedRun` writes it, into its head, about `slice`
 * bytes of it at a step: the generator stops between slices, so that the caller can spread the work
 * over tasks of its own.
 */
export function* sealing(bytes: Uint8Array, slice = Infinity): Generator<void, void, void> {
	const words = new Int32Array(bytes.buffer, bytes.byteOffset + HEAD, (bytes.length - HEAD) >>> 2);
	const step = Math.max(1, Math.floor(slice / 4));
	let h = 0x2545f491 ^ words.length;
	for (let at = 0; ; at += step) {
		h = mix(h, words.subarray(at, at + step));
		if (at + step >= words.length) break;
		yield;
	}
	new DataView(bytes.buffer, bytes.byteOffset, bytes.length).setInt32(12, h | 0, true);
}

/** The same, at once. */
export function sealSavedRun(bytes: Uint8Array): void {
	const steps = sealing(bytes);
	let done = false;
	while (!done) done = steps.next().done === true;
}

/**
 * `run` as bytes. The files it reads from the bundle are named, not copied (`sources`); everything
 * else it holds is in the bytes, each array once however many of its entries share it. With `seal`
 * false the checksum is left 0, for bytes that will be gzipped, or sealed later (`sealing`).
 */
export function encodeSavedRun(
	run: SavedRun,
	engineId: string,
	sources: ContentSources,
	seal = true,
): Uint8Array {
	const blobs: Uint8Array[] = [];
	const seen = new Map<Uint8Array, number>();
	const blob = (bytes: Uint8Array): number => {
		const known = seen.get(bytes);
		if (known !== undefined) return known;
		blobs.push(bytes);
		seen.set(bytes, blobs.length - 1);
		return blobs.length - 1;
	};
	const content = (name: string, bytes: Uint8Array | undefined, written: boolean): StoredContent => {
		if (bytes === undefined) return null;
		const origin = written ? undefined : sources.originOf(name, bytes);
		return origin ?? blob(bytes);
	};
	const stretches = run.stretches.map((s): [number, number] => [s.offset, blob(s.bytes)]);
	const host = run.host;
	const files = host.files.map((f): StoredFile => {
		const { content: bytes, ...rest } = f;
		return { ...rest, content: content(f.filename, bytes, f.written === true) };
	});
	const filesystem = Object.entries(host.filesystem).map(([name, bytes]): [string, StoredContent] => [
		name,
		content(name, bytes, false),
	]);

	const header: Header = {
		engineId,
		prefix: run.prefix,
		logging: run.logging,
		route: run.route,
		log: run.log,
		missing: run.missing,
		stretches,
		files,
		filesystem,
		inputBuffer: host.inputBuffer,
		consoleBuffer: host.consoleBuffer,
		blobs: [],
	};
	// Where each blob goes depends on the header's length, which depends on where each blob goes: the
	// header is laid out with every blob's place written in full width, then filled in.
	const placeholder = blobs.map((): [number, number] => [0xfffffff, 0xfffffff]);
	const sized = new TextEncoder().encode(JSON.stringify({ ...header, blobs: placeholder }));
	let at = align8(HEAD + sized.length);
	header.blobs = blobs.map((bytes) => {
		const where: [number, number] = [at, bytes.length];
		at = align8(at + bytes.length);
		return where;
	});
	const text = new TextEncoder().encode(JSON.stringify(header));
	if (text.length > sized.length) throw new Error('the header grew');

	const total = at;
	const out = new Uint8Array(total);
	const head = new DataView(out.buffer);
	head.setUint32(0, STORED_RUN_MAGIC, true);
	head.setUint32(4, STORED_RUN_FORMAT, true);
	head.setUint32(8, text.length, true);
	head.setUint32(16, total, true);
	out.set(text, HEAD);
	// The rest of the room left for the header is spaces, which JSON reads past.
	out.fill(32, HEAD + text.length, HEAD + sized.length);
	blobs.forEach((bytes, i) => out.set(bytes, header.blobs[i]![0]));
	if (seal) sealSavedRun(out);
	return out;
}

/**
 * A file of the worker's own that TeX read and closed, put back with its bytes found only when
 * something asks for them. TeX never reads a closed file again, as a file opened again is an entry
 * of its own; but most of the files a preamble reads are closed by its \begin{document}, the bundled
 * ones among them, and a worker that starts from a stored run would otherwise inflate each of them
 * for nothing, about half of what reading the run back took for siunitx in Chromium (D36). The entry
 * is shared rather than copied by a run that starts from it (library.ts restoreHostState), so that
 * the bytes are found at most once.
 */
function closedFile(
	rest: Omit<StoredFile, 'content'>,
	origin: ContentOrigin,
	sources: ContentSources,
): TexFile {
	const file: TexFile = { ...rest };
	let bytes: Uint8Array | undefined;
	Object.defineProperty(file, 'content', {
		enumerable: true,
		configurable: true,
		get: () => (bytes ??= sources.contentOf(rest.filename, origin) ?? new Uint8Array(0)),
	});
	return file;
}

/** Why bytes were refused. */
export class StoredRunError extends Error {}

const refuse = (why: string): never => {
	throw new StoredRunError(why);
};

const isIndex = (n: unknown, below: number): n is number =>
	typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < below;

/**
 * The run `bytes` hold, as the engine holds one in memory (./snapshot SavedRun), its stretches views
 * of `bytes`; or StoredRunError, for bytes of another format, another engine, a length or checksum
 * that does not match, a stretch outside TeX's globals, or a file this worker cannot put back.
 * `globalsEnd` is where TeX's globals end in the memory (./reset MemoryLayout). The checksum is
 * checked unless `verify` is false, for bytes that were gzipped, whose CRC-32 the inflate checked.
 */
export function decodeSavedRun(
	bytes: Uint8Array,
	engineId: string,
	globalsEnd: number,
	sources: ContentSources,
	verify = true,
): SavedRun {
	if (bytes.length < HEAD || bytes.byteOffset % 4 !== 0) refuse('too short');
	const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
	if (head.getUint32(0, true) !== STORED_RUN_MAGIC) refuse('not a stored run');
	if (head.getUint32(4, true) !== STORED_RUN_FORMAT) refuse('another format');
	const total = head.getUint32(16, true);
	if (total !== bytes.length || total % 8 !== 0) refuse('cut short, or too long');
	if (head.getUint32(20, true) !== 0) refuse('not a stored run');
	const textLength = head.getUint32(8, true);
	if (HEAD + textLength > total) refuse('a header past the end');
	if (verify) {
		const sum = checksum(new Int32Array(bytes.buffer, bytes.byteOffset + HEAD, (total - HEAD) >>> 2));
		if (sum !== head.getInt32(12, true)) refuse('the checksum does not match');
	}

	let header: Header;
	try {
		header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEAD, HEAD + textLength))) as Header;
	} catch {
		return refuse('a header that does not parse');
	}
	if (header.engineId !== engineId) refuse('another engine');
	if (typeof header.prefix !== 'string' || typeof header.route !== 'string') refuse('no text');
	if (typeof header.logging !== 'boolean') refuse('no logging flag');
	if (!Array.isArray(header.log) || !Array.isArray(header.missing)) refuse('no log');
	if (!Array.isArray(header.blobs) || !Array.isArray(header.stretches) || !Array.isArray(header.files))
		refuse('no tables');

	const blobs = header.blobs.map(([where, length]) => {
		if (!isIndex(where, total + 1) || !isIndex(length, total + 1) || where < HEAD + textLength)
			refuse('a blob outside the bytes');
		if (where + length > total) refuse('a blob past the end');
		return bytes.subarray(where, where + length);
	});
	const blobAt = (i: unknown): Uint8Array =>
		isIndex(i, blobs.length) ? blobs[i]! : refuse('no such blob');
	const contentOf = (name: string, stored: StoredContent): Uint8Array | undefined => {
		if (stored === null) return undefined;
		if (stored === 'bundled' || stored === 'metrics')
			return sources.contentOf(name, stored) ?? refuse(`no ${stored} file ${name}`);
		return blobAt(stored);
	};

	// The stretches as the save cut them: whole blocks, in order, apart, and within TeX's globals.
	const limit = globalsEnd + ((BLOCK - (globalsEnd % BLOCK)) % BLOCK);
	let end = 0;
	const stretches: Stretch[] = header.stretches.map(([offset, i]) => {
		const stretch = blobAt(i);
		if (!isIndex(offset, limit) || offset % BLOCK !== 0) refuse('a stretch outside the globals');
		if (offset < end) refuse('a stretch out of order');
		if (stretch.length === 0 || stretch.length % BLOCK !== 0 || offset + stretch.length > limit)
			refuse('a stretch outside the globals');
		end = offset + stretch.length;
		return { offset, bytes: stretch };
	});

	const files: TexFile[] = header.files.map((f) => {
		if (typeof f?.filename !== 'string') refuse('a file without a name');
		const { content: stored, ...rest } = f;
		if (f.closed === true && f.written !== true && (stored === 'bundled' || stored === 'metrics'))
			return closedFile(rest, stored, sources);
		const content = contentOf(f.filename, stored);
		return content === undefined ? rest : { ...rest, content };
	});
	const filesystem: Record<string, Uint8Array> = {};
	for (const [name, stored] of header.filesystem ?? []) {
		const content = typeof name === 'string' ? contentOf(name, stored) : undefined;
		if (content === undefined) refuse('a file without bytes');
		filesystem[name] = content!;
	}
	const host: HostState = {
		files,
		filesystem,
		inputBuffer: typeof header.inputBuffer === 'string' ? header.inputBuffer : null,
		consoleBuffer: typeof header.consoleBuffer === 'string' ? header.consoleBuffer : '',
	};
	const log = header.log.map(String);
	// What it holds, reckoned as for a run saved in this worker (worker.ts saveRun): its stretches,
	// the files TeX was writing, and its log.
	const held =
		stretches.reduce((n, s) => n + s.bytes.length, 0) +
		files.reduce((n, f) => n + (f.written && f.content ? f.content.length : 0), 0) +
		logBytes(log);
	return {
		prefix: header.prefix,
		logging: header.logging,
		route: header.route,
		stretches,
		spans: stretchSpans(stretches),
		host,
		log,
		missing: header.missing.map(String),
		bytes: held,
	};
}
