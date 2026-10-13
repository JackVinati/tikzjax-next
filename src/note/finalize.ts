/**
 * Finalize: commit a rendered diagram into the note as a real attachment, and undo it.
 *
 * See internal/DESIGN.md §7.9. This is the answer to upstream #95 and #33 ("get the SVG out"), and it
 * is the ONLY possible answer to #37/#47: Obsidian Publish runs zero community plugins, so a
 * committed `.svg` attachment is the only thing a visitor can ever see. It is also the mitigation
 * for the cache being deliberately device-local (§8) — an attachment syncs, an IndexedDB record
 * does not.
 *
 * This module is a PURE TEXT TRANSFORMATION over the note's markdown. No vault, no DOM, no
 * `obsidian` import, no clock. The caller owns the I/O: it renders the SVG, writes the attachment
 * with `fileManager.getAvailablePathForAttachment` + `vault.createBinary`, and applies the string
 * this module returns through `vault.process`. Keeping the rewrite pure is what lets the scanner —
 * which is where all the real difficulty lives — be exercised against a corpus in Node.
 *
 * The finalized form is
 *
 *     ![[diagram.svg]]
 *     %%
 *     ```tikz
 *     …the original block, byte for byte…
 *     ```
 *     %%
 *
 * The original fence is preserved VERBATIM inside an Obsidian `%%` comment. Three consequences,
 * all deliberate: the source is never lost, so finalize is not a one-way door; un-finalize is an
 * exact inverse rather than a re-serialization that could drift; and a reader of the raw markdown
 * (git, another editor, Publish's source view) still has the TeX.
 *
 * OPEN QUESTION, to settle in the app rather than by argument. A fenced code block interrupts a
 * paragraph; an embed and a `%%` line do not, at least in CommonMark. So a fence written directly
 * under a line of text may, after finalizing, leave the embed absorbed into that paragraph and the
 * `%%` failing to open a block comment — which would show the TeX source as visible text.
 *
 * No blank line is inserted to pre-empt that, for two reasons. Obsidian's `%%` is not CommonMark and
 * is likely handled per-line, so the premise may simply be false here. And the fix is not reversible:
 * after inserting one, "the note already had a blank line" and "finalize added one" are
 * indistinguishable, so un-finalize could not be an exact inverse — and a byte-exact round trip is
 * the property that makes finalize safe to run on someone's notes at all.
 *
 * It is in the release checklist as a manual check.
 *
 * OFFSETS ARE INVALIDATED BY ANY EDIT. `findTikzBlocks` returns spans against the text it was
 * given; a caller finalizing several blocks must either work back-to-front through the array or
 * re-scan after each rewrite. Both are tested.
 */

// -------------------------------------------------------------------------------------------
// Public contract

export interface TikzBlockSpan {
	/**
	 * Offsets into the note text, covering the whole fence including the backticks: `start` is the
	 * first character of the opening fence line (its indentation included), `end` is one past the
	 * last character of the closing fence line and does NOT include that line's terminator.
	 *
	 * When `finalized` is true the span widens to the whole finalized region — the `![[…]]` embed
	 * line, the `%%` wrapper and the fence inside it — because that is exactly what
	 * `unfinalizeBlock` must remove. A caller forced to re-derive the embed's extent itself could
	 * disagree with this module about where the region begins, and the disagreement would eat a
	 * line of someone's note.
	 */
	start: number;
	end: number;
	/**
	 * The block body, without the fence lines, dedented by the opening fence's indentation the way
	 * CommonMark dedents fenced content, and without its quote markers when it is in a blockquote
	 * (`findTikzBlockAt`). Informational: nothing in finalize/un-finalize round-trips through it —
	 * those use the verbatim slice — so an approximate dedent cannot corrupt a note.
	 *
	 * Every line keeps its terminator, the last one included, which is NOT what a code-block
	 * processor is given. Anything that wants to find the rendered diagram goes through
	 * `asProcessorSource` first.
	 */
	source: string;
	/** The info string after the opening backticks, e.g. 'tikz'. Trimmed, case preserved. */
	info: string;
	/** Already finalized: an embed immediately followed by a commented-out fence. */
	finalized: boolean;
}

