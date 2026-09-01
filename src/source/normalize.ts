/**
 * Source normalization — the `corrected` half of the `Source handling` setting (internal/DESIGN.md §8.2).
 *
 * The job is to remove characters that a paste from a browser, a PDF or a chat client smuggles into
 * a ```tikz block and that TeX cannot read, while changing nothing a user could have meant. The old
 * `tidyTikzSource` (main.ts:117-134, kept verbatim in ./legacy-tidy.ts) got all three of those
 * wrong; each fix below is one of the defects in §2.2 #14.
 *
 * Pure: the output is a function of the input alone, and it feeds the cache key
 * (`KeyInputs.normalizedSource`), so any change here invalidates every artifact.
 */

/**
 * Space-*like* characters: the whole Unicode `Zs` (space separator) category except U+0020 itself.
 *
 * They are stripped by replacing them with U+0020, not by deleting them: they occupy the position
 * of a real space, so deleting one welds two tokens together — `\node at (0,0)` pasted with a
 * U+00A0 would become `\nodeat (0,0)`, an undefined control sequence. That token-welding is
 * precisely what the legacy `&nbsp;`-entity deletion does wrong.
 *
 * The category, not a hand-picked subset: U+00A0 (a browser paste of `&nbsp;`), U+2007 figure
 * space and U+202F narrow no-break space (numbers copied out of a PDF) are the famous ones, but
 * U+2002/U+2003 en/em space and U+2009 thin space come out of Word and PDF *more* often, and
 * U+3000 out of any CJK input method. Enumerating only the famous three left the rest to reach
 * TeX mid-line while `trimEnd()` below silently ate them at a line end — the same character
 * treated two different ways depending on where in the line it landed.
 *
 * Written as explicit `\uXXXX` ranges rather than `\p{Zs}`: esbuild targets es2016 here
 * (esbuild.config.mjs), and Unicode property escapes are not in that target.
 */
const SPACE_LIKE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Invisible formatting characters — the Unicode `Cf` category, of which U+200B zero-width space
 * and U+FEFF (BOM / zero-width no-break space) are only the two best known.
 *
 * These are deleted rather than replaced: they occupy no width, so a space would be the
 * corruption. U+FEFF is handled everywhere, not just at offset 0 — a block sliced out of a note
 * can carry one mid-source, and `String.prototype.trim()` (which legacy relied on) would only
 * ever have caught it at a line edge, while none of the others are whitespace at all and survive
 * `trim()` entirely.
 *
 * The rest of the category earns its place the same way U+FEFF does. U+2060 word joiner is the
 * *recommended replacement* for U+FEFF-as-ZWNBSP, so anything emitting modern text emits it where
 * older software emitted a BOM; U+00AD soft hyphen is what Word and many CMSs sprinkle through
 * copied prose; U+200C/U+200D and the bidi marks and isolates (U+200E-U+200F, U+202A-U+202E,
 * U+2066-U+2069) ride along with any paste that passed through a rich-text editor. Every one of
 * them is invisible in the note editor and every one of them is an invalid character to TeX, so
 * a diagram fails to compile with nothing on screen to explain why.
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Canonicalise a block's source for compilation and for hashing.
 *
 * Guarantees, in the order they matter:
 *  - **blank lines survive**. A blank line is a `\par`; deleting it silently reflows the document
 *    (§2.2 #14). Interior blank runs are reproduced exactly.
 *  - **leading whitespace survives**. Indentation is how TikZ source is read, and inside
 *    `verbatim`/`lstlisting` it is content.
 *  - line endings are LF, so a Windows note and a macOS note hash to the same key.
 */
export function normalizeSource(input: string): string {
	const text = input
		// Before the `&nbsp;` pass, not after: a zero-width character *inside* the entity (soft-wrap
		// markers land in the middle of long tokens when HTML is copied) would otherwise be removed
		// here and re-form an entity that this call has already walked past, so a second
		// `normalizeSource` of the same text would produce different bytes than the first.
		.replace(INVISIBLE, '')
		// Secondary case, kept for compatibility: notes edited under the old plugin may contain the
		// literal entity, which the legacy tidy deleted. Deleting it (rather than mapping it to a
		// space, as we do for the real character) keeps those notes rendering byte-identically.
		// split/join rather than `replaceAll`: Pretty BibTeX 2.0.0 monkey-patched
		// String.prototype.replaceAll and silently killed rendering with no error (upstream #48).
		// Single-pass, exactly as legacy's is: `&&nbsp;nbsp;` deliberately leaves one
		// entity behind rather than diverging from the frozen implementation on a pathological input.
		.split('&nbsp;')
		.join('')
		.replace(SPACE_LIKE, ' ')
		// CRLF and lone CR (old Mac line endings, and some clipboard sources) -> LF. U+2028 and
		// U+2029 are line and *paragraph* separators by definition and are what a Word or Google
		// Docs paste uses for a soft line break; mapping them to a space would weld two logical
		// lines (and hide anything after a `%` comment on the first), and leaving them alone was
		// not an option either — `trimEnd()` below counts them as line terminators, so they used
		// to vanish at a line end and survive mid-line.
		.replace(/\r\n?/g, '\n')
		.replace(/\u2028/g, '\n')
		.replace(/\u2029/g, '\n\n');

	// Trailing whitespace only. TeX itself discards spaces at the right end of every input line
	// (TeXbook, ch. 8), so this changes no output; it just stops an invisible edit from producing
	// a different cache key.
	const lines = text.split('\n').map((line) => line.trimEnd());

	// Blank lines at the very END of the source are dropped, and only there. Nothing follows them,
	// so they cannot express a paragraph break, and they are usually an artifact of how the fence
	// was sliced out of the note rather than something the user typed. Interior blank lines — the
	// ones that are `\par` — are never touched.
	// Indexed rather than `.at(-1)`: `Array.prototype.at` is Safari 15.4, and this runs on phones.
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

	return lines.join('\n');
}
