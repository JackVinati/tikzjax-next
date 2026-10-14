import { describe, expect, it } from 'vitest';
import type { TexFile } from '../engine-src/library';
import { BLOCK, logBytes, stretchSpans, type SavedRun } from '../engine-src/snapshot';
import {
	checksum,
	decodeSavedRun,
	encodeSavedRun,
	sealing,
	sealSavedRun,
	STORED_RUN_FORMAT,
	StoredRunError,
	type ContentSources,
} from '../engine-src/stored-run';

/*
 * A saved run written out as bytes, for the host to keep in IndexedDB across the engine's stops
 * (engine-src/stored-run.ts, internal/DECISIONS.md D36). What comes back must be the run that went
 * in, files of the worker's own put back from the worker; anything else is refused whole, since a
 * run started from wrong bytes draws a wrong diagram. scripts/verify-snapshot.mjs holds diagrams
 * resumed from such bytes to the same diagrams from the start.
 */

const ENGINE = 'engine-a';
const GLOBALS_END = 64 * BLOCK + 40;

/** The worker's own files: one bundled TeX file and one font's metrics. */
const BUNDLED = new Uint8Array([1, 2, 3, 4, 5]);
const METRICS = new Uint8Array([9, 8, 7]);
const sources: ContentSources = {
	originOf: (name, content) =>
		name === 'pgf.sty' && content === BUNDLED
			? 'bundled'
			: name === 'cmr10.tfm' &&
				  content.length === METRICS.length &&
				  content.every((b, i) => b === METRICS[i])
				? 'metrics'
				: undefined,
	contentOf: (name, origin) =>
		origin === 'bundled' && name === 'pgf.sty'
			? BUNDLED
			: origin === 'metrics' && name === 'cmr10.tfm'
				? METRICS.slice()
				: undefined,
};

const block = (fill: number, blocks = 1): Uint8Array => new Uint8Array(BLOCK * blocks).fill(fill);

function run(overrides: Partial<SavedRun> = {}): SavedRun {
	const stretches = [
		{ offset: 0, bytes: block(7) },
		{ offset: 4 * BLOCK, bytes: block(8, 3) },
	];
	const files: TexFile[] = [
		{ filename: 'stdout', stdout: true, erstat: 0 },
		{
			filename: 'stdin',
			stdin: true,
			position: 0,
			position2: 0,
			erstat: 0,
			eoln: false,
			content: new Uint8Array([105, 110]),
		},
		{
			filename: 'input.tex',
			position: 0,
			position2: 40,
			erstat: 0,
			eoln: true,
			content: new Uint8Array(0),
			descriptor: 2,
		},
		{ filename: 'pgf.sty', position: 0, position2: 3, erstat: 0, content: BUNDLED, descriptor: 3 },
		{
			filename: 'old.sty',
			position: 0,
			position2: 9,
			erstat: 0,
			content: new Uint8Array([4, 4]),
			descriptor: 4,
			closed: true,
		},
		{ filename: 'cmr10.tfm', position: 2, erstat: 0, content: METRICS.slice(), descriptor: 5 },
		{
			filename: 'input.log',
			position: 3,
			erstat: 0,
			content: new Uint8Array([76, 79, 71]),
			descriptor: 6,
			written: true,
		},
		{ filename: 'missing.sty', erstat: 1, eof: true },
	];
	const log = ['This is e-TeX', '(./input.tex', 'LaTeX2e <2023-11-01>'];
	return {
		prefix: '\\documentclass{standalone}\n\\begin{document}\n',
		logging: true,
		route: 'abc123',
		stretches,
		spans: stretchSpans(stretches),
		host: {
			files,
			filesystem: { 'input.tex': new Uint8Array(0) },
			inputBuffer: 'input.tex\n\\end\n',
			consoleBuffer: '(./in',
		},
		log,
		missing: ['missing.sty'],
		bytes: 4 * BLOCK + 3 + logBytes(log),
		...overrides,
	};
}

/** A run's own bytes as a plain object, for comparing what comes back with what went in. */
const plain = (r: SavedRun) => ({
	...r,
	stretches: r.stretches.map((s) => ({ offset: s.offset, bytes: [...s.bytes] })),
	host: {
		...r.host,
		files: r.host.files.map((f) => ({
			...f,
			content: f.content === undefined ? undefined : [...f.content],
		})),
		filesystem: Object.fromEntries(Object.entries(r.host.filesystem).map(([k, v]) => [k, [...v]])),
	},
});

