/// <reference types="vite/client" />
import { Buffer } from 'buffer/';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { dvi2htmlPatch, patchDvi2html } from '../scripts/dvi2html-patch.mjs';

/*
 * dvi2html loses a diagram over a character it could draw, in two ways, and the build patches both
 * (scripts/dvi2html-patch.mjs). Its TFM reader stops one character short of the end of every font,
 * so the last character of each — the dieresis accent in cmr10, \spadesuit in cmsy10, \backepsilon
 * in msbm10 — has no metrics: "Could not find font metric for 127". And its glyph table has no entry
 * for some characters it does have metrics for — the stroke of Ł and ł, the £ of the italic fonts —
 * so it fails reading the codepoint: "Cannot read properties of undefined (reading 'toString')".
 * These run dvi2html exactly as the worker bundles it, patched and not, on DVI files written here
 * byte by byte — no TeX engine needed to show what the converter does with one character.
 */

type Dvi2html = (input: AsyncGenerator<Buffer>, output: unknown) => Promise<unknown>;
type TfmData = (font: string) => Uint8Array;

/** `@drgrice1/dvi2html` bundled for the browser as the worker bundles it, evaluated in this realm. */
async function loadDvi2html(patched: boolean): Promise<{ dvi2html: Dvi2html; tfmData: TfmData }> {
	const result = await build({
		stdin: {
			contents: "export { dvi2html, tfmData } from '@drgrice1/dvi2html';",
			resolveDir: '.',
			loader: 'js',
		},
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'DVI2HTML',
		platform: 'browser',
		logLevel: 'silent',
		plugins: patched ? [dvi2htmlPatch()] : [],
	});
	const text = result.outputFiles[0]?.text ?? '';
	return new Function(`${text}\nreturn DVI2HTML;`)() as { dvi2html: Dvi2html; tfmData: TfmData };
}

/**
 * A one-page DVI that sets the characters `codes` of `font` at 10pt, one after another, and nothing
 * else.
 *
 * pre, then a page (bop, fnt_def1 for font 0, fnt_num_0, a set_char_<code> for each, eop), then the
 * postamble repeating the font definition, and post_post with its 223 padding. The numbers are TeX's
 * own: DVI units of 10^-7 m, magnification 1000, the font scaled to its 10pt design size.
 */
function dviSetting(font: string, codes: number | readonly number[]): Uint8Array {
	const bytes: number[] = [];
	const u8 = (n: number) => bytes.push(n & 0xff);
	const u16 = (n: number) => [8, 0].forEach((shift) => u8(n >>> shift));
	const u32 = (n: number) => [24, 16, 8, 0].forEach((shift) => u8(n >>> shift));
	const fontDef = () => {
		u8(243); // fnt_def1
		u8(0); // font number
		u32(0); // checksum: 0 means "do not check"
		u32(10 * 65536); // scaled size, 10pt
		u32(10 * 65536); // design size, 10pt
		u8(0);
		u8(font.length);
		for (const ch of font) u8(ch.charCodeAt(0));
	};
	const preamble = () => [25400000, 473628672, 1000].forEach(u32);

	u8(247); // pre
	u8(2);
	preamble();
	u8(0); // no comment
	const bop = bytes.length;
	u8(139); // bop
	for (let i = 0; i < 10; i++) u32(0);
	u32(0xffffffff); // no previous page
	fontDef();
	u8(171); // fnt_num_0
	// set_char_<code>: opcodes 0-127 set that character. Every font here ends at 127.
	for (const code of typeof codes === 'number' ? [codes] : codes) u8(code);
	u8(140); // eop
	const post = bytes.length;
	u8(248); // post
	u32(bop);
	preamble();
	u32(0); // tallest page
	u32(0); // widest page
	u16(1); // stack depth
	u16(1); // pages
	fontDef();
	u8(249); // post_post
	u32(post);
	u8(2);
	for (let i = 0; i < 4; i++) u8(223);
	return new Uint8Array(bytes);
}

async function draw(dvi2html: Dvi2html, dvi: Uint8Array): Promise<string> {
	let out = '';
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
	// eslint-disable-next-line @typescript-eslint/require-await -- dvi2html wants an async iterable.
	async function* stream() {
		yield Buffer.from(dvi);
	}
	await dvi2html(stream(), sink);
	return out;
}

const { dvi2html: patched, tfmData } = await loadDvi2html(true);
const { dvi2html: shipped } = await loadDvi2html(false);

