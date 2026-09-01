import { describe, expect, it } from 'vitest';

import { legacyTidyTikzSource } from '../src/source/legacy-tidy';
import { normalizeSource } from '../src/source/normalize';

// Built with fromCodePoint rather than written literally: an invisible character in a test file is
// something a future editor, formatter or copy-paste silently mangles, and the test would then
// still pass while asserting nothing.
const NBSP = String.fromCodePoint(0x00a0); // what a browser paste of `&nbsp;` really contains
const FIGURE_SPACE = String.fromCodePoint(0x2007);
const NARROW_NBSP = String.fromCodePoint(0x202f); // common in numbers copied out of a PDF
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);

const lines = (...l: string[]): string => l.join('\n');

// -------------------------------------------------------------------------------------------
// A corpus of sources shaped like the ones people actually put in notes.

/** Flat, ASCII, no blank lines, no indentation: the one shape both implementations agree on. */
const FLAT = lines(
	String.raw`\begin{document}`,
	String.raw`\begin{tikzpicture}`,
	String.raw`\draw (0,0) -- (1,1);`,
	String.raw`\end{tikzpicture}`,
	String.raw`\end{document}`,
);

/** Indentation and a `\par` between two paragraphs of picture — everything legacy destroys. */
const INDENTED = lines(
	String.raw`\usetikzlibrary{arrows.meta}`,
	'',
	String.raw`\begin{document}`,
	'\t' + String.raw`\begin{tikzpicture}`,
	'\t\t' + String.raw`\draw[->] (0,0) -- (2,0);`,
	'',
	'\t\t' + String.raw`\node at (1,1) {hi};`,
	'\t' + String.raw`\end{tikzpicture}`,
	String.raw`\end{document}`,
);

/** Straight out of a browser: a BOM, no-break spaces, a zero-width space, trailing whitespace. */
const PASTED =
	BOM +
	lines(
		String.raw`\begin{document}` + '   ',
		String.raw`\node` + NBSP + 'at' + FIGURE_SPACE + String.raw`(0,0) {x};`,
		'',
		'\t' + String.raw`\dr` + ZWSP + String.raw`aw (0,0) -- (1,1);`,
		String.raw`\end{document}`,
		'',
	);

const CORPUS = { FLAT, INDENTED, PASTED };

// -------------------------------------------------------------------------------------------