// -------------------------------------------------------------------------------------------
// What this scanner deliberately does not model
//
// A note is CommonMark plus Obsidian's extensions, and a complete block parser is not what this
// module is for. Every divergence below is a decision, not an oversight:
//
//  * INDENTATION. CommonMark allows an opening fence 0-3 spaces of indentation and calls 4+ an
//    indented code block. We accept ANY leading spaces or tabs, because the fence we actually have
//    to find is the one inside a list item — where the container strips the marker's width before
//    CommonMark ever sees the fence, and we have no container stack to strip it with. The cost is
//    that a ```tikz line inside a 4-space indented code block is read as a fence. A tikz diagram
//    in a list is common; a fence quoted inside an indented code block is not.
//  * BLOCKQUOTES, callouts included. `findTikzBlocks` does not report `> ```tikz`. Rewriting it
//    means reproducing the whole lazy-continuation rule to know where the quote ends, and a wrong
//    answer would write an embed outside the quote it belongs to. Better to find nothing than to
//    find it in the wrong place. `findTikzBlockAt` does find it, for the commands that only read
//    the diagram: a wrong extent there costs a "not rendered yet", never a line of the note. It
//    takes the quote to end, and the block with it, at the first line without the opener's
//    markers, where Obsidian would read a lazy line as more of the block.
//  * A FENCE ON A LIST MARKER'S LINE, `1. ```tikz`, is not reported by `findTikzBlocks` either:
//    its embed would have to take the fence's place on that line, and un-finalize put the fence
//    back there. `findTikzBlockAt` finds it. Either way it is read as a fence, so nothing inside it
//    is mistaken for a block of its own.
//  * INLINE `%%comment%%` PAIRS, and a block comment opened by `%% text` rather than a bare `%%`.
//    Only a line whose entire content is `%%` toggles comment state here. That is the shape
//    Obsidian's own docs use for a block comment and the shape this module writes, and the
//    alternative — counting `%%` tokens anywhere — is actively wrong, because `%%` is an ordinary
//    double comment in TeX and appears inside real tikz sources.
//  * An UNCLOSED `%%` comments the rest of the note, which is what Obsidian renders. A block after
//    a stray `%%` line is therefore not reported: it does not render, so it has nothing to
//    finalize.

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
/** A blockquote marker, and the one space after it that belongs to the marker. */
const QUOTE_MARKER = /^[ \t]*>[ ]?/;
/** A list item's marker and the space after it, as it stands in front of a fence on its line. */
const LIST_MARKER = /^[ \t]*(?:[*+-]|\d{1,9}[.)])[ \t]+/;
/** A line that is nothing but `%%`. See the note above on why nothing looser is accepted. */
const COMMENT_DELIMITER = /^[ \t]*%%[ \t]*$/;
/** A wiki embed alone on its line. Markdown-style `![](x.svg)` is not written by us, so not read. */
const EMBED_LINE = /^[ \t]*!\[\[[^\]]+\]\][ \t]*$/;

// -------------------------------------------------------------------------------------------
// Lines
//
// Everything works on a line index with absolute offsets rather than on a regex over the whole
// text, which is what keeps CRLF from ever costing an offset: the terminator is carried beside the
// line instead of being part of it, and `start`/`end` are slices of the ORIGINAL string.

interface Line {
	/** Offset of the first character of the line. */
	start: number;
	/** Offset one past the last character, BEFORE the terminator. */
	end: number;
	/** The line without its terminator. */
	text: string;
	/** '\n', '\r\n', or '' on a final line with no terminator. */
	terminator: string;
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let i = 0;
	for (;;) {
		const nl = text.indexOf('\n', i);
		if (nl === -1) {
			// A text that ends with a terminator has no trailing empty line; an empty text has
			// exactly one empty line, so that offsets into it are still expressible.
			if (i === text.length && lines.length > 0) break;
			lines.push({ start: i, end: text.length, text: text.slice(i), terminator: '' });
			break;
		}
		const end = nl > i && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
		lines.push({ start: i, end, text: text.slice(i, end), terminator: text.slice(end, nl + 1) });
		i = nl + 1;
	}
	return lines;
}

// -------------------------------------------------------------------------------------------
// Fences

interface Fence {
	indent: string;
	char: string;
	length: number;
	info: string;
}

function matchOpener(text: string): Fence | null {
	const m = FENCE_OPEN.exec(text);
	if (!m) return null;
	const indent = m[1] ?? '';
	const run = m[2] ?? '';
	const rest = m[3] ?? '';
	const char = run[0] ?? '`';
	// CommonMark: a backtick fence's info string may not contain a backtick, which is what keeps an
	// inline code span written with three or more backticks from opening a block.
	if (char === '`' && rest.includes('`')) return null;
	return { indent, char, length: run.length, info: rest.trim() };
}

