import { describe, expect, it } from 'vitest';

import { deriveKey } from '../src/cache/key';
import { legacyKey, md5Hex } from '../src/cache/legacy-key';
import { sha256Hex } from '../src/cache/sha256';
import type { BakedOptions, BlockOptions, KeyInputs, Presentation } from '../src/types';

/**
 * The oracles are deliberately outside this codebase — a hand-rolled digest is only worth having
 * if it is bit-identical to the real thing, and "check it against a couple of vectors I
 * remembered" is exactly how a subtly wrong one ships.
 *
 * SHA-256 gets a live oracle: `crypto.subtle`, which is the implementation we would have used if
 * it were synchronous (docs/DESIGN.md §6.1). MD5 has no WebCrypto equivalent, so its expectations
 * are literals produced by node:crypto and frozen here. They are reproducible with:
 *
 *   node -e "console.log(require('node:crypto').createHash('md5').update(S,'utf8').digest('hex'))"
 *
 * node:crypto is not imported directly because the project typechecks `test/` with `types: []`
 * (no @types/node globals in a browser plugin), and pulling them in for one import would change
 * how `setTimeout` types across the whole program.
 */
const subtleSha256 = async (s: string): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

describe('sha256Hex', () => {
	it('matches the published vectors', () => {
		expect(sha256Hex('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
		);
	});

	it('matches crypto.subtle on a long input', async () => {
		const long = 'x'.repeat(100_000);
		expect(sha256Hex(long)).toBe(await subtleSha256(long));
	});

	/**
	 * The padding rule is where a hand-rolled digest actually breaks: 55 bytes still fits in one
	 * block alongside the 0x80 and the 8-byte length, 56 does not and forces a second block that
	 * is nothing but padding. Sweeping the range covers both of those and every block-count
	 * transition after them.
	 */
	it('matches crypto.subtle across every padding boundary', async () => {
		for (let n = 0; n <= 200; n++) {
			const s = 'a'.repeat(n);
			expect(sha256Hex(s), `length ${n}`).toBe(await subtleSha256(s));
		}
	});

	it('hashes the UTF-8 encoding, not UTF-16 code units', async () => {
		for (const s of ['é', 'Ω⊗', '𝕏', '👩‍🔬', '\\draw (0,0) -- (1,1); % — é']) {
			expect(sha256Hex(s), JSON.stringify(s)).toBe(await subtleSha256(s));
		}
	});

	/**
	 * The 0-200 sweep above is all ASCII, where UTF-16 length and UTF-8 byte length coincide — so
	 * it cannot see a padding, a 0x80 offset or a bit count computed from `input.length` instead of
	 * `bytes.length`. These characters are 2, 3 and 4 UTF-8 bytes (the last is also two UTF-16 code
	 * units), which decouples the two and walks the same block boundaries with them apart. A
	 * preamble full of accented `\node` labels is an ordinary input here, not an exotic one.
	 */
	it('pads from the UTF-8 byte length, not the string length', async () => {
		for (const ch of ['é', '⊗', '\u{1d54f}']) {
			for (let n = 0; n <= 40; n++) {
				const s = ch.repeat(n);
				expect(sha256Hex(s), `${JSON.stringify(ch)} x${n}`).toBe(await subtleSha256(s));
			}
		}
	});

	/**
	 * The message schedule is a module-level Uint32Array so that a cache-key probe does not
	 * allocate 256 bytes per call. That is only safe if every word is rewritten each block; a
	 * stale one would make a hash depend on whatever was hashed before it.
	 */
	it('does not carry state between calls', () => {
		const abc = sha256Hex('abc');
		sha256Hex('x'.repeat(500));
		sha256Hex('');
		expect(sha256Hex('abc')).toBe(abc);
	});

	it('returns 64 lowercase hex characters', () => {
		expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('md5Hex', () => {
	it('matches the RFC 1321 vectors', () => {
		expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
		expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
		expect(md5Hex('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
		const digits = '1234567890'.repeat(8);
		expect(md5Hex(digits)).toBe('57edf4a22be3c955ac49da2e2107b67a');
		expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe(
			'9e107d9d372bb6826bd81d3542a419d6',
		);
	});

	/** `'a'.repeat(n)` for the lengths that straddle a padding or block boundary. */
	it('pads correctly at every block boundary', () => {
		const vectors: Array<[number, string]> = [
			[54, 'eced9e0b81ef2bba605cbc5e2e76a1d0'],
			[55, 'ef1772b6dff9a122358552954ad0df65'],
			[56, '3b0c8ac703f828b04c6c197006d17218'],
			[57, '652b906d60af96844ebd21b674f35e93'],
			[63, 'b06521f39153d618550606be297466d5'],
			[64, '014842d480b571495a4a0363793f7367'],
			[65, 'c743a45e0d2e6a95cb859adae0248435'],
			[119, '8a7bd0732ed6a28ce75f6dabc90e1613'],
			[120, '5f61c0ccad4cac44c75ff505e1f1e537'],
			[121, 'f6acfca2d47c87f2b14ca038234d3614'],
			[127, '020406e1d05cdc2aa287641f7ae2cc39'],
			[128, 'e510683b3f5ffe4093d021808bc6ff70'],
			[129, 'b325dc1c6f5e7a2b7cf465b9feab7948'],
			[191, '16e2824f7a3f00ef0028994182071953'],
			[192, '234c07907df5019d5f40f03936939bce'],
			[200, '887f30b43b2867f4a9accceee7d16e6c'],
		];
		for (const [n, expected] of vectors) {
			expect(md5Hex('a'.repeat(n)), `length ${n}`).toBe(expected);
		}
	});

	it('handles an input of many blocks', () => {
		expect(md5Hex('y'.repeat(100_000))).toBe('f0a7af634b47967c6cf3a0aaaaa50d17');
	});

	/** The bundle ran `charenc.utf8.stringToBytes` first, so a multi-byte source hashes its bytes. */
	it('hashes the UTF-8 encoding', () => {
		expect(md5Hex('é')).toBe('66ddcd97cfdeabb2f6fb8a999b4bc76f');
		expect(md5Hex('Ω⊗')).toBe('0ff7107ce82c7fe83f552712788778ca');
		expect(md5Hex('𝕏')).toBe('d9949e7f8d9fc5cbd6c57539a26363f3');
		expect(md5Hex('\\node {é};')).toBe('1fcd9ab07fb0f0cd257a7548731789f7');
	});

	/**
	 * Same gap as sha256's: every vector above is one byte per code unit, so none of them would
	 * notice a length computed before the UTF-8 encode. Each repeat count below is chosen so that
	 * the byte length lands on or beside a 56/64-byte boundary for a 2-, 3- or 4-byte character.
	 */
	it('pads multi-byte input from its byte length', () => {
		const vectors: Array<[string, number, string]> = [
			['é', 27, 'e28696afa26a51e0ca39fa166b80fde8'], // 54 bytes
			['é', 28, '20b0102488adc14d6375a20e9e1ed8b3'], // 56 — forces a second block
			['é', 32, '4f9422a963487c03fd6bedc66273647e'], // 64 — exactly one block
			['é', 33, '077487916da57cf9188bbd0c5e604050'], // 66
			['⊗', 18, '554664a9ed541276e29443cfe02094d3'], // 54
			['⊗', 19, '9f85f3448deb7a469e834d9aebc08cd2'], // 57
			['⊗', 21, 'b0af8d45a964e17ebe36d0002f1a6c4f'], // 63
			['\u{1d54f}', 13, '744f247f25398706958f06078f46b679'], // 52, 26 UTF-16 units
			['\u{1d54f}', 14, '6756ef28b82549b6cd86678bec80a09b'], // 56, 28 UTF-16 units
			['\u{1d54f}', 16, '4c0b17dd7aa9f6815182a01fa41bb449'], // 64, 32 UTF-16 units
		];
		for (const [ch, n, expected] of vectors) {
			expect(md5Hex(ch.repeat(n)), `${JSON.stringify(ch)} x${n}`).toBe(expected);
		}
	});

	it('returns 32 lowercase hex characters', () => {
		expect(md5Hex('anything')).toMatch(/^[0-9a-f]{32}$/);
	});
});

// -------------------------------------------------------------------------------------------

const BAKED: BakedOptions = {
	twoPass: false,
	border: null,
	packages: { pgfplots: '', circuitikz: 'siunitx' },
	libraries: 'arrows.meta,calc',
	preamble: '\\def\\x{1}',
	depHashes: ['notes/a.tex:aaaa', 'notes/z.tex:zzzz'],
	wrap: 'auto',
};

const INPUTS: KeyInputs = {
	normalizedSource: '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}',
	baked: BAKED,
	engineId: 'core-0f1e2d3c',
	artifactRevision: '{"svgo":"preset","fast":false,"sourceHandling":"corrected"}',
	pipeline: { raw: false, fast: false, svgo: 'preset' },
};

const withBaked = (patch: Partial<BakedOptions>): KeyInputs => ({
	...INPUTS,
	baked: { ...BAKED, ...patch },
});

describe('deriveKey', () => {
	it('is 32 lowercase hex characters and deterministic', () => {
		expect(deriveKey(INPUTS)).toMatch(/^[0-9a-f]{32}$/);
		expect(deriveKey(INPUTS)).toBe(deriveKey(INPUTS));
		// A structurally equal but distinct object, in case anything ever leans on identity.
		expect(deriveKey(structuredClone(INPUTS))).toBe(deriveKey(INPUTS));
	});

	/**
	 * Pinned, so that a change to the derivation — a SCHEMA_VERSION bump, a new input, a different
	 * encoding — is an edit to this line rather than a silent vault-wide cache miss discovered by
	 * a user. The value is sha256 of the length-prefixed payload described in cache/key.ts,
	 * truncated to 32 hex characters, and was computed independently of the implementation.
	 */
	it('is pinned', () => {
		// Moved twice, both deliberate:
		//   1. `pipeline` (raw/fast/svgo) joined KeyInputs, after review showed a block toggled to
		//      fast mode collided with its own full-quality artifact;
		//   2. `twoPass` joined BakedOptions, because a second pass changes the stored bytes.
		// This line changing is the intended signal. Every previously cached key becomes a miss,
		// which is correct, and misses are swept on idle rather than wiped at startup.
		expect(deriveKey(INPUTS)).toBe('41df0c0cae9cd60eb86fc55307200129');
	});

	it('changes when any single input changes', () => {
		const variants: Record<string, KeyInputs> = {
			base: INPUTS,
			normalizedSource: { ...INPUTS, normalizedSource: `${INPUTS.normalizedSource} ` },
			engineId: { ...INPUTS, engineId: 'core-0f1e2d3d' },
			artifactRevision: { ...INPUTS, artifactRevision: '{"svgo":"off"}' },
			// Per-block pipeline flags. Without these in the key, a block toggled to fast mode
			// collides with its own full-quality artifact and serves whichever was stored first.
			'pipeline.fast': { ...INPUTS, pipeline: { ...INPUTS.pipeline, fast: true } },
			'pipeline.raw': { ...INPUTS, pipeline: { ...INPUTS.pipeline, raw: true } },
			'pipeline.svgo': { ...INPUTS, pipeline: { ...INPUTS.pipeline, svgo: 'off' } },
			border: withBaked({ border: '2pt' }),
			packagesValue: withBaked({
				packages: { pgfplots: '', circuitikz: 'europeanresistors' },
			}),
			packagesExtra: withBaked({ packages: { ...BAKED.packages, chemfig: '' } }),
			libraries: withBaked({ libraries: 'arrows.meta' }),
			preamble: withBaked({ preamble: '\\def\\x{2}' }),
			depHashes: withBaked({ depHashes: ['notes/a.tex:aaaa', 'notes/z.tex:zzz1'] }),
			wrap: withBaked({ wrap: 'never' }),
		};

		const seen = new Map<string, string>();
		for (const [name, inputs] of Object.entries(variants)) {
			const key = deriveKey(inputs);
			expect(seen.get(key), `${name} collides with ${seen.get(key)}`).toBeUndefined();
			seen.set(key, name);
		}
	});

	/**
	 * `packages` is built by parsing `%!tikz packages=`, so its insertion order is whatever order
	 * the user typed. Plain JSON.stringify would give `pgfplots,circuitikz` and
	 * `circuitikz,pgfplots` different keys for byte-identical TeX, i.e. a guaranteed recompile for
	 * an edit that changed nothing.
	 */
	it('ignores the order of baked-option keys', () => {
		const reordered: BakedOptions = {
			twoPass: BAKED.twoPass,
			wrap: BAKED.wrap,
			preamble: BAKED.preamble,
			depHashes: [...BAKED.depHashes],
			libraries: BAKED.libraries,
			packages: { circuitikz: 'siunitx', pgfplots: '' },
			border: BAKED.border,
		};
		expect(deriveKey({ ...INPUTS, baked: reordered })).toBe(deriveKey(INPUTS));
	});

	/**
	 * Deliberately the opposite of `packages`: `depHashes` is documented as sorted by whoever
	 * builds it, and array order is meaningful in general, so it is hashed as written rather than
	 * re-sorted behind the caller's back.
	 */
	it('is sensitive to depHashes order', () => {
		expect(deriveKey(withBaked({ depHashes: [...BAKED.depHashes].reverse() }))).not.toBe(
			deriveKey(INPUTS),
		);
	});

	/**
	 * §6.1's headline property: theme, colour mode, scale, width, alignment, alt text, lazy mode
	 * and timeout are mount-time concerns, so switching theme or resizing a diagram must cost zero
	 * recompiles. They are not merely equal-keyed here — they are not reachable from `KeyInputs`
	 * at all, which is what this projection makes explicit.
	 */
	it('ignores presentation entirely', () => {
		const block = (presentation: Presentation): BlockOptions => ({
			baked: { ...BAKED },
			presentation,
			raw: false,
			nocache: false,
			fast: false,
			warnings: [],
		});

		// Exactly the projection the processor performs: a block's baked half, and nothing else.
		const project = (b: BlockOptions): KeyInputs => ({
			normalizedSource: INPUTS.normalizedSource,
			baked: b.baked,
			engineId: INPUTS.engineId,
			artifactRevision: INPUTS.artifactRevision,
			// `raw` and `fast` DO belong in the key — they change the stored bytes — but they are
			// not presentation, which is what this test is about. Held constant so the assertion
			// stays about width/scale/align/colour and nothing else.
			pipeline: { raw: b.raw, fast: b.fast, svgo: INPUTS.pipeline.svgo },
		});

		const light: Presentation = {
			colors: 'adapt',
			scale: 1,
			align: 'left',
			width: '100%',
			timeoutMs: 10_000,
			lazy: 'on',
		};
		const dark: Presentation = {
			colors: 'invert',
			scale: 2.5,
			align: 'right',
			maxWidth: '20em',
			timeoutMs: 60_000,
			lazy: 'off',
			alt: 'a commutative diagram',
		};

		expect(deriveKey(project(block(dark)))).toBe(deriveKey(project(block(light))));
		expect(deriveKey(project(block(light)))).toBe(deriveKey(INPUTS));
	});

	/**
	 * Fields are length-prefixed rather than separator-joined, and these are the inputs that
	 * actually establish it.
	 *
	 * The obvious pair — `'core'`/`'Xdraw'` against `'coreX'`/`'draw'` — does **not**. Under
	 * DESIGN §6.1's literal `[…].join(' ')` those two produce `"…ecore Xdraw…"` and
	 * `"…ecoreX draw…"`, which differ, because the separator travels with the character. A
	 * separator only collides when a field *contains* it — and `normalizedSource` is TeX, so it
	 * contains spaces, newlines and tabs in every real block. So the sweep below asks the
	 * requirement instead of the implementation: no fixed join string, of any length including
	 * the empty one, can map these two distinct jobs onto one key. If one could, two diagrams
	 * would share a cache entry and a user would be shown the wrong picture.
	 */
	it('cannot be made to collide by moving content across a field boundary', () => {
		for (const sep of [' ', '\n', '\r', '\t', '\0', '|', ':', '::', '']) {
			expect(
				deriveKey({ ...INPUTS, engineId: `a${sep}b`, normalizedSource: 'c' }),
				`separator ${JSON.stringify(sep)}`,
			).not.toBe(deriveKey({ ...INPUTS, engineId: 'a', normalizedSource: `b${sep}c` }));
		}

		// The length prefix is itself an encoding, so a field that looks like one must not be able
		// to forge a different split of the payload.
		expect(deriveKey({ ...INPUTS, engineId: '1:a', normalizedSource: 'b' })).not.toBe(
			deriveKey({ ...INPUTS, engineId: '', normalizedSource: '1:ab' }),
		);
		expect(deriveKey({ ...INPUTS, engineId: '', normalizedSource: '3:xyz' })).not.toBe(
			deriveKey({ ...INPUTS, engineId: '3:xyz', normalizedSource: '' }),
		);
	});

	/**
	 * `border` is `string | null` and `null` is the default that keeps the L3 import window open
	 * (§8.3), so the one value it must never be confused with is the four-character string a
	 * `%!tikz border=null` directive would parse to. `stableStringify` returning the bare word
	 * `null` for both would silently serve a bordered artifact under the unbordered key.
	 */
	it('distinguishes a null border from the string "null"', () => {
		expect(deriveKey(withBaked({ border: 'null' }))).not.toBe(deriveKey(INPUTS));
	});
});

// -------------------------------------------------------------------------------------------

/**
 * A local copy of old main.ts:117-134, so that `legacyKey`'s use of `legacyTidyTikzSource` is
 * checked against an independent transcription of the old behaviour rather than against the module
 * it is supposed to reproduce. MD5 correctness is established separately above, which is what lets
 * this assertion be about the tidy step and the dataset prefix alone.
 */
function oldTidyTikzSource(tikzSource: string): string {
	const remove = '&nbsp;';
	tikzSource = tikzSource.replaceAll(remove, '');
	let lines = tikzSource.split('\n');
	lines = lines.map((line) => line.trim());
	lines = lines.filter((line) => line);
	return lines.join('\n');
}

const SOURCE = [
	'\\begin{document}',
	'  \\begin{tikzpicture}',
	'',
	'    \\draw (0,0) -- (1,1);',
	'  \\end{tikzpicture}',
	'\\end{document}',
].join('\n');

describe('legacyKey', () => {
	/**
	 * Pinned to what the old bundle actually computed. If these values ever change, every record
	 * the previous plugin wrote becomes unreachable and every vault recompiles from scratch on
	 * upgrade — the incident the L3 read-through (§8.3) exists to prevent. There is no valid
	 * reason to update these literals; a failure here means something upstream of them broke.
	 */
	it('reproduces the md5hash the old bundle computed', () => {
		const vectors: Array<[string, string]> = [
			[SOURCE, '8f146f29411fa2047e3821e47fa6d8b5'],
			['', 'f6b23b9a49f368fb347513e0e311b147'],
			['\\draw (0,0) circle (1);', 'a99f8f5e7bc134d15ddd611d46a398f8'],
			['a&nbsp;b', '4fb330a4c2331aeb8205bfa9e74c2b19'],
			['\t\\node {x};\n\n\n\\node {y};\n', 'a28b5eda13cfae2c7bba20bc88012216'],
			['\\node {Ω⊗ é};', 'c1f2eae231b83faaa632efd64dfc3522'],
		];
		for (const [src, expected] of vectors) {
			expect(legacyKey(src), JSON.stringify(src)).toBe(expected);
		}
	});

	it('is md5(JSON.stringify(dataset) + tidied source)', () => {
		for (const src of [SOURCE, '', 'a&nbsp;b', '  \\node {x};  \n\n', '\\node {Ω⊗ é};']) {
			expect(legacyKey(src), JSON.stringify(src)).toBe(
				md5Hex(`{"showConsole":"true"}${oldTidyTikzSource(src)}`),
			);
		}
	});

	it('hashes the dataset prefix even when the source is empty', () => {
		expect(legacyKey('')).toBe(md5Hex('{"showConsole":"true"}'));
	});

	/**
	 * The legacy tidy's defects are load-bearing here: indentation and blank lines were destroyed
	 * before hashing, so a block that was only re-indented since it was last rendered still finds
	 * its legacy record. This is a large part of what makes the import window worth having.
	 */
	it('is blind to indentation and blank lines, as the old tidy was', () => {
		const reindented = [
			'      \\begin{document}',
			'\\begin{tikzpicture}',
			'',
			'',
			'\t\\draw (0,0) -- (1,1);   ',
			'\\end{tikzpicture}',
			'  \\end{document}',
			'',
		].join('\n');
		expect(legacyKey(reindented)).toBe(legacyKey(SOURCE));
	});

	/**
	 * The whole of DESIGN.md §2.2 #14: the old tidy deleted the six-character HTML entity
	 * `&nbsp;` and never the U+00A0 a paste actually contains. So a legacy record for a pasted
	 * diagram was keyed on a source that still holds the real character, and an "improved" tidy
	 * that strips U+00A0 — the obvious reading of that comment — would silently miss every one of
	 * them. The local transcription above cannot catch that drift: none of its sources contain the
	 * character. These vectors do.
	 *
	 * The leading case is the counterpart. `String.prototype.trim` *does* treat U+00A0 as
	 * whitespace, so a leading one was destroyed along with the indentation. Both halves are
	 * frozen behaviour, and both are load-bearing for the L3 hit rate.
	 */
	it('keeps an interior U+00A0 and eats a leading one, as the old tidy did', () => {
		expect(legacyKey('\\node {a\u00a0b};')).toBe('ed4678a8b62ad7bf1d8701bf17e8229e');
		// Not the same key as the plain space it looks like in an editor.
		expect(legacyKey('\\node {a\u00a0b};')).not.toBe(legacyKey('\\node {a b};'));
		// The entity, by contrast, was deleted outright — joining the tokens either side of it.
		expect(legacyKey('\\node {a&nbsp;b};')).toBe(legacyKey('\\node {ab};'));
		// Leading U+00A0 is whitespace to trim(), so it goes the way of the indentation.
		expect(legacyKey('\u00a0\\node {x};')).toBe(legacyKey('\\node {x};'));
	});

	it('is sensitive to the source itself', () => {
		expect(legacyKey(SOURCE.replace('(1,1)', '(1,2)'))).toBe(
			'd9c7537d290d0ac16b4e8d1135e75cd0',
		);
	});
});