/** The codepoints dvi2html wrote into the SVG, in order. */
const codepoints = (html: string): number[] =>
	[...html.matchAll(/&#x([0-9a-f]+);/g)].map((m) => parseInt(m[1] ?? '', 16));

/** Character 127 is the last of all three fonts: bc 0, ec 127. U+F0C4 is where dvi2html maps it. */
const LAST = [
	['cmr10', 'the dieresis accent of ä, ö, ü and \\"u'],
	['cmsy10', '\\spadesuit'],
	['msbm10', '\\backepsilon'],
] as const;

/** The glyph lookup in HTMLMachine's putText, as the minified bundle spells it, and as patched. */
const GLYPH = 'fA[this.font.name][w.toString()].toString(16)';
const GLYPH_FIXED =
	'(fA[this.font.name][w.toString()]??(w<10?0xf0a1+w:w<33?0xf0a3+w:w<127?0xf000+w:0xf0c4)).toString(16)';

describe('the dvi2html TFM patch', () => {
	it.each(LAST)('draws the last character of %s, %s', async (font) => {
		const html = await draw(patched, dviSetting(font, 127));
		expect(html).toContain(`font-family: ${font}`);
		expect(html).toContain('&#xf0c4;');
	});

	it.each(LAST)('is what makes the difference: unpatched, %s 127 loses the diagram', async (font) => {
		await expect(draw(shipped, dviSetting(font, 127))).rejects.toThrow(
			'Could not find font metric for 127',
		);
	});

	it('changes nothing about a character that always worked', async () => {
		const dvi = dviSetting('cmr10', 65);
		expect(await draw(patched, dvi)).toBe(await draw(shipped, dvi));
	});

	it('refuses a dvi2html it does not recognise, rather than shipping it unpatched', () => {
		const loop = 'for(let A=this.smallest_character_code;A<this.largest_character_code;++A)';
		expect(patchDvi2html(`x;${loop}y;${GLYPH}`)).toBe(
			`x;${loop.split('A<this').join('A<=this')}y;${GLYPH_FIXED}`,
		);
		expect(() => patchDvi2html(GLYPH)).toThrow('expected exactly one TFM read_characters loop');
		expect(() => patchDvi2html(`${loop};${loop};${GLYPH}`)).toThrow('expected exactly one');
	});

	it('fails a build that bundles dvi2html without passing through it', async () => {
		await expect(
			build({
				stdin: { contents: 'export const nothing = 0;', resolveDir: '.', loader: 'js' },
				bundle: true,
				write: false,
				logLevel: 'silent',
				plugins: [dvi2htmlPatch()],
			}),
		).rejects.toThrow('applied 0 times');
	});
});

/**
 * The characters of a font that have metrics: those whose char_info has a non-zero width index.
 * Read from the TFM dvi2html carries, which is the one it measures with.
 */
function charactersOf(tfm: Uint8Array): number[] {
	const u16 = (at: number) => ((tfm[at] ?? 0) << 8) | (tfm[at + 1] ?? 0);
	const [lh, bc, ec] = [u16(2), u16(4), u16(6)];
	const out: number[] = [];
	for (let c = bc; c <= ec; c++) if (tfm[24 + 4 * lh + 4 * (c - bc)] !== 0) out.push(c);
	return out;
}

/**
 * Every font dvi2html has metrics for, out of the faces the engine ships. Vite's glob, not node:fs,
 * as in shipped-faces.test.ts: only the file names are used.
 */
const KNOWN = Object.keys(import.meta.glob('../engine-build/out/dist/fonts/*.woff2'))
	.map((path) => path.slice(path.lastIndexOf('/') + 1, -'.woff2'.length))
	.filter((font) => {
		try {
			tfmData(font);
			return true;
		} catch {
			return false;
		}
	});

describe('the dvi2html glyph patch', () => {
	// LaTeX's \l is character 32 of the text font, a stroke, set over an l, and \L builds Ł with it
	// too. In the italic text fonts character 36 is £ where the upright ones have $.
	it.each([
		['cmr10', 32, 'the stroke of Ł and ł', 0xf0c3],
		['cmbx10', 32, 'the stroke of a bold Ł', 0xf0c3],
		['cmti10', 36, 'the £ of the italic', 0xf024],
		['cmu10', 36, 'the £ of the upright italic', 0xf024],
	])('draws %s %i, %s, where the face has it', async (font, code, _, codepoint) => {
		const html = await draw(patched, dviSetting(font, code));
		expect(html).toContain(`font-family: ${font}`);
		expect(codepoints(html)).toEqual([codepoint]);
	});

	it.each([
		['cmr10', 32],
		['cmti10', 36],
	])('is what makes the difference: unpatched, %s %i loses the diagram', async (font, code) => {
		await expect(draw(shipped, dviSetting(font, code))).rejects.toThrow(
			"Cannot read properties of undefined (reading 'toString')",
		);
	});

	it('has the fonts to test against', () => {
		expect(KNOWN.length).toBeGreaterThan(100);
		expect(KNOWN).toContain('cmr10');
		expect(KNOWN).toContain('lasy10');
		// A face that ships with no metrics in dvi2html: \mathfrak's limit, not this patch's.
		expect(KNOWN).not.toContain('eufm10');
	});

	it.each(KNOWN)('draws every character %s has metrics for', async (font) => {
		const characters = charactersOf(tfmData(font));
		const html = await draw(patched, dviSetting(font, characters));
		expect(codepoints(html)).toHaveLength(characters.length);
	});

	it('changes nothing about the characters the table has', async () => {
		// Every character of cmr10 the unpatched converter can draw: all but the stroke, and the
		// dieresis that the TFM patch is for.
		const characters = charactersOf(tfmData('cmr10')).filter((code) => code !== 32 && code !== 127);
		const dvi = dviSetting('cmr10', characters);
		expect(await draw(patched, dvi)).toBe(await draw(shipped, dvi));
	});

	it('refuses a dvi2html whose glyph lookup it does not recognise', () => {
		const loop = 'for(let A=this.smallest_character_code;A<this.largest_character_code;++A)';
		expect(() => patchDvi2html(loop)).toThrow('expected exactly one glyph lookup');
		expect(() => patchDvi2html(`${loop};${GLYPH};${GLYPH}`)).toThrow('expected exactly one glyph lookup');
	});
});
