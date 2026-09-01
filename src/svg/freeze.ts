import { parseSvg, serializeSvg, SVG_NS } from './serialize';
import { PAPER_FILL_CLASS, PAPER_STROKE_CLASS } from './colors';
import { parseViewBox, formatNumber } from './geometry';

/**
 * Freeze a mounted diagram into a standalone SVG file. See internal/DESIGN.md §7.9.
 *
 * WHY THIS EXISTS. The stored artifact is theme-neutral ON PURPOSE (svg/colors.ts): TeX's default
 * ink became `currentColor` and its paper became a `tz-paper-fill` / `tz-paper-stroke` CLASS, which
 * is what makes a theme switch cost zero recompiles. Both halves resolve through Obsidian —
 * `--tikz-ink` on the wrapper, `.tz-paper-*` in styles.css — and through NOTHING ELSE. Copy that
 * markup into a file, an email, a Publish site or an `<img src>` and:
 *
 *   - `currentColor` inherits from a `color` nobody set, i.e. the UA default black;
 *   - the paper classes match no stylesheet, so the author's white shapes fall back to black too —
 *     a white label plate becomes a black box over the drawing (upstream #21, #97);
 *   - `<text font-family="cmr10">` has no `@font-face` behind it, so every glyph dvi2html emitted
 *     as text renders in a fallback face, or not at all;
 *   - a fragment that was well-formed inline is not well-formed as a file: HTML parsing implied the
 *     SVG namespace and the `xlink:` prefix that XML parsing demands (#95, #33).
 *
 * So this is not "serialize the element". It is a deliberate un-doing of every theme-neutral
 * indirection, back into literals, for a document that will be read with no stylesheet at all.
 *
 * PURE, and DOM-bound only through svg/serialize.ts, which is the single DOMParser/XMLSerializer
 * boundary in the plugin. No `obsidian` import, no clock, no randomness: the caller supplies the
 * two colours it read off the live theme and the font stylesheet it shipped, so this function is a
 * string-to-string transform that a test can drive end to end.
 */

export interface FreezeOptions {
	/** The literal every `currentColor` resolves to — the theme's `--tikz-ink`, e.g. `#000`. */
	ink: string;
	/** The literal the paper classes resolve to — the theme's `--tikz-paper`, e.g. `#fff`. */
	paper: string;
	/** Prepend a paper-coloured background rect covering the viewBox. */
	opaque?: boolean | undefined;
	/** The full `@font-face` stylesheet to SELECT FROM. Only the referenced faces are inlined. */
	fontCss: string;
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * The properties whose value can be a `<color>` or a `<paint>`, and therefore the only ones where
 * the `currentColor` keyword means anything.
 *
 * Enumerated rather than "every attribute containing the word": an id or a class that happens to
 * read `currentColor` is text, not a paint, and rewriting it would corrupt content this pass does
 * not own. The same discipline as colors.ts's PAINT_PROPERTIES, widened to the gradient and filter
 * paints because those live inside `<defs>`, which is exactly the region a top-level
 * `style="color:…"` is least reliable at reaching.
 */
const COLOR_PROPERTIES = ['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color'] as const;

/**
 * The `currentColor` keyword, as a whole token.
 *
 * Case-insensitive because CSS keywords are, and bounded by `[-\w]` so a hyphenated identifier that
 * merely ends in the word (`--my-currentcolor`) is not a match.
 *
 * The left bound is a CAPTURED character rather than a lookbehind, and that is not a style choice.
 * A lookbehind is a syntax error in JavaScriptCore before Safari 16.4, and a syntax error anywhere
 * in the bundle stops the WHOLE file from parsing — so this one regex, in a module most notes never
 * reach, was enough to make Obsidian on an older iPhone say only "failed to load plugin". The
 * replacer below has to put the captured character back.
 *
 * Two adjacent occurrences still both match: a match ends at the keyword, so the separator after it
 * is left for the next one to claim.
 */
const CURRENT_COLOR = /(^|[^-\w])currentcolor(?![-\w])/gi;

/** The `class` tokens colors.ts writes, and the property each one stands in for. */
const PAPER_CLASS_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
	[PAPER_FILL_CLASS, 'fill'],
	[PAPER_STROKE_CLASS, 'stroke'],
];