/** An opening fence and what stands in front of it on its line. */
interface Opener extends Fence {
	/** Blockquote markers in front of it. Every line of the block carries as many. */
	quotes: number;
	/**
	 * Characters between the quote markers and the fence: its indentation, or a list item's marker
	 * and the space after it. Reading view takes up to this many off the start of each body line.
	 */
	width: number;
	/** On a list item's marker line, `1. ```tikz`, rather than on a line of its own. */
	onMarkerLine: boolean;
}

/** `matchOpener` for a fence in a blockquote, or on a list item's marker line, as well. */
function matchContainedOpener(text: string): Opener | null {
	let rest = text;
	let quotes = 0;
	for (let m = QUOTE_MARKER.exec(rest); m; m = QUOTE_MARKER.exec(rest)) {
		rest = rest.slice(m[0].length);
		quotes++;
	}
	const marker = LIST_MARKER.exec(rest)?.[0] ?? '';
	const fence = matchOpener(rest.slice(marker.length));
	if (!fence) return null;
	return { ...fence, quotes, width: marker.length + fence.indent.length, onMarkerLine: marker !== '' };
}

/** A line without its first `quotes` blockquote markers, or null when it has fewer. */
function unquote(text: string, quotes: number): string | null {
	let rest = text;
	for (let q = 0; q < quotes; q++) {
		const m = QUOTE_MARKER.exec(rest);
		if (!m) return null;
		rest = rest.slice(m[0].length);
	}
	return rest;
}

/**
 * A closing fence is at least as long as its opener and carries no info string.
 *
 * "At least as long" is the rule that makes a three-backtick line inside a `\node {…}` harmless
 * under a four-backtick opener, and it is why we compare against the opener's length, not 3.
 */
function isCloser(text: string, fence: Fence): boolean {
	let k = 0;
	while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
	let run = 0;
	while (k + run < text.length && text[k + run] === fence.char) run++;
	if (run < fence.length) return false;
	for (let p = k + run; p < text.length; p++) {
		const c = text[p];
		if (c !== ' ' && c !== '\t') return false;
	}
	return true;
}

interface FenceExtent {
	/** Index of the closing fence line, or null when the fence runs to the end of the note. */
	closeLine: number | null;
	/**
	 * Last line the block occupies: the closing fence, the last line of the note, or for a fence
	 * in a blockquote the last line of the quote.
	 */
	lastLine: number;
}

/** `quotes` is the opener's count of blockquote markers, which every line of the block carries. */
function scanFence(lines: Line[], openLine: number, fence: Fence, quotes = 0): FenceExtent {
	for (let j = openLine + 1; j < lines.length; j++) {
		const line = lines[j];
		if (!line) continue;
		const text = unquote(line.text, quotes);
		if (text === null) return { closeLine: null, lastLine: j - 1 };
		if (isCloser(text, fence)) return { closeLine: j, lastLine: j };
	}
	// Unterminated. CommonMark ends the block at the end of the document; we do the same and stop,
	// which is what keeps this loop from running off the array or throwing.
	return { closeLine: null, lastLine: lines.length - 1 };
}

/** Obsidian keys its code-block registry on the first token of the info string. */
function isTikzInfo(info: string): boolean {
	const first = info.split(/[ \t]+/, 1)[0] ?? '';
	return first.toLowerCase() === 'tikz';
}

/** CommonMark removes up to the opener's indentation from each content line, no more. */
function dedent(text: string, width: number): string {
	let k = 0;
	while (k < width && k < text.length) {
		const c = text[k];
		if (c !== ' ' && c !== '\t') break;
		k++;
	}
	return text.slice(k);
}

function bodyOf(
	lines: Line[],
	openLine: number,
	extent: FenceExtent,
	indentWidth: number,
	quotes = 0,
): string {
	const stop = extent.closeLine ?? extent.lastLine + 1;
	let out = '';
	for (let j = openLine + 1; j < stop; j++) {
		const line = lines[j];
		if (!line) continue;
		out += dedent(unquote(line.text, quotes) ?? '', indentWidth) + line.terminator;
	}
	return out;
}

