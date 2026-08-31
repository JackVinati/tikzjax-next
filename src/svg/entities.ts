/**
 * Stage 2b of the SVG pipeline: the soft-hyphen glyph remap. See docs/DESIGN.md §7.2.
 *
 * WHY THIS EXISTS, and why deleting it would look harmless. `\Omega` and `\otimes` rendered as
 * nothing (upstream #2). The fix was two-sided: the bundled fonts were patched with fontforge to
 * move the glyph TeX addresses at position 173 — the soft hyphen, U+00AD — to position 172, and
 * the plugin was given a matching `v.replaceAll("&#173;", "&#172;")` over every SVG before it was
 * parsed. Neither half works alone. The string half was never documented or commented, so it reads
 * like a stray line, and both halves are invisible to any test that only checks that a diagram
 * renders: a glyph the font does not have is drawn as nothing, not as an error.
 *
 * It is carried over here as a named stage with a golden fixture behind it, because the
 * alternative is that an engine rebuild which skips the fontforge step — or a tidy-up that deletes
 * a one-line `replaceAll` nobody could explain — silently regresses #2 for a whole release.
 *
 * The known cost, recorded rather than hidden: a diagram that legitimately contains a soft hyphen
 * in its text gets a NOT SIGN instead. That is upstream's behaviour and this preserves it
 * deliberately; the real fix is a font whose glyph positions match TeX's, which belongs to the
 * engine rebuild (docs/DECISIONS.md D8), not to a string pass over the output.
 */

/**
 * U+00AD SOFT HYPHEN — what the engine emits as `&#173;` for the affected glyph slot.
 * Written as a code point rather than a literal on purpose: the character itself is invisible in
 * every editor and diff, which is half of why the upstream one-liner looked like noise.
 */
export const SOFT_HYPHEN = String.fromCharCode(0xad);

/** U+00AC NOT SIGN — where fontforge moved the glyph in the patched fonts. */
export const NOT_SIGN = String.fromCharCode(0xac);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/**
 * Remap over a parsed document, which is where the pipeline runs it.
 *
 * Upstream did this on the raw string, before parsing, so it matched the literal seven characters
 * `&#173;`. After a parse there is no entity left to match — the parser has already decoded it to
 * a single character — so the DOM form is the faithful translation of the same rule, and it has
 * the side benefit of catching the character however the engine spelled it: `&#173;`, `&#xAD;`,
 * or the raw byte.
 *
 * Returns the number of characters remapped, so the pipeline can record that the stage did
 * something instead of the test asserting from the outside that it must have.
 */
export function remapSoftHyphens(doc: XMLDocument): number {
	const root = doc.documentElement as Element | undefined;
	if (!root) return 0;
	return remapNode(root);
}

function remapNode(el: Element): number {
	let count = 0;

	for (let i = 0; i < el.childNodes.length; i++) {
		const node = el.childNodes[i];
		if (!node) continue;

		if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
			const text = node.nodeValue ?? '';
			const hits = countOf(text, SOFT_HYPHEN);
			if (hits === 0) continue;
			node.nodeValue = replaceLiteral(text, SOFT_HYPHEN, NOT_SIGN);
			count += hits;
		} else if (node.nodeType === ELEMENT_NODE) {
			count += remapNode(node as Element);
		}
	}

	return count;
}

/** Local helper, never `String.prototype.replaceAll` — see the #48 note in svg/ids.ts. */
function replaceLiteral(haystack: string, needle: string, replacement: string): string {
	let from = 0;
	let at = haystack.indexOf(needle, from);
	if (at === -1) return haystack;

	const parts: string[] = [];
	while (at !== -1) {
		parts.push(haystack.slice(from, at), replacement);
		from = at + needle.length;
		at = haystack.indexOf(needle, from);
	}
	parts.push(haystack.slice(from));
	return parts.join('');
}

function countOf(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}
