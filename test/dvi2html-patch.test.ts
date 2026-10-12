import { Buffer } from 'buffer/';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { dvi2htmlPatch, patchDvi2html } from '../scripts/dvi2html-patch.mjs';

/*
 * dvi2html's TFM reader stops one character short of the end of every font, so the last character
 * of each — the dieresis accent in cmr10, \spadesuit in cmsy10, \backepsilon in msbm10 — has no
 * metrics, and a diagram that sets one is lost with "Could not find font metric for 127". The build
 * patches the loop (scripts/dvi2html-patch.mjs). These run dvi2html exactly as the worker bundles
 * it, patched and not, on DVI files written here byte by byte — no TeX engine needed to show what
 * the converter does with one character.
 */

type Dvi2html = (input: AsyncGenerator<Buffer>, output: unknown) => Promise<unknown>;

/** `@drgrice1/dvi2html` bundled for the browser as the worker bundles it, evaluated in this realm. */
async function loadDvi2html(patched: boolean): Promise<Dvi2html> {
	const result = await build({
		stdin: { contents: "export { dvi2html } from '@drgrice1/dvi2html';", resolveDir: '.', loader: 'js' },
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'DVI2HTML',
		platform: 'browser',
		logLevel: 'silent',
		plugins: patched ? [dvi2htmlPatch()] : [],
	});
	const text = result.outputFiles[0]?.text ?? '';
	return (new Function(`${text}\nreturn DVI2HTML;`)() as { dvi2html: Dvi2html }).dvi2html;
}

/**
 * A one-page DVI that sets character `code` of `font` at 10pt, and nothing else.
 *
 * pre, then a page (bop, fnt_def1 for font 0, fnt_num_0, set_char_<code>, eop), then the postamble
 * repeating the font definition, and post_post with its 223 padding. The numbers are TeX's own:
 * DVI units of 10^-7 m, magnification 1000, the font scaled to its 10pt design size.
 */
function dviSetting(font: string, code: number): Uint8Array {
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
	u8(code); // set_char_<code>: opcodes 0-127 set that character
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

const patched = await loadDvi2html(true);
const shipped = await loadDvi2html(false);

/** Character 127 is the last of all three fonts: bc 0, ec 127. U+F0C4 is where dvi2html maps it. */
const LAST = [
	['cmr10', 'the dieresis accent of ä, ö, ü and \\"u'],
	['cmsy10', '\\spadesuit'],
	['msbm10', '\\backepsilon'],
] as const;

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
		expect(patchDvi2html(`x;${loop}y`)).toBe(`x;${loop.split('A<this').join('A<=this')}y`);
		expect(() => patchDvi2html('')).toThrow('expected exactly one');
		expect(() => patchDvi2html(`${loop};${loop}`)).toThrow('expected exactly one');
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