describe('normalizeSource', () => {
	it('leaves an already-clean source byte-identical', () => {
		expect(normalizeSource(FLAT)).toBe(FLAT);
		expect(normalizeSource(INDENTED)).toBe(INDENTED);
	});

	it('normalises CRLF and a lone CR to LF', () => {
		expect(normalizeSource('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
		// A CR before a blank line must not eat the blank line.
		expect(normalizeSource('a\r\n\r\nb')).toBe('a\n\nb');
	});

	it('hashes the same whether the note was saved on Windows or not', () => {
		for (const [name, src] of Object.entries(CORPUS)) {
			expect(normalizeSource(src.replace(/\n/g, '\r\n')), name).toBe(normalizeSource(src));
		}
	});

	it('replaces no-break spaces with a real space instead of deleting them', () => {
		// Deleting would weld `\node` to `at` and produce an undefined control sequence — the exact
		// corruption the legacy `&nbsp;`-entity deletion causes.
		expect(normalizeSource(String.raw`\node` + NBSP + String.raw`at (0,0) {x};`)).toBe(
			String.raw`\node at (0,0) {x};`,
		);
		expect(normalizeSource('1' + FIGURE_SPACE + '000')).toBe('1 000');
		expect(normalizeSource('12' + NARROW_NBSP + 'cm')).toBe('12 cm');
	});

	it('deletes zero-width characters wherever they occur', () => {
		// Zero width: a space here would be the corruption, not the fix.
		expect(normalizeSource(String.raw`\dr` + ZWSP + 'aw')).toBe(String.raw`\draw`);
		expect(normalizeSource(BOM + String.raw`\draw` + BOM + ' a;')).toBe(String.raw`\draw a;`);
	});

	it('still removes the legacy &nbsp; entity, welding as the old plugin did', () => {
		// Deliberately NOT mapped to a space: notes written under the old plugin render with the
		// entity deleted, and changing that would change their output.
		const src = String.raw`\node` + '&nbsp;' + String.raw`at (0,0) {x};`;
		expect(normalizeSource(src)).toBe(String.raw`\nodeat (0,0) {x};`);
		expect(normalizeSource(src)).toBe(legacyTidyTikzSource(src));
	});

	it('preserves blank lines, including runs of them', () => {
		// Every blank line is a \par. Losing one silently reflows the document.
		expect(normalizeSource('a\n\nb')).toBe('a\n\nb');
		expect(normalizeSource('a\n\n\n\nb')).toBe('a\n\n\n\nb');
	});

	it('preserves leading whitespace and trims only trailing', () => {
		expect(normalizeSource('\t\tx  \n    y\t\n')).toBe('\t\tx\n    y');
	});

	it('turns a whitespace-only line into a blank line rather than deleting it', () => {
		expect(normalizeSource(lines('a', '   ', 'b'))).toBe('a\n\nb');
		expect(normalizeSource(lines('a', NBSP, 'b'))).toBe('a\n\nb');
		expect(normalizeSource(lines('a', ZWSP, 'b'))).toBe('a\n\nb');
	});

	it('drops blank lines at the very end, and only there', () => {
		expect(normalizeSource(lines('a', '', '', 'b', '', ''))).toBe('a\n\n\nb');
		expect(normalizeSource('a\nb\n\n')).toBe('a\nb');
		expect(normalizeSource('\n\na\nb')).toBe('\n\na\nb');
	});

	it('handles empty and blank-only input', () => {
		expect(normalizeSource('')).toBe('');
		expect(normalizeSource('\n\n\n')).toBe('');
		expect(normalizeSource('  \t ' + NBSP)).toBe('');
	});

	it('is idempotent over the corpus', () => {
		for (const [name, src] of Object.entries(CORPUS)) {
			const once = normalizeSource(src);
			expect(normalizeSource(once), name).toBe(once);
		}
	});

	it('cleans a real paste end to end', () => {
		expect(normalizeSource(PASTED)).toBe(
			lines(
				String.raw`\begin{document}`,
				String.raw`\node at (0,0) {x};`,
				'',
				'\t' + String.raw`\draw (0,0) -- (1,1);`,
				String.raw`\end{document}`,
			),
		);
	});
});

// -------------------------------------------------------------------------------------------

describe('legacyTidyTikzSource (frozen copy of main.ts:117-134)', () => {
	it('reproduces the old output on the corpus', () => {
		expect(legacyTidyTikzSource(FLAT)).toBe(FLAT);

		expect(legacyTidyTikzSource(INDENTED)).toBe(
			lines(
				String.raw`\usetikzlibrary{arrows.meta}`,
				String.raw`\begin{document}`,
				String.raw`\begin{tikzpicture}`,
				String.raw`\draw[->] (0,0) -- (2,0);`,
				String.raw`\node at (1,1) {hi};`,
				String.raw`\end{tikzpicture}`,
				String.raw`\end{document}`,
			),
		);

		expect(legacyTidyTikzSource(PASTED)).toBe(
			lines(
				String.raw`\begin{document}`,
				// Interior no-break spaces survive: this is defect #14, frozen on purpose.
				String.raw`\node` + NBSP + 'at' + FIGURE_SPACE + String.raw`(0,0) {x};`,
				String.raw`\dr` + ZWSP + String.raw`aw (0,0) -- (1,1);`,
				String.raw`\end{document}`,
			),
		);
	});

	it('deletes the &nbsp; entity, welding the tokens either side', () => {
		expect(legacyTidyTikzSource(String.raw`\node` + '&nbsp;' + 'at')).toBe(String.raw`\nodeat`);
	});

	it('trims a no-break space at a line edge, since String.trim() calls it whitespace', () => {
		const src = NBSP + String.raw`\draw a;` + NBSP;
		expect(legacyTidyTikzSource(src)).toBe(String.raw`\draw a;`);
		// ...but normalizeSource keeps the leading one as indentation, one space wide.
		expect(normalizeSource(src)).toBe(' ' + String.raw`\draw a;`);
	});

	it('keeps a zero-width-space-only line, because U+200B is not whitespace', () => {
		// `line.trim()` leaves it, so `filter(line => line)` sees a truthy string and keeps it —
		// the character then reaches TeX. Documented, not fixed: this file is frozen.
		expect(legacyTidyTikzSource(lines('a', ZWSP, 'b'))).toBe('a\n' + ZWSP + '\nb');
	});

	it('strips the CR of a CRLF as a side effect of trim()', () => {
		expect(legacyTidyTikzSource('a\r\nb\r\n')).toBe('a\nb');
	});

	it('is idempotent', () => {
		for (const [name, src] of Object.entries(CORPUS)) {
			const once = legacyTidyTikzSource(src);
			expect(legacyTidyTikzSource(once), name).toBe(once);
		}
	});
});

// -------------------------------------------------------------------------------------------

describe('corrected vs legacy', () => {
	it('agree on a flat ASCII source — the corrected path is not gratuitously different', () => {
		expect(normalizeSource(FLAT)).toBe(legacyTidyTikzSource(FLAT));
	});

	it('disagree exactly where the legacy tidy corrupts TeX', () => {
		// This divergence is the point of §8.2: the two keys must not collide, or an L3 import
		// would hand a legacy artifact to a source the new pipeline renders differently.
		for (const name of ['INDENTED', 'PASTED'] as const) {
			const src = CORPUS[name];
			expect(normalizeSource(src), name).not.toBe(legacyTidyTikzSource(src));
		}
	});

	it('legacy loses the \\par that corrected keeps', () => {
		const src = lines('para one', '', 'para two');
		expect(normalizeSource(src)).toBe(src);
		expect(legacyTidyTikzSource(src)).toBe('para one\npara two');
	});
});

// -------------------------------------------------------------------------------------------
// Regression: the invisible characters that are NOT the three famous ones.
//
// The first cut of this module enumerated U+00A0 / U+2007 / U+202F and U+200B / U+FEFF by hand.
// Everything below reached TeX untouched — as an invalid character, i.e. a diagram that fails to
// compile with nothing visible in the editor to explain it — and, worse, did so *inconsistently*:
// `trimEnd()` counts most of them as whitespace, so the same character vanished at the end of a
// line and survived in the middle of one.

const THIN_SPACE = String.fromCodePoint(0x2009); // Word, and numbers set in a PDF
const EN_SPACE = String.fromCodePoint(0x2002);
const EM_SPACE = String.fromCodePoint(0x2003);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000); // any CJK input method
const OGHAM_SPACE = String.fromCodePoint(0x1680); // the one Zs that is not blank, but still Zs
const WORD_JOINER = String.fromCodePoint(0x2060); // Unicode's replacement for U+FEFF-as-ZWNBSP
const ZWNJ = String.fromCodePoint(0x200c);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad); // Word and most CMS "smart" hyphenation
const RLM = String.fromCodePoint(0x200f); // bidi mark, rides along with any rich-text paste
const LRI = String.fromCodePoint(0x2066); // bidi isolate
const LINE_SEP = String.fromCodePoint(0x2028); // a Google Docs / Word soft line break
const PARA_SEP = String.fromCodePoint(0x2029);

