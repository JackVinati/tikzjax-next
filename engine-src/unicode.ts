/*
 * Literal-Unicode bridge for the 8-bit TeX engine.
 *
 * TeX still owns layout: every character the engine cannot typeset is set as a one-em box while the
 * DVI is built. dvi2html preserves the raw-SVG marker around each box and supplies its baseline
 * coordinates. Once conversion is complete we replace the proxy glyphs with the original text.
 * This keeps CJK text in ordinary TikZ nodes without pretending that the engine itself has become
 * Unicode-aware.
 *
 * The characters are handed to LaTeX's own UTF-8 input, with \DeclareUnicodeCharacter, rather than
 * replaced in the source. LaTeX makes each character a macro, and on this engine, which has
 * \ifincsname since 0.2.0, that macro gives the character's own bytes wherever LaTeX makes a name
 * of it and typesets it everywhere else. A declaration changes only what it typesets. So a node or
 * coordinate named (开始), a \label{开始} and its \ref, a style or a colour named 开始, \def\开始 and
 * \detokenize{开始} come out exactly as they do without the bridge, and in text, where TeX left the
 * character out with "not set up for use with LaTeX", it sets the box. Replacing the characters in
 * the block's source put a box wherever LaTeX makes a name, and each of those failed with "Missing
 * \endcsname inserted". A character in a preamble file is declared as well.
 */

import { bridgedCodepoint } from './bridged';

export interface UnicodeBridge {
	/** For the head of the input, ahead of everything the block and its preambles load. */
	preamble: string;
	/** The characters declared, ascending: the only ones restoreUnicode puts back. */
	codepoints: readonly number[];
}

/**
 * What a declared character typesets: a one-em box between two raw-SVG markers that carry its
 * codepoint and the current font's quad. \protected, as the character's own macro is, so that
 * nothing expanding text ahead of time can take it apart.
 *
 * \leavevmode starts a paragraph where a letter would. Without it, text at the start of a \parbox,
 * a minipage or a `p` column was set in vertical mode, where each box went on a line of its own: a
 * word in Cyrillic came out one letter under the other.
 *
 * \tikzjaxUnicodeBreak and \tikzjaxUnicodeOpening are the same box with a place to break a line in
 * front of it, below.
 */
const BRIDGE =
	String.raw`\protected\def\tikzjaxUnicodeBridge#1{\leavevmode\special{dvisvgm:raw <g data-tikzjax-unicode="#1" data-quad="\the\fontdimen6\font">}\hbox to1em{M\hss}\special{dvisvgm:raw </g>}}` +
	String.raw`\protected\def\tikzjaxUnicodeBreak#1{\ifhmode\hskip0pt\relax\fi\tikzjaxUnicodeBridge{#1}}` +
	String.raw`\protected\def\tikzjaxUnicodeOpening#1{\tikzjaxUnicodeBreak{#1}\ifhmode\nobreak\fi}`;

/**
 * Where a line may break in text written without spaces between its words.
 *
 * TeX breaks a line only at glue or a penalty, and there is none between two boxes, so a line of
 * Chinese or Japanese in a `text width` node never broke: it ran on past the node's border and out
 * of the picture. Each character listed here may begin a line, so in horizontal mode it is preceded
 * by a glue of no width. That adds nothing to a line's width, and nothing to the DVI, so a node
 * without `text width`, where the text is one \hbox, is drawn as before; in maths, where a glue is
 * no place to break, it is not added. An opening bracket may begin a line but not end one, so it is
 * followed by \nobreak: a glue after a penalty is not a place to break either. Closing punctuation,
 * small kana, the iteration marks and the prolonged sound mark are not listed, so no line begins
 * with one. Korean, which is written with spaces, and every other script break where a space is
 * typed, as they did.
 */