const ELEMENT_NODE = 1;

/**
 * Marks the two nodes this module ADDS, so a second freeze replaces them instead of stacking a
 * second copy on top.
 *
 * Freezing is lossy — a resolved `currentColor` cannot be turned back into a keyword — so this is
 * not a claim that the pass is reversible. It is the narrower promise that re-freezing an output
 * does not accumulate, which matters because the node in question is the biggest thing in the file:
 * a doubled font block doubles a megabyte, and nothing about the result would look wrong.
 */
const FONTS_CLASS = 'tz-frozen-fonts';
const BACKGROUND_CLASS = 'tz-frozen-paper';

/**
 * Turn a stored (already id-stamped) template into a standalone SVG document.
 *
 * The ids are left exactly as they are — the caller stamps them, because a nonce needs randomness
 * and this module has none. Freezing a template that still carries `__TZ__n` placeholders is the
 * caller's bug, and it produces a file with placeholder ids rather than a silently broken one.
 */
export function freezeSvg(markup: string, options: FreezeOptions): string {
	// BEFORE the parse, not after. An undeclared `xlink:` prefix is a namespace error in XML, so a
	// real DOMParser rejects the very fragment we are trying to rescue, and an `<svg>` with no
	// `xmlns` parses into NO namespace — svg/serialize.ts rejects that outright, deliberately,
	// because a namespace-less root draws nothing and reports nothing.
	const doc = parseSvg(declareNamespaces(markup));
	const root = doc.documentElement as Element | undefined;
	if (root === undefined) return markup;

	// Before the walk, so a re-freeze does not collect the families of its own previous font block
	// or paint a second background over the first.
	dropPreviousAdditions(root);

	const families = new Set<string>();
	freezeElement(root, options, families, options.ink);
	pinRootDefaults(root, options.ink);

	// Insertion order: the font faces first (a `<style>` draws nothing, so its position is free and
	// the top is where a human reading the file expects it), then the background rect, which must
	// precede every drawable so that it paints behind them.
	let anchor = firstDrawableChild(root);

	const faces = selectFontFaces(options.fontCss, families);
	if (faces !== '') {
		const style = doc.createElementNS(SVG_NS, 'style');
		style.setAttribute('type', 'text/css');
		style.setAttribute('class', FONTS_CLASS);
		style.textContent = faces;
		root.insertBefore(style, anchor);
		anchor = style.nextSibling;
	}

	if (options.opaque === true) {
		root.insertBefore(backgroundRect(doc, root, options.paper), anchor);
	}

	return serializeSvg(doc);
}

// -------------------------------------------------------------------------------------------
// The walk

/**
 * One depth-first pass doing all three rewrites, because all three need the same traversal and one
 * of them — `currentColor` — needs the inherited `color` that only a top-down walk knows.
 *
 * `inherited` is the colour an unqualified `currentColor` resolves to at this element. It starts as
 * the caller's ink (standing in for the `--tikz-ink` the wrapper sets in Obsidian) and is replaced
 * for a subtree by any element declaring its own literal `color` — so an author's `\color{red}`
 * survives as red and its descendants' `currentColor` follows it, instead of being flattened to the
 * theme ink. A naive `style="color:#000"` stamped on the root gets that case wrong.
 */