describe('normalizeSource: invisible characters beyond the obvious ones', () => {
	it('maps every space separator to a real space, not just U+00A0/U+2007/U+202F', () => {
		for (const [name, ch] of Object.entries({
			NBSP,
			FIGURE_SPACE,
			NARROW_NBSP,
			THIN_SPACE,
			EN_SPACE,
			EM_SPACE,
			IDEOGRAPHIC_SPACE,
			OGHAM_SPACE,
		})) {
			expect(normalizeSource(String.raw`\node` + ch + String.raw`at (0,0) {x};`), name).toBe(
				String.raw`\node at (0,0) {x};`,
			);
		}
	});

	it('treats a space separator the same wherever it sits in the line', () => {
		// `trimEnd()` already deleted these at a line end. Handling them only there meant one
		// character with two behaviours, decided by column.
		for (const ch of [NBSP, THIN_SPACE, EM_SPACE, IDEOGRAPHIC_SPACE]) {
			expect(normalizeSource('a' + ch + '\nb')).toBe('a\nb');
			expect(normalizeSource('a' + ch + 'b')).toBe('a b');
		}
	});

	it('deletes the zero-width and bidi formatting characters, not only U+200B and the BOM', () => {
		for (const [name, ch] of Object.entries({ ZWSP, BOM, WORD_JOINER, ZWNJ, SOFT_HYPHEN, RLM, LRI })) {
			expect(normalizeSource(String.raw`\dr` + ch + String.raw`aw (0,0);`), name).toBe(
				String.raw`\draw (0,0);`,
			);
		}
	});

	it('leaves nothing outside printable ASCII, tab and newline behind', () => {
		// The property the module actually promises, stated as a property rather than as a list:
		// after normalization no character that TeX cannot read survives, wherever it was placed.
		const hostile = [
			NBSP,
			FIGURE_SPACE,
			NARROW_NBSP,
			THIN_SPACE,
			EN_SPACE,
			EM_SPACE,
			IDEOGRAPHIC_SPACE,
			OGHAM_SPACE,
			ZWSP,
			BOM,
			WORD_JOINER,
			ZWNJ,
			SOFT_HYPHEN,
			RLM,
			LRI,
			LINE_SEP,
			PARA_SEP,
		];
		for (const ch of hostile) {
			for (const src of [ch + 'a', 'a' + ch + 'b', 'a' + ch, 'a' + ch + '\nb', 'a\n' + ch + '\nb']) {
				expect(normalizeSource(src), JSON.stringify(src)).toMatch(/^[\x20-\x7E\t\n]*$/);
			}
		}
	});

	it('treats U+2028 as a line break and U+2029 as a paragraph break', () => {
		// Both are line separators by definition, and TeX reads a line break as a space — mapping
		// them to a space instead would swallow the rest of a `%` comment line into the next line.
		expect(normalizeSource(String.raw`% a note` + LINE_SEP + String.raw`\draw (0,0);`)).toBe(
			'% a note\n' + String.raw`\draw (0,0);`,
		);
		// A paragraph separator is a \par, which is the whole subject of §2.2 #14.
		expect(normalizeSource('para one' + PARA_SEP + 'para two')).toBe('para one\n\npara two');
		// ...and at the end of the source it is trailing blank lines, so it disappears with them.
		expect(normalizeSource('a' + PARA_SEP)).toBe('a');
	});

	it('is idempotent on sources built to break it', () => {
		const adversarial = [
			// A zero-width character inside the entity: removing it re-forms `&nbsp;`, which a
			// second pass would then delete. Stripping the invisibles first closes that.
			String.raw`\node` + '&nb' + ZWSP + 'sp;' + String.raw`at`,
			BOM + '\t a ' + NBSP + THIN_SPACE + '\r\n\r\n' + SOFT_HYPHEN + 'b' + LINE_SEP + 'c\n\n',
			'a' + PARA_SEP + PARA_SEP + 'b',
			WORD_JOINER + '\n' + IDEOGRAPHIC_SPACE + '\n' + WORD_JOINER,
		];
		for (const src of adversarial) {
			const once = normalizeSource(src);
			expect(normalizeSource(once), JSON.stringify(src)).toBe(once);
		}
	});
});