describe('a saved run written out and read back', () => {
	it('is the run that went in', () => {
		const original = run();
		const bytes = encodeSavedRun(original, ENGINE, sources);
		expect(plain(decodeSavedRun(bytes, ENGINE, GLOBALS_END, sources))).toEqual(plain(original));
	});

	it('finds the bytes of a closed file of its own only when they are asked for, once', () => {
		const original = run();
		(original.host.files as TexFile[])[3] = { ...original.host.files[3]!, closed: true };
		let found = 0;
		const counting: ContentSources = {
			originOf: sources.originOf,
			contentOf: (name, origin) => (found++, sources.contentOf(name, origin)),
		};
		const back = decodeSavedRun(encodeSavedRun(original, ENGINE, sources), ENGINE, GLOBALS_END, counting);
		// The metrics of the open .tfm are found at once; the closed bundled file's are not.
		expect(found).toBe(1);
		expect(back.host.files[3]!.content).toBe(BUNDLED);
		expect(back.host.files[3]!.content).toBe(BUNDLED);
		expect(found).toBe(2);
	});

	it("names the worker's own files rather than copying them, and puts them back from the worker", () => {
		const original = run();
		const bytes = encodeSavedRun(original, ENGINE, sources);
		const back = decodeSavedRun(bytes, ENGINE, GLOBALS_END, sources);
		expect(back.host.files[3]!.content).toBe(BUNDLED);
		expect([...back.host.files[5]!.content!]).toEqual([...METRICS]);
		// Neither the bundled file's bytes nor the metrics are in the bytes: a recognisable run of
		// them would be. The bundled file is five bytes 1..5.
		const text = [...bytes].join(',');
		expect(text.includes('1,2,3,4,5')).toBe(false);
	});

	it('keeps the bytes of a file TeX wrote, and never names it, even when they match a bundled file', () => {
		const written: TexFile = {
			filename: 'pgf.sty',
			position: 5,
			erstat: 0,
			content: BUNDLED,
			descriptor: 3,
			written: true,
		};
		const original = run();
		(original.host.files as TexFile[])[3] = written;
		const back = decodeSavedRun(encodeSavedRun(original, ENGINE, sources), ENGINE, GLOBALS_END, sources);
		expect(back.host.files[3]!.content).not.toBe(BUNDLED);
		expect([...back.host.files[3]!.content!]).toEqual([...BUNDLED]);
	});

	it('gives stretches that are views of the bytes, and holds as much as the run did', () => {
		const original = run();
		const bytes = encodeSavedRun(original, ENGINE, sources);
		const back = decodeSavedRun(bytes, ENGINE, GLOBALS_END, sources);
		for (const stretch of back.stretches) expect(stretch.bytes.buffer).toBe(bytes.buffer);
		expect(back.spans).toEqual(original.spans);
		expect(back.bytes).toBe(original.bytes);
	});

	it('keeps an array that two entries share once', () => {
		const shared = new Uint8Array(1000).fill(3);
		const original = run();
		(original.host.files as TexFile[]).push({
			filename: 'a.tex',
			erstat: 0,
			content: shared,
			descriptor: 8,
		});
		(original.host.files as TexFile[]).push({
			filename: 'b.tex',
			erstat: 0,
			content: shared,
			descriptor: 9,
		});
		const once = encodeSavedRun(original, ENGINE, sources).length;
		(original.host.files as TexFile[])[original.host.files.length - 1] = {
			filename: 'b.tex',
			erstat: 0,
			content: shared.slice(),
			descriptor: 9,
		};
		expect(encodeSavedRun(original, ENGINE, sources).length - once).toBeGreaterThanOrEqual(1000);
	});

	it('reads a prefix and a log in any script', () => {
		const original = run({
			prefix: '\\usepackage{xeCJK}% 中文 ελληνικά 🙂\n\\begin{document}\n',
			log: ['ü ✓'],
		});
		const back = decodeSavedRun(encodeSavedRun(original, ENGINE, sources), ENGINE, GLOBALS_END, sources);
		expect(back.prefix).toBe(original.prefix);
		expect(back.log).toEqual(['ü ✓']);
	});
});