function freezeElement(el: Element, options: FreezeOptions, families: Set<string>, inherited: string): void {
	// Paper first: the class outranks a presentation attribute in Obsidian, so resolving it into a
	// literal attribute before the colour pass reads one keeps the two in the order the cascade
	// had them.
	resolvePaperClasses(el, options.paper);

	const declarations = parseStyle(el.getAttribute('style'));
	const own = ownColor(el, declarations, inherited);

	resolveAttributes(el, own, families);
	if (declarations.length > 0) rewriteStyle(el, declarations, own, families);

	// An element that redefines `color` for its subtree also needs an explicit `fill`, if it has
	// none of its own.
	//
	// In Obsidian the root carries `fill: currentColor` from styles.css, so an unpainted element —
	// dvi2html leaves most glyph <use>es and many <g>s that way — paints whatever `color` is in
	// force AT ITS OWN DEPTH. A frozen file has no stylesheet, so that inheritance has to be
	// written down; pinning one literal fill on the root instead would flatten it, and an author's
	// `\color{red}` group (which the colour pass never touches) would paint its unpainted children
	// theme ink. Found in review, with exactly that case.
	//
	// Only where `color` actually CHANGES, so the output does not gain a fill on every node.
	if (own !== inherited && !declares(el, declarations, 'fill')) {
		el.setAttribute('fill', own);
	}

	const children = el.children;
	for (let i = 0; i < children.length; i++) {
		const child = children.item(i);
		// `<pattern>`, `<marker>`, `<mask>` and `<defs>` are walked like anything else, and that is
		// the point: their content is referenced from elsewhere, and renderers disagree about
		// whether `currentColor` inside them resolves against the DEFINITION's context or the
		// USE's, so a root-level `color` is not guaranteed to reach a hatch pattern or an arrow
		// head. Resolving to a literal removes the disagreement (#97).
		if (child !== null) freezeElement(child, options, families, own);
	}
}

/**
 * Replace `.tz-paper-*` with the literal paint it stands for, and drop the class.
 *
 * The attribute is written rather than an inline declaration: it is the weakest paint there is, so
 * an inline `style` that colors.ts left in place still wins, exactly as it does over the class rule
 * in styles.css. The class token goes either way — a class naming a stylesheet that is not coming
 * is worse than no class at all.
 */
function resolvePaperClasses(el: Element, paper: string): void {
	const classes = el.getAttribute('class');
	if (classes === null || classes.indexOf('tz-paper-') === -1) return;

	const kept: string[] = [];
	for (const token of classes.split(/\s+/)) {
		if (token === '') continue;
		let matched = false;
		for (const [name, property] of PAPER_CLASS_PROPERTIES) {
			if (token !== name) continue;
			el.setAttribute(property, paper);
			matched = true;
		}
		if (!matched) kept.push(token);
	}

	if (kept.length === 0) el.removeAttribute('class');
	else el.setAttribute('class', kept.join(' '));
}

/** The `color` this element's own `currentColor` resolves against, and that its children inherit. */
function ownColor(el: Element, declarations: readonly Declaration[], inherited: string): string {
	// A declaration outranks the presentation attribute, so it is consulted first; last one wins
	// within the attribute, as in CSS.
	for (let i = declarations.length - 1; i >= 0; i--) {
		const declaration = declarations[i];
		if (declaration === undefined || declaration.property !== 'color') continue;
		return resolveColorValue(declaration.value, inherited);
	}
	const attribute = el.getAttribute('color');
	if (attribute === null) return inherited;
	return resolveColorValue(attribute, inherited);
}

/** `currentColor` and `inherit` on `color` itself both mean "whatever the parent resolved to". */
function resolveColorValue(value: string, inherited: string): string {
	const body = trimAscii(stripPriority(value));
	const keyword = body.toLowerCase();
	if (keyword === '' || keyword === 'inherit' || keyword === 'currentcolor') return inherited;
	return body;
}

function resolveAttributes(el: Element, color: string, families: Set<string>): void {
	for (const property of COLOR_PROPERTIES) {
		const value = el.getAttribute(property);
		if (value === null || !hasCurrentColor(value)) continue;
		el.setAttribute(property, replaceCurrentColor(value, color));
	}

	// dvi2html emits REAL text — `<text font-family="cmr10">` — not outlined glyphs, which is why
	// the font subset below is mandatory rather than a nicety.
	const family = el.getAttribute('font-family');
	if (family !== null) collectFamilies(family, families);
}

