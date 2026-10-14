import { describe, expect, it } from 'vitest';
import { TS1_SYMBOLS } from '../engine-src/ts1-shim';
import { bridgeUnicode, restoreUnicode } from '../engine-src/unicode';

/** A marker as dvi2html draws it for one bridged character: the proxy M at `x`. */
const marker = (
	cp: number,
	x: number,
	rest = 'y="34" font-family="cmr10" font-size="10" fill="#c00"',
	quad = '10',
) => `<g data-tikzjax-unicode="${cp}" data-quad="${quad}pt"><text x="${x}" ${rest}>M</text></g>`;

/** Markers for `text`, one character to an em of `quad`, from `x` on. */
const word = (text: string, x: number, quad = 10, rest?: string) =>
	[...text].map((ch, i) => marker(ch.codePointAt(0) ?? 0, x + i * quad, rest, String(quad))).join('');

const codepoints = (text: string) => [...new Set([...text].map((ch) => ch.codePointAt(0) ?? 0))];

describe('8-bit TeX Unicode bridge', () => {
	describe('bridgeUnicode', () => {
		it('declares each character the engine cannot draw once, and leaves the source alone', () => {
			const result = bridgeUnicode('\\node {开始 and Ω 开};');

			expect(result.codepoints).toEqual([0x03a9, 0x59cb, 0x5f00]);
			expect(result.preamble).toContain('data-tikzjax-unicode');
			expect(result.preamble).toContain(
				'\\DeclareUnicodeCharacter{5F00}{\\tikzjaxUnicodeBridge{24320}}',
			);
			expect(result.preamble).toContain('\\DeclareUnicodeCharacter{03A9}{\\tikzjaxUnicodeBridge{937}}');
			expect(result.preamble.match(/\\DeclareUnicodeCharacter/g)).toHaveLength(3);
			expect(result.preamble).not.toContain('\n');
		});

		it('counts an astral codepoint as one character', () => {
			const result = bridgeUnicode('\\node {😀};');
			expect(result.codepoints).toEqual([0x1f600]);
			expect(result.preamble).toContain(
				'\\DeclareUnicodeCharacter{1F600}{\\tikzjaxUnicodeBridge{128512}}',
			);
		});

		it('does no work when every character renders natively', () => {
			const source = '\\node[draw]{Dvořák it’s 2010–2020 café Erdős İstanbul … ﬁ ﬂ};';
			expect(bridgeUnicode(source)).toEqual({ preamble: '', codepoints: [] });
		});

		it('leaves what the engine or the TS1 shim draws, and bridges the rest of Latin-1', () => {
			expect(bridgeUnicode('\\node {Müller 45° äöü × Łódź £5 ¥5 ‰};').codepoints).toEqual([
				0x00a5, 0x2030,
			]);
		});

		it('never bridges a character the TS1 shim draws', () => {
			for (const { codepoint } of TS1_SYMBOLS) {
				if (codepoint === undefined) continue;
				expect(
					bridgeUnicode(String.fromCodePoint(codepoint)).codepoints,
					codepoint.toString(16),
				).toEqual([]);
			}
		});

		it('declares a lone surrogate as the U+FFFD TeX reads in its place', () => {
			const lone = String.fromCharCode(0xd800);
			expect(bridgeUnicode(`a${lone}b`).codepoints).toEqual([0xfffd]);
			expect(new TextDecoder().decode(new TextEncoder().encode(lone)).codePointAt(0)).toBe(0xfffd);
		});

		// TeX reads a line into a buffer of fixed size: 6,000 declarations on one line overflowed it.
		it('breaks the declarations into lines of a hundred', () => {
			const many = Array.from({ length: 250 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
			const { preamble, codepoints } = bridgeUnicode(many);
			expect(codepoints).toHaveLength(250);
			const lines = preamble.split('\n');
			expect(lines).toHaveLength(3);
			expect(lines.map((line) => line.match(/\\DeclareUnicodeCharacter/g)?.length)).toEqual([
				100, 100, 50,
			]);
		});
	});

	describe('restoreUnicode', () => {
		it('puts characters set side by side back as one <text>, keeping the converter geometry and paint', () => {
			const svg = `<svg>${word('开始', 12)}</svg>`;
			expect(restoreUnicode(svg, codepoints('开始'))).toBe(
				'<svg><text x="22" y="34" font-family="sans-serif" font-size="10" fill="#c00" text-anchor="middle">开始</text></svg>',
			);
		});

		it('restores every occurrence when TeX sets the same text more than once', () => {
			const once = marker(0x03a9, 0, 'font-family="cmr10" font-size="10"');
			expect(restoreUnicode(`${once}<path d=""/>${once}`, [0x03a9])).toBe(
				'<text x="5" font-family="sans-serif" font-size="10" text-anchor="middle">Ω</text><path d=""/>' +
					'<text x="5" font-family="sans-serif" font-size="10" text-anchor="middle">Ω</text>',
			);
		});

		it.each(['Привет', 'Ωμέγα', 'ɪˈpɑ', '😀'])(
			'centres %s in the space TeX reserved, one quad per codepoint',
			(text) => {
				const svg = `<svg><g transform="rotate(30)">${word(text, -10, 12.5, 'y="20"')}</g></svg>`;
				const restored = restoreUnicode(svg, codepoints(text));
				expect(restored).toContain(`x="${-10 + ([...text].length * 12.5) / 2}"`);
				expect(restored).toContain(`>${text}</text>`);
				expect(restored.match(/<text/g)).toHaveLength(1);
				expect(restored).toContain('text-anchor="middle"');
				expect(restored).toContain('<g transform="rotate(30)">');
			},
		);

		// Word by word, Arabic and Hebrew came out in the wrong order: each word was a <text> of its
		// own, placed left to right as TeX set them. One <text> lets the browser order the words.
		it('joins runs across a space TeX set, so a right-to-left phrase keeps its order', () => {
			const svg = word('שלום', 0) + word('עולם', 43.33);
			const restored = restoreUnicode(svg, codepoints('שלוםעולם'));
			expect(restored.match(/<text/g)).toHaveLength(1);
			expect(restored).toContain('>שלום עולם</text>');
			expect(restored).toContain(`x="${(0 + 73.33 + 10) / 2}"`);
		});

		it('keeps runs apart across more than half a quad, another line, font or size, or anything drawn between', () => {
			const two = (svg: string) => restoreUnicode(svg, codepoints('开始')).match(/<text/g)?.length;
			expect(two(word('开', 0) + word('始', 20))).toBe(2);
			expect(two(word('开', 0) + word('始', 10, 10, 'y="46" font-family="cmr10" font-size="10"'))).toBe(
				2,
			);
			expect(two(word('开', 0) + word('始', 12, 12))).toBe(2);
			expect(two(`${word('开', 0)}<text x="10">x</text>${word('始', 20)}`)).toBe(3);
			expect(two(word('开', 10) + word('始', 0))).toBe(2);
		});

		it('replaces XML 1.0 forbidden scalars and keeps astral characters', () => {
			const svg = marker(0xfffe, 0) + marker(0xffff, 10) + marker(0x1f600, 20);
			expect(restoreUnicode(svg, [0xfffe, 0xffff, 0x1f600])).toContain(
				`>${String.fromCodePoint(0xfffd, 0xfffd, 0x1f600)}</text>`,
			);
		});

		// \nullfont draws no M, and outside a picture dvi2html writes HTML rather than a <text>; the
		// whole diagram used to be lost to "no recoverable text position".
		it('drops a marker that drew no glyph, rather than losing the diagram', () => {
			const empty = '<g data-tikzjax-unicode="24320" data-quad="0.0pt"></g>';
			const html = '<g data-tikzjax-unicode="24320" data-quad="10.00002pt"><span>M</span></g>';
			expect(restoreUnicode(`<svg>${empty}<path d=""/></svg>`, [0x5f00])).toBe(
				'<svg><path d=""/></svg>',
			);
			expect(restoreUnicode(`${html}<svg/>`, [0x5f00])).toBe('<svg/>');
		});

		it('leaves a marker alone that it did not declare', () => {
			const forged = marker(0x41, 0);
			expect(restoreUnicode(forged, [0x5f00])).toBe(forged);
		});

		it('fails on group markup that does not pair up, rather than return it', () => {
			expect(() => restoreUnicode(`<svg>${word('开始', 0)}<g></svg>`, codepoints('开始'))).toThrow(
				'<g>',
			);
			expect(restoreUnicode('<svg><g></svg>', [0x5f00])).toBe('<svg><g></svg>');
			expect(restoreUnicode('<svg><g></svg>', [])).toBe('<svg><g></svg>');
		});

		// \special{dvisvgm:raw <g/>} beside a bridged label: 0.2.0 drew it, and the count took the
		// <g/> for a group left open and lost the diagram.
		it('counts neither a <g/> nor a > inside an attribute as a group left open', () => {
			const svg = `<svg>${word('开始', 0)}<g/><g data-note="a>b"><path d=""/></g></svg>`;
			expect(restoreUnicode(svg, codepoints('开始'))).toBe(
				'<svg><text x="10" y="34" font-family="sans-serif" font-size="10" fill="#c00" text-anchor="middle">开始</text>' +
					'<g/><g data-note="a>b"><path d=""/></g></svg>',
			);
			expect(() => restoreUnicode(`<svg>${word('开', 0)}<g/><g></svg>`, codepoints('开'))).toThrow(
				'<g>',
			);
		});
	});
});