/**
 * What Reading view hands a code-block processor for a block that Live Preview hands over as it
 * stands in the note: `opener` is the opening fence's line, `body` the lines between the fences,
 * joined by "\n" as the editor slices them. Null when `opener` does not open a tikz fence, or
 * opens one in a blockquote, which Live Preview never renders as a block.
 *
 * Live Preview hands over every body line with the list item's indentation in front of it, and
 * Reading view without: its parser takes off the item's indentation and then the fence's own, up
 * to as much as stands in front of the fence. On a line of its own that is the fence's
 * indentation, on a list item's marker line the marker and the space after it. Taking that many
 * spaces or tabs off each line is what the 1.14.4 parser does in every list we tried it on: bullet
 * and numbered, nested, indented with spaces or with tabs. It can part from it where the two are
 * mixed, tabs in front of the fence and spaces in front of its lines or the other way round.
 */
export function asReadingView(opener: string, body: string): string | null {
	const fence = matchContainedOpener(opener);
	if (!fence || fence.quotes > 0 || !isTikzInfo(fence.info)) return null;
	if (fence.width === 0) return body;
	return body
		.split('\n')
		.map((line) => dedent(line, fence.width))
		.join('\n');
}

/**
 * A scanned block's `source` in the form Obsidian hands a code-block processor — the form every
 * cache key was derived from.
 *
 * Obsidian drops the last body line's terminator: Reading view strips one trailing newline from
 * the code element's text, and Live Preview slices from the first body line to the END of the last
 * one (both read in the 1.14.4 bundle). The scanner keeps it, so a lookup keyed on the scanned text
 * missed every block, and Copy SVG, Save SVG, Finalize and the zoom view all said "That diagram
 * has not been rendered yet" about a diagram on screen. Line endings are made LF as well: a note
 * read from disk can carry CRLF, and the editor the processor reads from never does.
 *
 * Exactly one terminator, never a trim: a body that ends in a blank line reaches the processor
 * ending in a newline, and has to here too.
 */
export function asProcessorSource(source: string): string {
	const lf = source.split('\r\n').join('\n');
	return lf.endsWith('\n') ? lf.slice(0, -1) : lf;
}

// -------------------------------------------------------------------------------------------
// The scanner

/** The blocks finalize can rewrite in place: see the divergences above for the ones it cannot. */
export function findTikzBlocks(noteText: string): TikzBlockSpan[] {
	return scan(noteText)
		.filter((block) => block.inPlace)
		.map((block) => block.span);
}

/**
 * The block at `offset`, for the commands that read a diagram — Copy SVG, Save SVG, the zoom
 * view — rather than rewrite the note. Null when `offset` is in none.
 *
 * Besides every block `findTikzBlocks` reports, it finds the two kinds Obsidian renders and
 * finalize leaves alone: a fence in a blockquote or a callout, whose `source` has the quote
 * markers taken off as Reading view takes them off, and a fence on its list item's marker line.
 * A block covers its opening line from the first character, quote or list markers included, to
 * the end of its closing line, and `offset` may be at either end.
 */
export function findTikzBlockAt(noteText: string, offset: number): TikzBlockSpan | null {
	return scan(noteText).find(({ span }) => offset >= span.start && offset <= span.end)?.span ?? null;
}

interface ScannedBlock {
	span: TikzBlockSpan;
	/** Whether finalize can rewrite it: not in a blockquote, not on a list item's marker line. */
	inPlace: boolean;
}

function scan(noteText: string): ScannedBlock[] {
	const lines = splitLines(noteText);
	const blocks: ScannedBlock[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (!line) break;

		const fence = matchContainedOpener(line.text);
		if (fence) {
			const extent = scanFence(lines, i, fence, fence.quotes);
			// Every fence is consumed, but only tikz fences are reported: this is what makes a
			// tikz block nested inside a larger ````markdown block invisible, since the inner
			// opener is never looked at as a line in its own right.
			if (isTikzInfo(fence.info)) {
				const last = lines[extent.lastLine];
				blocks.push({
					span: {
						start: line.start,
						end: last ? last.end : noteText.length,
						source: bodyOf(lines, i, extent, fence.width, fence.quotes),
						info: fence.info,
						finalized: false,
					},
					inPlace: fence.quotes === 0 && !fence.onMarkerLine,
				});
			}
			i = extent.lastLine + 1;
			continue;
		}

		if (COMMENT_DELIMITER.test(line.text)) {
			const region = matchFinalizedRegion(lines, i);
			if (region) {
				blocks.push({ span: region.span, inPlace: true });
				i = region.nextLine;
				continue;
			}
			i = skipComment(lines, i);
			continue;
		}

		i++;
	}

	return blocks;
}