function rewriteStyle(
	el: Element,
	declarations: readonly Declaration[],
	color: string,
	families: Set<string>,
): void {
	let changed = false;
	const out: string[] = [];

	for (const declaration of declarations) {
		// A family named only here — `style="font-family: cmmi10"` — is just as real a reference as
		// the attribute form, and missing it would ship a file whose maths renders in a fallback
		// face. The engine writes both: emitter 4 (svg/colors.ts) puts text in a styled `<span>`.
		if (declaration.property === 'font-family') collectFamilies(declaration.value, families);

		if (!isColorProperty(declaration.property) || !hasCurrentColor(declaration.value)) {
			out.push(declaration.raw);
			continue;
		}
		// The VALUE is rewritten, not the whole declaration: `!important` and any `url(#g)` fallback
		// paint sitting beside the keyword survive untouched.
		out.push(declaration.property + ': ' + replaceCurrentColor(declaration.value, color));
		changed = true;
	}

	if (changed) el.setAttribute('style', out.join('; '));
}

/**
 * Pin the two paints the plugin's own stylesheet supplies, on the root, so that nothing depends on
 * that stylesheet any more.
 *
 * `fill` matters as much as `color`: styles.css says `.tikzjax-figure svg { fill: currentColor }`
 * precisely because dvi2html leaves the glyph `<use>`s and many `<g>`s with no fill of their own.
 * Without it here they take the UA default — BLACK — which is invisible ink in a dark-theme export.
 * Neither is written when the document already declares one; an author's paint wins.
 */
function pinRootDefaults(root: Element, ink: string): void {
	const declarations = parseStyle(root.getAttribute('style'));

	// Replicates what styles.css gives the mounted diagram: `fill: currentColor` on the root, with
	// the ink in `color`. Written as a LITERAL fill rather than `currentColor`, so a frozen file
	// contains no unresolved reference at all — the per-subtree behaviour that a literal would
	// otherwise lose is restored in the walk, where an element that redefines `color` also gets an
	// explicit fill.
	if (!declares(root, declarations, 'color')) root.setAttribute('color', ink);
	if (!declares(root, declarations, 'fill')) root.setAttribute('fill', ink);
}

function declares(el: Element, declarations: readonly Declaration[], property: string): boolean {
	if (el.getAttribute(property) !== null) return true;
	for (const declaration of declarations) {
		if (declaration.property === property) return true;
	}
	return false;
}

// -------------------------------------------------------------------------------------------
// The font subset

/**
 * Keep only the `@font-face` rules the document actually references.
 *
 * Mandatory, and mandatory to be a SUBSET: the shipped stylesheet is 140 base64 TrueType faces
 * totalling 4.8 MB (scripts/gen-styles.mjs), a typical diagram uses about twelve of them, and
 * inlining all 140 would mean a 2 MB file for a circle — an "export" nobody can attach to anything.
 *
 * The rule text is copied VERBATIM, byte for byte, rather than reconstructed from a parse: the
 * payload is a base64 data URI, and the only safe transformation of one is none.
 */
function selectFontFaces(css: string, families: ReadonlySet<string>): string {
	if (css === '' || families.size === 0) return '';

	const kept: string[] = [];
	// Lower-cased only for LOCATING the at-rule; every slice is taken from the original.
	const haystack = css.toLowerCase();

	let at = haystack.indexOf(FONT_FACE);
	while (at !== -1) {
		const open = css.indexOf('{', at + FONT_FACE.length);
		if (open === -1) break;

		// Only whitespace may sit between the keyword and its block. Anything else means this
		// occurrence is NOT an at-rule — the word inside a comment, in a stylesheet the caller
		// handed over whole — and slicing from `at` would splice that prose into the emitted
		// `<style>`. A stray `*/` there is not untidiness: it makes the first REAL rule the block
		// of an invalid at-rule, the browser drops the pair, and the face silently fails to load.
		// That is the #21 symptom, produced by the one stage that exists to prevent it. Found in
		// review.
		if (!isBlank(css.slice(at + FONT_FACE.length, open))) {
			at = haystack.indexOf(FONT_FACE, at + FONT_FACE.length);
			continue;
		}

		const close = matchBrace(css, open);
		if (close === -1) break;

		const family = faceFamily(css.slice(open + 1, close));
		if (family !== undefined && families.has(family)) kept.push(css.slice(at, close + 1));

		at = haystack.indexOf(FONT_FACE, close + 1);
	}

	return kept.join('\n');
}