const BREAK_BEFORE: readonly (readonly [number, number])[] = [
	[0x2e80, 0x2fdf], // CJK and Kangxi radicals
	[0x3041, 0x3096], // hiragana
	[0x30a1, 0x30fa], // katakana
	[0x3105, 0x312f], // bopomofo
	[0x3400, 0x4dbf], // CJK unified ideographs, extension A
	[0x4e00, 0x9fff], // CJK unified ideographs
	[0xf900, 0xfaff], // CJK compatibility ideographs
	[0xff10, 0xff19], // fullwidth digits
	[0xff21, 0xff3a], // fullwidth capitals
	[0xff41, 0xff5a], // fullwidth small letters
	[0x20000, 0x3fffd], // CJK unified ideographs, extensions B onward
];
const NON_STARTERS = new Set(
	[...'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ'].map((ch) => ch.codePointAt(0)),
);
const OPENING = new Set([...'〈《「『【〔〖〘〚〝（［｛｟｢'].map((ch) => ch.codePointAt(0)));

const bridgeMacro = (cp: number): string => {
	if (OPENING.has(cp)) return 'tikzjaxUnicodeOpening';
	if (NON_STARTERS.has(cp)) return 'tikzjaxUnicodeBridge';
	return BREAK_BEFORE.some(([first, last]) => cp >= first && cp <= last)
		? 'tikzjaxUnicodeBreak'
		: 'tikzjaxUnicodeBridge';
};

const DECLARATIONS_PER_LINE = 100;

const declare = (cp: number): string =>
	String.raw`\DeclareUnicodeCharacter{` +
	cp.toString(16).toUpperCase().padStart(4, '0') +
	'}{\\' +
	bridgeMacro(cp) +
	'{' +
	String(cp) +
	'}}';

/**
 * Declare every character in `text` that the engine cannot draw itself (./bridged). Nothing, if there
 * is none.
 */
export function bridgeUnicode(text: string): UnicodeBridge {
	const found = new Set<number>();
	for (const ch of text) {
		const cp = bridgedCodepoint(ch);
		if (cp !== undefined) found.add(cp);
	}
	if (found.size === 0) return { preamble: '', codepoints: [] };

	const codepoints = [...found].sort((a, b) => a - b);
	// A line break every hundred declarations, about 6 KB: TeX reads its input a line at a time into
	// a buffer of fixed size, which a line of 250 KB fits and one of 300 KB overflows, and 6,000
	// characters declared on one line came to 348 KB and stopped the run. The preamble's own first
	// line still shares a line with the last of them, so its lines keep their place above the block.
	const lines: string[] = [];
	for (let i = 0; i < codepoints.length; i += DECLARATIONS_PER_LINE) {
		lines.push(
			codepoints
				.slice(i, i + DECLARATIONS_PER_LINE)
				.map(declare)
				.join(''),
		);
	}
	return { preamble: BRIDGE + lines.join('\n'), codepoints };
}

const MARKER = /<g data-tikzjax-unicode="([0-9]+)" data-quad="([0-9]+(?:\.[0-9]+)?)pt">([\s\S]*?)<\/g>/g;

/** A <g> tag, whose attribute values may hold a `>`. */
const GROUP_TAG = /<g\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/** One bridged character as dvi2html drew it: its marker, and the M TeX set in the box. */
interface BridgedGlyph {
	start: number;
	end: number;
	text: string;
	quad: number;
	/** The M's <text> tag, and its x; absent where no glyph was drawn. */
	opening?: string | undefined;
	x: number;
	/** The tag without its x: glyphs that share it share a baseline, a font and a paint. */
	style: string;
}

/**
 * Restore bridge markers in raw dvi2html output while retaining TikZ's position, size and fill.
 *
 * Each character is a marker of its own, and the characters TeX set side by side are put back as
 * one <text>: a word in its own script's spacing and shaping, right to left where it is written so,
 * centred in the space TeX reserved for it. Two such runs separated by nothing but a space TeX set
 * become one, with the space, so that a phrase in Arabic or Hebrew keeps its word order. The marker
 * itself goes: it lives only between dvi2html and here, and the sanitizer's allowlist has no data-*
 * attributes, so it would report every bridged character as removed active content.
 */