interface FinalizedMatch {
	span: TikzBlockSpan;
	nextLine: number;
}

/**
 * `openLine` is the `%%` that opens the wrapper; the embed sits on the line above it.
 *
 * This runs BEFORE the generic comment skip, and that order is the whole trick: a finalized block
 * is by construction a fence inside a comment, i.e. exactly the thing the comment rule is there to
 * hide. Without the special case, finalize would be a one-way door — the block would vanish from
 * the scan and un-finalize would have nothing to act on.
 */
function matchFinalizedRegion(lines: Line[], openLine: number): FinalizedMatch | null {
	const embed = lines[openLine - 1];
	if (!embed || !EMBED_LINE.test(embed.text)) return null;

	const fenceLine = lines[openLine + 1];
	if (!fenceLine) return null;
	const fence = matchOpener(fenceLine.text);
	if (!fence || !isTikzInfo(fence.info)) return null;

	const extent = scanFence(lines, openLine + 1, fence);
	if (extent.closeLine === null) return null;

	const closer = lines[extent.closeLine + 1];
	if (!closer || !COMMENT_DELIMITER.test(closer.text)) return null;

	return {
		span: {
			start: embed.start,
			end: closer.end,
			source: bodyOf(lines, openLine + 1, extent, fence.indent.length),
			info: fence.info,
			finalized: true,
		},
		nextLine: extent.closeLine + 2,
	};
}

/**
 * Skip an Obsidian block comment, stepping OVER any fence inside it.
 *
 * Stepping over fences matters because a commented-out tikz block routinely contains `%%` lines of
 * its own — `%` is TeX's comment character and `%%` is an ordinary section rule in TeX source. A
 * scanner that ended the comment at the first `%%` it saw would resume in the middle of a block
 * body and start reporting its `\draw` lines as note content.
 */
function skipComment(lines: Line[], openLine: number): number {
	let j = openLine + 1;
	while (j < lines.length) {
		const line = lines[j];
		if (!line) break;
		const fence = matchOpener(line.text);
		if (fence) {
			j = scanFence(lines, j, fence).lastLine + 1;
			continue;
		}
		if (COMMENT_DELIMITER.test(line.text)) return j + 1;
		j++;
	}
	return lines.length;
}

// -------------------------------------------------------------------------------------------
// Rewrites

/**
 * Replace a block with its finalized form: an `![[attachmentName]]` embed followed by the original
 * fence, verbatim, inside a `%%` comment.
 *
 * `attachmentName` is the file name as it should appear in the embed, extension included — i.e.
 * what `fileManager.getAvailablePathForAttachment` handed the caller, made vault-relative or
 * shortened to taste. This module does not append `.svg`: an embed naming a file that does not
 * exist is a broken image in every reader, and guessing an extension for the caller is how that
 * happens.
 *
 * Re-finalizing an already-finalized span is supported and rewrites only the embed, so pointing a
 * block at a freshly rendered attachment never touches the preserved source.
 *
 * Throws rather than guessing when the span no longer describes the text (the note changed under
 * the caller) or when the fence is unterminated — see `fenceTextOf`.
 */
export function finalizeBlock(noteText: string, span: TikzBlockSpan, attachmentName: string): string {
	assertEmbeddableName(attachmentName);
	const fenceText = fenceTextOf(noteText, span);
	const eol = eolWithin(noteText, span);
	const indent = leadingWhitespace(fenceText);

	// The `%%` markers take the fence's own indentation, so finalizing a diagram that lives in a
	// list item leaves the whole region inside that list item.
	const region = [`${indent}![[${attachmentName}]]`, `${indent}%%`, fenceText, `${indent}%%`].join(eol);

	// Nothing is inserted before the region. See the OPEN QUESTION in this file's header: a
	// separator would be the obvious guard against the embed being absorbed into a preceding
	// paragraph, but it cannot be undone — after one exists, "the note already had it" and
	// "finalize added it" are the same bytes — and un-finalize being an exact inverse is what makes
	// this safe to run over someone's notes.
	return noteText.slice(0, span.start) + region + noteText.slice(span.end);
}