const FONT_FACE = '@font-face';

/** The `font-family` descriptor of one `@font-face` body, normalised for comparison. */
function faceFamily(body: string): string | undefined {
	// Anchored to the start of a descriptor so that `src: local(font-family...)` — and anything
	// else carrying the word inside a value — cannot be mistaken for the descriptor itself.
	const match = /(?:^|[;{])\s*font-family\s*:\s*([^;}]+)/i.exec(body);
	const value = match?.[1];
	if (value === undefined) return undefined;
	return normalizeFamily(value);
}

/** The index of the `}` closing the `{` at `open`, or -1. Nested braces are counted, for safety. */
function matchBrace(css: string, open: number): number {
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		const ch = css.charAt(i);
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Add every family named in a `font-family` value.
 *
 * The value is a comma-separated fallback LIST and any member of it may be the face that ends up
 * used, so all of them are collected. Generic keywords (`serif`, `sans-serif`) collect harmlessly:
 * they match no `@font-face`, so they select nothing.
 */
function collectFamilies(value: string, families: Set<string>): void {
	for (const part of value.split(',')) {
		const family = normalizeFamily(part);
		if (family !== '') families.add(family);
	}
}

/**
 * Unquote, trim and lower-case a family name.
 *
 * Lower-cased because CSS family matching is case-insensitive and the SVG and the stylesheet come
 * from two different generators: `font-family="CMR10"` must still find
 * `@font-face{font-family:cmr10}`.
 */
function normalizeFamily(value: string): string {
	let name = trimAscii(stripPriority(value));
	const first = name.charAt(0);
	if ((first === '"' || first === "'") && name.length > 1 && name.charAt(name.length - 1) === first) {
		name = name.slice(1, name.length - 1);
	}
	return trimAscii(name).toLowerCase();
}

// -------------------------------------------------------------------------------------------
// The opaque background

/**
 * A paper-coloured rect covering the whole viewBox.
 *
 * Sized from the `viewBox` rather than from `width`/`height`: those are the OUTER size in pt and
 * carry the engine's inch-short frame error (#66, #71, #29), while the viewBox is the user-unit
 * coordinate system the children are actually drawn in — and after §7.4's ink-bounds correction it
 * is the only one of the two that is right. With no usable viewBox, percentages of the viewport are
 * the honest fallback.
 */
function backgroundRect(doc: XMLDocument, root: Element, paper: string): Element {
	const rect = doc.createElementNS(SVG_NS, 'rect');
	const box = parseViewBox(root.getAttribute('viewBox'));

	if (box === null) {
		rect.setAttribute('x', '0');
		rect.setAttribute('y', '0');
		rect.setAttribute('width', '100%');
		rect.setAttribute('height', '100%');
	} else {
		rect.setAttribute('x', formatNumber(box.x));
		rect.setAttribute('y', formatNumber(box.y));
		rect.setAttribute('width', formatNumber(box.width));
		rect.setAttribute('height', formatNumber(box.height));
	}

	rect.setAttribute('fill', paper);
	// The root can carry a `stroke` — SVGO's moveElemsAttrsToGroup hoists one shared by every child
	// — and the rect would inherit it, outlining the background in ink.
	rect.setAttribute('stroke', 'none');
	rect.setAttribute('class', BACKGROUND_CLASS);
	return rect;
}

/** Remove the `<style>` and `<rect>` a previous freeze of this same document added. */
function dropPreviousAdditions(root: Element): void {
	const children = root.children;
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children.item(i);
		if (child === null) continue;
		const classes = child.getAttribute('class');
		if (classes === null) continue;
		for (const token of classes.split(/\s+/)) {
			if (token !== FONTS_CLASS && token !== BACKGROUND_CLASS) continue;
			root.removeChild(child);
			break;
		}
	}
}