describe('bytes that are refused', () => {
	const good = (): Uint8Array => encodeSavedRun(run(), ENGINE, sources);
	const refused = (bytes: Uint8Array, verify = true) =>
		expect(() => decodeSavedRun(bytes, ENGINE, GLOBALS_END, sources, verify)).toThrow(StoredRunError);

	it('any one byte changed, anywhere', () => {
		const bytes = good();
		for (let at = 0; at < bytes.length; at += 7) {
			const copy = bytes.slice();
			copy[at] = copy[at]! ^ 0x10;
			refused(copy);
		}
	});

	it('cut short, or with bytes added', () => {
		const bytes = good();
		refused(bytes.subarray(0, bytes.length - 8));
		refused(bytes.subarray(0, 20));
		const longer = new Uint8Array(bytes.length + 8);
		longer.set(bytes);
		refused(longer);
	});

	it("another engine's", () => {
		expect(() => decodeSavedRun(good(), 'engine-b', GLOBALS_END, sources)).toThrow(/another engine/);
	});

	it('another format', () => {
		const bytes = good();
		new DataView(bytes.buffer).setUint32(4, STORED_RUN_FORMAT + 1, true);
		expect(() => decodeSavedRun(bytes, ENGINE, GLOBALS_END, sources, false)).toThrow(/another format/);
	});

	it('a stretch past the end of the globals', () => {
		const bytes = encodeSavedRun(run(), ENGINE, sources);
		expect(() => decodeSavedRun(bytes, ENGINE, 4 * BLOCK, sources)).toThrow(/outside the globals/);
	});

	it('a stretch that is not whole blocks, or out of order', () => {
		const odd = run({ stretches: [{ offset: 0, bytes: new Uint8Array(BLOCK + 8) }] });
		refused(encodeSavedRun(odd, ENGINE, sources));
		const back = run({
			stretches: [
				{ offset: 4 * BLOCK, bytes: block(1) },
				{ offset: 0, bytes: block(2) },
			],
		});
		refused(encodeSavedRun(back, ENGINE, sources));
	});

	it('a bundled file this worker does not have', () => {
		const none: ContentSources = { originOf: sources.originOf, contentOf: () => undefined };
		expect(() => decodeSavedRun(good(), ENGINE, GLOBALS_END, none)).toThrow(/no bundled file pgf.sty/);
	});

	it('a header changed under a matching checksum, when the checksum is not read', () => {
		// Gzipped bytes are checked by gzip's CRC-32 instead (worker.ts readStored); what is left is
		// still checked for what it says.
		const bytes = good();
		const at = 24 + new TextDecoder().decode(bytes.subarray(24, 200)).indexOf('"engineId":"') + 12;
		bytes[at] = 'x'.charCodeAt(0);
		expect(() => decodeSavedRun(bytes, ENGINE, GLOBALS_END, sources, false)).toThrow(/another engine/);
	});
});

describe('checksum', () => {
	it('is left out of bytes to be gzipped, and taken a slice at a time is the one taken whole', () => {
		const big = run({
			stretches: [
				{ offset: 0, bytes: block(3) },
				{ offset: 8 * BLOCK, bytes: block(5) },
			],
		});
		const whole = encodeSavedRun(big, ENGINE, sources);
		const bare = encodeSavedRun(big, ENGINE, sources, false);
		expect(new DataView(bare.buffer).getInt32(12, true)).toBe(0);
		// Read as gzipped bytes are, without the checksum; refused where it is read.
		expect(decodeSavedRun(bare, ENGINE, GLOBALS_END, sources, false).prefix).toBe(big.prefix);
		expect(() => decodeSavedRun(bare, ENGINE, GLOBALS_END, sources)).toThrow(/checksum/);
		for (const slice of [4, 64, 1000, BLOCK, Infinity]) {
			const copy = bare.slice();
			let steps = 0;
			for (const _ of sealing(copy, slice)) steps++;
			expect(copy).toEqual(whole);
			if (slice < bare.length / 2) expect(steps).toBeGreaterThan(0);
		}
		const copy = bare.slice();
		sealSavedRun(copy);
		expect(copy).toEqual(whole);
	});

	it('moves with any one word changed, and with the length', () => {
		const words = new Int32Array(1001).map((_, i) => i * 2654435761);
		const sum = checksum(words);
		for (let i = 0; i < words.length; i += 13) {
			const copy = words.slice();
			copy[i] = copy[i]! ^ (1 << (i % 32));
			expect(checksum(copy)).not.toBe(sum);
		}
		expect(checksum(words.subarray(0, 1000))).not.toBe(sum);
	});
});