export function restoreUnicode(svg: string, codepoints: readonly number[]): string {
	if (codepoints.length === 0) return svg;
	const declared = new Set(codepoints);

	const glyphs: BridgedGlyph[] = [];
	for (const m of svg.matchAll(MARKER)) {
		const cp = Number(m[1]);
		if (!declared.has(cp)) continue;
		const opening = /<text\b[^>]*>/.exec(m[3] ?? '')?.[0];
		const x = Number(opening === undefined ? NaN : /\sx="([^"]+)"/.exec(opening)?.[1]);
		const start = m.index;
		glyphs.push({
			start,
			end: start + m[0].length,
			text: String.fromCodePoint(cp),
			quad: Number(m[2]),
			opening: Number.isFinite(x) ? opening : undefined,
			x,
			style: opening?.replace(/\sx="[^"]*"/, '') ?? '',
		});
	}
	if (glyphs.length === 0) return svg;
	// Each marker ends at the first </g> after it, which is its own only while the groups pair up. A
	// <g/> opens and closes nothing, so it is not counted: a raw special may write one, and the
	// diagram drew before the bridge.
	const opened = (svg.match(GROUP_TAG) ?? []).filter((tag) => !tag.endsWith('/>')).length;
	if (opened !== (svg.match(/<\/g\s*>/g) ?? []).length) {
		throw new Error(
			"The diagram's SVG has a <g> without its </g>, or a </g> without its <g>, so the Unicode text in it cannot be put back. A \\special{dvisvgm:raw …} in the diagram can cause this.",
		);
	}

	let out = '';
	let from = 0;
	let i = 0;
	while (i < glyphs.length) {
		const first = glyphs[i] as BridgedGlyph;
		out += svg.slice(from, first.start);
		let last = first;
		let text = first.text;
		i++;
		// A marker that drew no glyph (TeX set it in \nullfont, or outside a picture, where dvi2html
		// writes HTML) has no place to put text: it is dropped, as TeX dropped a character it had no
		// font for, rather than losing the diagram.
		if (first.opening !== undefined) {
			for (; i < glyphs.length; i++) {
				const next = glyphs[i] as BridgedGlyph;
				if (next.start !== last.end || next.opening === undefined || next.style !== first.style)
					break;
				if (next.quad !== first.quad) break;
				const gap = next.x - (last.x + last.quad);
				const slack = first.quad / 100;
				if (gap < -slack || gap > first.quad / 2) break;
				text += gap > slack ? ` ${next.text}` : next.text;
				last = next;
			}
			const middle = (first.x + last.x + last.quad) / 2;
			const centred = first.opening
				.replace(/\sx="[^"]*"/, ` x="${middle}"`)
				.replace(/>$/, ' text-anchor="middle">');
			// The Computer Modern webfont contains no CJK glyphs. Asking for the platform sans family
			// explicitly gives every supported OS a predictable font-fallback path.
			const family = /\sfont-family="[^"]*"/.test(centred)
				? centred.replace(/\sfont-family="[^"]*"/, ' font-family="sans-serif"')
				: centred.replace(/>$/, ' font-family="sans-serif">');
			out += `${family}${escapeXml(text)}</text>`;
		}
		from = last.end;
	}
	return out + svg.slice(from);
}

function escapeXml(text: string): string {
	// Iterate Unicode scalars: valid surrogate pairs survive; lone halves and XML 1.0's forbidden
	// characters become U+FFFD even in DOM implementations that accept malformed XML.
	return text
		.replace(/[\s\S]/gu, (ch) => {
			const cp = ch.codePointAt(0) ?? 0;
			return cp === 0x09 ||
				cp === 0x0a ||
				cp === 0x0d ||
				(cp >= 0x20 && cp <= 0xd7ff) ||
				(cp >= 0xe000 && cp <= 0xfffd) ||
				cp >= 0x10000
				? ch
				: '\uFFFD';
		})
		.split('&')
		.join('&amp;')
		.split('<')
		.join('&lt;')
		.split('>')
		.join('&gt;');
}