/** Where content may be inserted: after any leading `<title>`/`<desc>`, which own the first slot. */
function firstDrawableChild(root: Element): Node | null {
	// A non-element node is STEPPED OVER rather than taken as the anchor. A stored template is not
	// necessarily whitespace-free — SVGO collapses the engine's line breaks, but `raw` and `fast`
	// skip SVGO altogether, so `<svg>\n<title>...` is a real shape — and anchoring on that leading
	// text node put the injected background IN FRONT of the `<title>`, which is the one child this
	// function exists to leave alone. Found in review.
	let anchor: Node | null = root.firstChild;
	let node: Node | null = root.firstChild;
	while (node !== null) {
		if (node.nodeType !== ELEMENT_NODE) {
			node = node.nextSibling;
			continue;
		}
		const el = node as Element;
		// `<title>` stays the first child: it is the SVG's accessible name (§7.11), and a renderer
		// that takes the first `<title>` in document order must still find it there.
		if (el.localName !== 'title' && el.localName !== 'desc') return anchor;
		anchor = node.nextSibling;
		node = node.nextSibling;
	}
	return anchor;
}

// -------------------------------------------------------------------------------------------
// Namespaces

/**
 * Add `xmlns` and `xmlns:xlink` to the root start tag if they are missing.
 *
 * A STRING pass, before parsing, on purpose. Both declarations have to exist for the parse itself
 * to succeed the way we need it to: without `xmlns` the root is an element in no namespace, which
 * svg/serialize.ts rejects, and an undeclared `xlink:` prefix — dvi2html writes `<use xlink:href>`
 * for every glyph — is a namespace error that a real DOMParser turns into a `<parsererror>`
 * document. Adding them afterwards through `setAttribute` would be a race with the same parser.
 *
 * Both are declared unconditionally rather than only when used: they cost ~80 bytes, and "the file
 * opens at all" is worth more than the bytes. Markup with no findable root tag is returned
 * untouched, so the parser produces the real diagnostic instead of this function inventing one.
 */
function declareNamespaces(markup: string): string {
	const start = findRootTag(markup);
	if (start === -1) return markup;

	const end = findTagEnd(markup, start);
	if (end === -1) return markup;

	const tag = markup.slice(start, end);
	let additions = '';
	// `\sxmlns\s*=` and not `xmlns=`: `xmlns:xlink="…"` contains the shorter string, and matching it
	// would leave the default namespace undeclared while believing it had been handled.
	if (!/\sxmlns\s*=/.test(tag)) additions += ` xmlns="${SVG_NS}"`;
	if (!/\sxmlns:xlink\s*=/.test(tag)) additions += ` xmlns:xlink="${XLINK_NS}"`;
	if (additions === '') return markup;

	const insert = start + '<svg'.length;
	return markup.slice(0, insert) + additions + markup.slice(insert);
}

/** The index of the `<svg` that opens the root element, skipping any prolog. */
function findRootTag(markup: string): number {
	let at = markup.indexOf('<svg');
	while (at !== -1) {
		const next = markup.charAt(at + '<svg'.length);
		// `<svgfoo>` is a different element; only a delimiter may follow the name.
		if (next === '' || next === '>' || next === '/' || isAsciiSpace(next)) return at;
		at = markup.indexOf('<svg', at + 1);
	}
	return -1;
}

