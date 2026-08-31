/**
 * FROZEN. Never edit.
 *
 * This reproduces the cache key of the OLD vendored bundle (tikzjax.js @7030025) so that the L3
 * read-through in docs/DESIGN.md §8.3 can find records the previous plugin wrote. Its value is
 * that it is bit-identical to code we no longer run: the moment someone "improves" it — a better
 * hash, a tidier normalizer, a different dataset shape — every existing user's cache becomes
 * unreachable and their vault recompiles from scratch on upgrade. That is the incident §8.3
 * exists to prevent, so this file is closed to changes rather than merely discouraged from them.
 *
 * Verified against the bundle rather than remembered:
 *
 *   n(A) { A.md5hash = t()(JSON.stringify(A.dataset) + A.childNodes[0].nodeValue) }
 *
 * - `t` is module 568, the `md5` npm package: `charenc.utf8.stringToBytes` then `crypt.bytesToHex`,
 *   i.e. UTF-8 in, lowercase hex out.
 * - `A.dataset` holds exactly one key. The old main.ts set `data-show-console="true"` and nothing
 *   else, so `JSON.stringify` is deterministically `{"showConsole":"true"}` with no property-order
 *   hazard to worry about.
 * - `A.childNodes[0].nodeValue` is what `script.setText(this.tidyTikzSource(source))` put there,
 *   which is why `legacyTidyTikzSource` must stay byte-for-byte the old main.ts:117-134 and why
 *   D4 keeps it permanently rather than for one release.
 */

import { legacyTidyTikzSource } from '../source/legacy-tidy';

/** The old plugin set exactly one data attribute; this is `JSON.stringify(el.dataset)`. */
const LEGACY_DATASET = { showConsole: 'true' };

export function legacyKey(source: string): string {
	return md5Hex(JSON.stringify(LEGACY_DATASET) + legacyTidyTikzSource(source));
}

// -------------------------------------------------------------------------------------------
// MD5. Not a security primitive and not used as one — it is the key format of an archive we are
// reading. Synchronous for the same reason sha256.ts is (§6.1: the L1/L3 probe is sync).

/** Per-round left-rotation amounts. */
const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
	14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
	21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * `floor(abs(sin(i + 1)) * 2^32)`, written out.
 *
 * Computing these from `Math.sin` at load would be prettier and is a trap: ECMAScript does not
 * require `Math.sin` to be correctly rounded, so a one-ulp difference on some engine would produce
 * silently wrong hashes on that platform only. In a frozen file that is the last bug anyone wants.
 */
const T = new Uint32Array([
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

/** Lowercase hex MD5 of the UTF-8 encoding of `input`. */
export function md5Hex(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const bitLen = bytes.length * 8;

	const blocks = Math.ceil((bytes.length + 9) / 64);
	const buf = new Uint8Array(blocks * 64);
	buf.set(bytes);
	buf[bytes.length] = 0x80;
	// MD5 is little-endian throughout, including the trailing 64-bit length.
	const view = new DataView(buf.buffer);
	view.setUint32(buf.length - 8, bitLen >>> 0, true);
	view.setUint32(buf.length - 4, Math.floor(bitLen / 0x100000000), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const m = new Uint32Array(16);
	for (let off = 0; off < buf.length; off += 64) {
		for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);

		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;

		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}

			const tmp = d;
			d = c;
			c = b;
			b = (b + rotl((a + f + T[i]! + m[g]!) >>> 0, S[i]!)) >>> 0;
			a = tmp;
		}

		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}

	return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}

/** A digest word, emitted least-significant byte first, as MD5 defines its output. */
function hexLE(n: number): string {
	let out = '';
	for (let i = 0; i < 4; i++) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
	return out;
}