/**
 * The exact inverse: restore the fence and remove the embed and its `%%` wrapper.
 *
 * A span that is not finalized returns the note unchanged rather than throwing, so a caller can
 * map un-finalize over every block in a note without filtering first. A span that CLAIMS to be
 * finalized but no longer parses does throw — that is a stale offset, and the only safe thing to
 * do with a stale offset is refuse.
 */
export function unfinalizeBlock(noteText: string, span: TikzBlockSpan): string {
	if (!span.finalized) return noteText;
	const fenceText = fenceTextOf(noteText, span);
	return noteText.slice(0, span.start) + fenceText + noteText.slice(span.end);
}

// -------------------------------------------------------------------------------------------
// Rewrite helpers

/**
 * The original fence, verbatim, for either kind of span.
 *
 * Everything both rewrites need comes from here, re-derived from `noteText` rather than trusted
 * from the span, so a span that has drifted out of date fails loudly instead of splicing a comment
 * marker into the middle of somebody's prose.
 */
function fenceTextOf(noteText: string, span: TikzBlockSpan): string {
	if (span.start < 0 || span.end > noteText.length || span.start >= span.end) {
		throw new Error('tikz finalize: span is out of range for this note text');
	}
	const region = noteText.slice(span.start, span.end);
	const lines = splitLines(region);

	if (!span.finalized) {
		const first = lines[0];
		const fence = first ? matchOpener(first.text) : null;
		if (!fence) throw new Error('tikz finalize: span does not start at a code fence');
		if (scanFence(lines, 0, fence).closeLine === null) {
			// An unterminated fence cannot round-trip: wrapped in `%%`, its own missing closer
			// swallows the trailing `%%`, so the region would no longer scan as finalized and
			// un-finalize could never give the note back. Refusing is the honest failure.
			throw new Error('tikz finalize: refusing to finalize an unterminated code fence');
		}
		return region;
	}

	const embed = lines[0];
	const opener = lines[1];
	const fenceLine = lines[2];
	const fence = fenceLine ? matchOpener(fenceLine.text) : null;
	if (
		!embed ||
		!opener ||
		!fenceLine ||
		!fence ||
		!EMBED_LINE.test(embed.text) ||
		!COMMENT_DELIMITER.test(opener.text)
	) {
		throw new Error('tikz finalize: span is marked finalized but does not contain a finalized block');
	}
	const close = scanFence(lines, 2, fence).closeLine;
	const last = close === null ? undefined : lines[close];
	if (!last)
		throw new Error('tikz finalize: span is marked finalized but does not contain a finalized block');
	return region.slice(fenceLine.start, last.end);
}

function leadingWhitespace(text: string): string {
	let k = 0;
	while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
	return text.slice(0, k);
}

/**
 * The line ending to write, taken from inside the block itself.
 *
 * Not from the note's first line and not from a global majority vote: a note can mix endings (a
 * synced vault, a git checkout with `autocrlf`, a paste from a Windows editor), and the only
 * ending guaranteed not to look wrong beside the text we are splicing is the one that text
 * already uses.
 */
function eolWithin(noteText: string, span: TikzBlockSpan): string {
	let nl = noteText.indexOf('\n', span.start);
	if (nl === -1 || nl >= span.end) nl = noteText.indexOf('\n');
	if (nl === -1) return '\n';
	return nl > 0 && noteText.charCodeAt(nl - 1) === 13 ? '\r\n' : '\n';
}

function assertEmbeddableName(name: string): void {
	if (name.trim() === '') throw new Error('tikz finalize: attachment name is empty');
	// A line break would split the embed in two, and ANY square bracket breaks it — not just a
	// doubled one. `![[a]b.svg]]` closes at the first `]]` it can find and matches neither
	// Obsidian's wiki-link grammar (which excludes `[` and `]` from a link target) nor this
	// module's own `EMBED_LINE`. The consequence is the one thing finalize must never do: the
	// region stops scanning as finalized, so the preserved TeX is sealed inside a `%%` comment that
	// un-finalize can no longer reopen, and the embed does not render either — which is the entire
	// point of writing it. Found in review by round-tripping every name shape a vault can produce.
	if (/[\r\n]/.test(name) || /[[\]]/.test(name)) {
		throw new Error('tikz finalize: attachment name cannot contain a line break or square brackets');
	}
}