/** The index just past the `>` of the start tag beginning at `start`, quotes respected. */
function findTagEnd(markup: string, start: number): number {
	let quote = '';
	for (let i = start; i < markup.length; i++) {
		const ch = markup.charAt(i);
		if (quote !== '') {
			if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '>') return i + 1;
	}
	return -1;
}

// -------------------------------------------------------------------------------------------
// Small helpers

interface Declaration {
	/** Lower-cased property name; empty for a fragment with no colon in it. */
	property: string;
	/** Everything after the first colon, trimmed — `!important` included. */
	value: string;
	/** The declaration as written, re-emitted verbatim when nothing needs changing. */
	raw: string;
}

/**
 * Split a `style` attribute into declarations, on top-level semicolons only.
 *
 * The same split exists privately in svg/colors.ts. It is duplicated rather than exported because
 * the two want different outputs — that one keeps declarations whole, this one has to take them
 * apart — and the reason a naive `split(';')` will not do is the same in both places:
 * `url('a;b.png')` and `rgb(0, 0, 0)`.
 */
function parseStyle(style: string | null): Declaration[] {
	if (style === null || style === '') return [];

	const out: Declaration[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;

	const push = (chunk: string): void => {
		const raw = trimAscii(chunk);
		if (raw === '') return;
		// A property name can hold neither a colon nor a bracket, so the first colon is the
		// separator even when the value contains more of them (`url(data:…)`).
		const colon = raw.indexOf(':');
		if (colon < 0) {
			out.push({ property: '', value: '', raw });
			return;
		}
		out.push({
			property: trimAscii(raw.slice(0, colon)).toLowerCase(),
			value: trimAscii(raw.slice(colon + 1)),
			raw,
		});
	};

	for (let i = 0; i < style.length; i++) {
		const ch = style.charAt(i);
		if (quote !== '') {
			if (ch === quote && style.charAt(i - 1) !== '\\') quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') {
			if (depth > 0) depth--;
		} else if (ch === ';' && depth === 0) {
			push(style.slice(start, i));
			start = i + 1;
		}
	}
	push(style.slice(start));
	return out;
}

function isColorProperty(property: string): boolean {
	for (const candidate of COLOR_PROPERTIES) {
		if (candidate === property) return true;
	}
	return false;
}

/** `lastIndex` is reset on both entry points: the shared regex is `/g`, so it is stateful. */
function hasCurrentColor(value: string): boolean {
	CURRENT_COLOR.lastIndex = 0;
	return CURRENT_COLOR.test(value);
}

/**
 * A function replacer, not a string one: a replacement string is scanned for `$&`, `$1` and
 * friends, and the caller's ink is a value read off a theme variable rather than a literal we
 * control. `before` is the character the pattern had to consume in place of a lookbehind, and it
 * goes back exactly as it came.
 */
function replaceCurrentColor(value: string, color: string): string {
	CURRENT_COLOR.lastIndex = 0;
	return value.replace(CURRENT_COLOR, (_match, before: string) => `${before}${color}`);
}

/** Drop a trailing `!important` so that a value can be compared as a keyword. */
function stripPriority(value: string): string {
	const trimmed = trimAscii(value);
	const bang = trimmed.lastIndexOf('!');
	if (bang < 0) return trimmed;
	if (trimAscii(trimmed.slice(bang + 1)).toLowerCase() !== 'important') return trimmed;
	return trimAscii(trimmed.slice(0, bang));
}

/**
 * ASCII-only trim, like the one in svg/colors.ts: `String.prototype.trim` covers the whole Unicode
 * whitespace set, which is more than CSS means, and keeping a local helper is also the #48 lesson —
 * a third-party plugin monkey-patched a String prototype method out from under this plugin and
 * silently killed two whole stages.
 */
function trimAscii(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && isAsciiSpace(value.charAt(start))) start++;
	while (end > start && isAsciiSpace(value.charAt(end - 1))) end--;
	return value.slice(start, end);
}

function isAsciiSpace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isBlank(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		if (!isAsciiSpace(value.charAt(i))) return false;
	}
	return true;
}
