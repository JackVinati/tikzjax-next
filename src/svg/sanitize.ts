import { splitDeclarations } from './colors';
import { SVG_NS } from './serialize';

/**
 * Stage 2 of the SVG pipeline: strip active content. MANDATORY and non-skippable — `raw`, `fast`
 * and a degraded mount all still run it. See internal/DESIGN.md §7.2.
 *
 * Why this exists, since there is no upstream issue for it: the bundled dvi2html implements
 * `\special{dvisvgm:raw …}` by emitting the remainder of the special into the SVG *verbatim*. So a
 * ```tikz fence in a note is an authoring surface for arbitrary markup — <script>, on* handlers,
 * <foreignObject> with HTML inside, `javascript:` and `http:` hrefs. Three things make that worse
 * than it sounds: notes are synced and shared, the post-processed artifact is *persisted* and
 * replayed on every later open (so one hostile note is durable), and the host is an Electron
 * renderer with a `require`-adjacent context, not a sandboxed browser tab.
 *
 * AN ALLOWLIST, of what the engine actually emits: the elements and attributes in dvi2html's own
 * templates and in pgf's SVG driver (pgfsys-common-svg.def, which the format's pgfsys-ximera.def
 * loads), checked against every output of `npm run smoke`. It used to be a denylist — script,
 * foreignObject, on*, external hrefs — and a denylist is a list of the attacks someone thought of.
 * It let through a <style> that restyles the whole page, XHTML <img> and <embed> that load what
 * they like, and `fill="url(https://…)"`. Those matter more than in a browser tab, because the
 * stored template is mounted with createContextualFragment into an HTML document: the HTML parser
 * re-reads what the XML parser accepted, and the two disagree about where some markup ends.
 *
 * Removal is deliberately not silent. The list returned here becomes the "removed active content
 * from this diagram" chip under the mounted block (svg/stages.ts, block/render-child.ts), so someone
 * with a legitimate raw special learns why their markup vanished instead of filing a rendering bug.
 * Not a degradation: what is left is safe, and is stored with the chip.
 */

/** Elements and attributes we take out, in the shape the warning chip wants. */
export type RemovalKind =
	| 'script' //              <script>, in any namespace
	| 'foreign-object' //      <foreignObject>: an HTML subtree inside the SVG
	| 'element' //             any other element the engine never emits, or one outside the SVG namespace
	| 'markup' //              a comment or processing instruction
	| 'event-handler' //       on*= — onload, onclick, onbegin, …
	| 'external-reference' //  href, xlink:href or url() that leaves the document
	| 'attribute'; //          an attribute or style property the engine never emits, or an unsafe value

export interface SanitizerRemoval {
	kind: RemovalKind;
	/** Human-readable, bounded: `<script>`, `onload=`, `href="javascript:alert(1)"`. */
	detail: string;
}

const ELEMENT_NODE = 1;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** A hostile payload can carry a megabyte in one attribute; the chip and the log take a snippet. */
const DETAIL_MAX = 80;

/**
 * Every SVG element a diagram can need, matched on `localName` in the SVG namespace only.
 *
 * What the engine emits — svg, g, path, rect, circle, text, use, clipPath, the gradients and stop,
 * pattern, symbol, marker, mask, image (dvi2html's psfile special) and the SMIL elements of the
 * `animations` library — plus the plain shapes and text containers a hand-written raw special
 * reaches for, none of which can load or run anything. Left out on purpose: style, script,
 * foreignObject, filter and its primitives (feImage loads URLs), cursor, view, switch, metadata,
 * and anything in another namespace: an XHTML <img> or <embed> breaks out of the <svg> when the
 * HTML parser reads the stored template, and lands as a live HTML element.
 */
const ELEMENTS: ReadonlySet<string> = new Set([
	'svg',
	'g',
	'defs',
	'symbol',
	'use',
	'title',
	'desc',
	'a',
	'image',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
	'tspan',
	'textPath',
	'linearGradient',
	'radialGradient',
	'stop',
	'pattern',
	'clipPath',
	'mask',
	'marker',
	'animate',
	'animateTransform',
	'animateMotion',
	'set',
	'mpath',
]);

/**
 * <title> and <desc> are HTML integration points: the HTML parser reads an element inside them as
 * HTML, not SVG. Text is all they ever hold here, so an element inside one goes.
 */
const TEXT_ONLY: ReadonlySet<string> = new Set(['title', 'desc']);

/**
 * The presentation properties: allowed as attributes, and the only properties kept inside a
 * `style` attribute. Their values are CSS, so each one is checked by `cssVerdict` as well.
 *
 * `cursor` is absent (it loads an image), and so is every layout property: `position: fixed` on a
 * root <svg> replayed from the legacy cache would lay the diagram over the whole window.
 */
const PRESENTATION: ReadonlySet<string> = new Set([
	'alignment-baseline',
	'baseline-shift',
	'clip',
	'clip-path',
	'clip-rule',
	'color',
	'color-interpolation',
	'color-rendering',
	'direction',
	'display',
	'dominant-baseline',
	'fill',
	'fill-opacity',
	'fill-rule',
	'filter',
	'font',
	'font-family',
	'font-size',
	'font-size-adjust',
	'font-stretch',
	'font-style',
	'font-variant',
	'font-weight',
	'image-rendering',
	'letter-spacing',
	'marker',
	'marker-end',
	'marker-mid',
	'marker-start',
	'mask',
	'opacity',
	'overflow',
	'paint-order',
	'pointer-events',
	'shape-rendering',
	'stop-color',
	'stop-opacity',
	'stroke',
	'stroke-dasharray',
	'stroke-dashoffset',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-miterlimit',
	'stroke-opacity',
	'stroke-width',
	'text-anchor',
	'text-decoration',
	'text-rendering',
	'transform',
	'transform-origin',
	'unicode-bidi',
	'vector-effect',
	'visibility',
	'word-spacing',
	'writing-mode',
]);

/**
 * Attributes whose values are CSS too, though they are not presentation attributes: the other
 * transforms, and the SMIL values, which can animate any presentation attribute to anything —
 * `<set attributeName="fill" to="url(https://…)">` included.
 */
const CSS_VALUED: ReadonlySet<string> = new Set([
	'gradientTransform',
	'patternTransform',
	'values',
	'from',
	'to',
	'by',
]);

/** Non-presentation attributes in no namespace: geometry, references, units and SMIL timing. */
const PLAIN: ReadonlySet<string> = new Set([
	'id',
	'class',
	'style',
	'lang',
	'href',
	'version',
	'viewBox',
	'preserveAspectRatio',
	'x',
	'y',
	'x1',
	'y1',
	'x2',
	'y2',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'fx',
	'fy',
	'fr',
	'd',
	'points',
	'width',
	'height',
	'pathLength',
	'dx',
	'dy',
	'rotate',
	'textLength',
	'lengthAdjust',
	'startOffset',
	'method',
	'spacing',
	'offset',
	'gradientUnits',
	'spreadMethod',
	'patternUnits',
	'patternContentUnits',
	'clipPathUnits',
	'maskUnits',
	'maskContentUnits',
	'markerUnits',
	'markerWidth',
	'markerHeight',
	'refX',
	'refY',
	'orient',
	'attributeName',
	'attributeType',
	'begin',
	'dur',
	'end',
	'min',
	'max',
	'restart',
	'repeatCount',
	'repeatDur',
	'calcMode',
	'keyTimes',
	'keySplines',
	'keyPoints',
	'additive',
	'accumulate',
	'type',
	'path',
	'origin',
	'role',
	'aria-label',
	'aria-hidden',
]);

/**
 * The CSS functions a value may call. Colours, and the transforms dvi2html and pgf write; `url` is
 * allowed only with a same-document target. Everything else is refused rather than understood:
 * image-set(), cross-fade(), image(), element() and src() all load images without saying url(,
 * and a function this list has never heard of is one this stage cannot vouch for.
 */
const CSS_FUNCTIONS: ReadonlySet<string> = new Set([
	'url',
	'rgb',
	'rgba',
	'hsl',
	'hsla',
	'matrix',
	'translate',
	'scale',
	'rotate',
	'skewx',
	'skewy',
]);

export function sanitizeSvg(doc: XMLDocument): SanitizerRemoval[] {
	const removed: SanitizerRemoval[] = [];
	const root = doc.documentElement as Element | undefined;
	if (root) sanitizeElement(root, removed);
	return removed;
}

function sanitizeElement(el: Element, removed: SanitizerRemoval[]): void {
	sanitizeAttributes(el, removed);

	// Snapshot: childNodes is live, and removing a child during iteration skips its sibling.
	const children: Node[] = [];
	for (let i = 0; i < el.childNodes.length; i++) {
		const node = el.childNodes[i];
		if (node) children.push(node);
	}

	for (const child of children) {
		if (child.nodeType === COMMENT_NODE || child.nodeType === PROCESSING_INSTRUCTION_NODE) {
			// Not decoration to the HTML parser that mounts the template. XML ends a comment only at
			// `-->`, HTML also at `<!-->`, so `<!--><img src=x onerror=…>-->` is one inert comment to
			// the parser that read the engine's output and a live <img> to the one that mounts it.
			// HTML reads `<?…` as a comment ending at the first `>`, which a processing instruction's
			// data may contain. The engine emits neither. A CDATA section stays: both parsers end it at
			// the same `]]>`, which its own content cannot contain.
			removed.push({ kind: 'markup', detail: clip(describeMarkup(child)) });
			el.removeChild(child);
			continue;
		}
		if (child.nodeType !== ELEMENT_NODE) continue;

		const element = child as Element;
		const finding = TEXT_ONLY.has(el.localName)
			? { kind: 'element' as const, detail: clip(`<${element.localName}>`) }
			: forbiddenElement(element);
		if (finding) {
			// Do not descend: everything inside goes with it, and reporting the on* handlers of a
			// node that no longer exists would bury the one removal that matters in noise.
			removed.push(finding);
			element.remove();
			continue;
		}
		sanitizeElement(element, removed);
	}
}

/**
 * Matched on `localName` and namespace, not on a CSS selector or `tagName`. An XML document is
 * case-sensitive and namespace-aware: `querySelectorAll('script')` misses an HTML-namespaced
 * <script> smuggled in through a raw special, and `tagName` carries whatever prefix the payload
 * chose.
 */
function forbiddenElement(el: Element): SanitizerRemoval | null {
	if (el.localName === 'script') return { kind: 'script', detail: clip(`<${el.localName}>`) };
	if (el.localName === 'foreignObject') {
		return { kind: 'foreign-object', detail: clip(`<${el.localName}>`) };
	}
	if (el.namespaceURI !== SVG_NS || !ELEMENTS.has(el.localName)) {
		return { kind: 'element', detail: clip(`<${el.localName}>`) };
	}

	if (isAnimation(el.localName)) {
		// SMIL animation elements are not active content in themselves, but `attributeName` lets one
		// *write* an attribute this stage refused to accept: `<a href="#x"><set
		// attributeName="xlink:href" to="javascript:alert(1)"/></a>` is the classic SVG payload, and
		// `<animate attributeName="onload" …>` the same trick against the handler rule. The value
		// is in `to`/`values`/`from`/`by`, which name no attribute, so the element goes.
		// `attributeName` is a QName, so `xlink:href` and `href` name the same target; nothing TeX
		// emits animates either.
		const target = (el.getAttribute('attributeName') ?? '').trim();
		const local = target.slice(target.indexOf(':') + 1);
		const detail = clip(`<${el.localName} attributeName="${target}">`);
		if (isEventHandler(local)) return { kind: 'event-handler', detail };
		if (local.toLowerCase() === 'href') return { kind: 'external-reference', detail };
	}

	return null;
}

function isAnimation(localName: string): boolean {
	return (
		localName === 'animate' ||
		localName === 'animateTransform' ||
		localName === 'animateMotion' ||
		localName === 'set'
	);
}

function sanitizeAttributes(el: Element, removed: SanitizerRemoval[]): void {
	// Same live-collection hazard as childNodes: removing an attribute shifts the NamedNodeMap.
	const attrs: Attr[] = [];
	for (let i = 0; i < el.attributes.length; i++) {
		const attr = el.attributes[i];
		if (attr) attrs.push(attr);
	}

	for (const attr of attrs) {
		const finding = attributeFinding(attr);
		if (finding) {
			removeAttr(el, attr);
			removed.push(finding);
			continue;
		}
		if (attr.namespaceURI === null && attr.localName === 'style') {
			const styleFinding = sanitizeStyle(el, attr.value);
			if (styleFinding) removed.push(styleFinding);
		}
	}
}

function attributeFinding(attr: Attr): SanitizerRemoval | null {
	const name = attr.localName;
	const ns = attr.namespaceURI;

	if (isEventHandler(name)) {
		// The NAME is clipped too, not only the value: nothing bounds an attribute name in XML,
		// and this string is persisted in `Artifact.warn` and replayed into the degraded chip.
		return { kind: 'event-handler', detail: clip(`${attr.name}=`) };
	}

	// Namespace declarations are how the document says what it is; xml:space and xml:lang are inert.
	// Those two are matched on the qualified name: the `xml` prefix is bound by definition, and not
	// every DOM records the namespace for it (happy-dom leaves it null).
	if (ns === XMLNS_NS) return null;
	const xmlInert = attr.name === 'xml:space' || attr.name === 'xml:lang';
	if (xmlInert && (ns === XML_NS || ns === null)) return null;

	// `href` and `xlink:href` are the same attribute to a renderer.
	if (name === 'href' && (ns === null || ns === XLINK_NS)) {
		if (isSameDocumentFragment(attr.value)) return null;
		return { kind: 'external-reference', detail: clip(`${attr.name}="${attr.value}"`) };
	}

	if (ns !== null || !(PLAIN.has(name) || PRESENTATION.has(name) || CSS_VALUED.has(name))) {
		return { kind: 'attribute', detail: clip(`${attr.name}="${attr.value}"`) };
	}

	if (PRESENTATION.has(name) || CSS_VALUED.has(name)) {
		const verdict = cssVerdict(attr.value);
		if (verdict === 'external') {
			return { kind: 'external-reference', detail: clip(`${attr.name}="${attr.value}"`) };
		}
		if (verdict === 'unsafe') return { kind: 'attribute', detail: clip(`${attr.name}="${attr.value}"`) };
	}
	return null;
}

/**
 * Keep the presentation declarations of a `style` attribute whose values are safe, and drop the
 * rest. pgf writes exactly one shape here — `fill:url(#pgfsh2); stroke:none` for a shading — so a
 * style with nothing to remove is left byte for byte as it was.
 */
function sanitizeStyle(el: Element, style: string): SanitizerRemoval | null {
	const kept: string[] = [];
	let external = false;
	let changed = false;

	for (const declaration of splitDeclarations(style)) {
		if (declaration.trim() === '') continue;
		const colon = declaration.indexOf(':');
		const property = colon < 0 ? '' : declaration.slice(0, colon).trim().toLowerCase();
		const verdict = PRESENTATION.has(property) ? cssVerdict(declaration.slice(colon + 1)) : 'unsafe';
		if (verdict === 'safe') {
			kept.push(declaration.trim());
			continue;
		}
		if (verdict === 'external') external = true;
		changed = true;
	}

	if (!changed) return null;
	if (kept.length === 0) el.removeAttribute('style');
	else el.setAttribute('style', kept.join('; '));
	return { kind: external ? 'external-reference' : 'attribute', detail: clip(`style="${style}"`) };
}

/**
 * Whether a CSS value can only paint, or might also load something.
 *
 * A value with no parenthesis calls no function, so it can reference nothing: a colour, a length,
 * a keyword. Otherwise every function in it must be one of `CSS_FUNCTIONS`, and every `url()` must
 * point into this document. The function name is the identifier right before its parenthesis, so
 * `url` split by a comment is refused under the name `l`, which errs the safe way: CSS would not
 * read it as url( at all.
 *
 * A backslash anywhere refuses the value outright. A CSS escape spells any name without its letters
 * appearing (`\75 rl(` is `url(`), and no number, colour or transform the engine writes has one.
 */
function cssVerdict(value: string): 'safe' | 'external' | 'unsafe' {
	if (value.indexOf('(') < 0) return 'safe';
	if (value.indexOf('\\') >= 0) return 'unsafe';

	for (let open = value.indexOf('('); open >= 0; open = value.indexOf('(', open + 1)) {
		let start = open;
		while (start > 0 && isNameChar(value.charAt(start - 1))) start--;
		const name = value.slice(start, open).toLowerCase();

		// A bare parenthesis opens no function — nothing the engine writes has one, but it fetches
		// nothing either.
		if (name === '') continue;
		if (!CSS_FUNCTIONS.has(name)) return 'unsafe';
		if (name !== 'url') continue;

		const close = closingParen(value, open + 1);
		if (close < 0) return 'unsafe';
		if (!isSameDocumentFragment(unquote(value.slice(open + 1, close).trim()))) return 'external';
	}
	return 'safe';
}

function isNameChar(ch: string): boolean {
	return /[A-Za-z0-9_-]/.test(ch);
}

/** The `)` that closes a `url(`, skipping one inside quotes, or -1 if the value never closes it. */
function closingParen(value: string, from: number): number {
	let quote = '';
	for (let i = from; i < value.length; i++) {
		const ch = value.charAt(i);
		if (quote !== '') {
			if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ')') {
			return i;
		}
	}
	return -1;
}

function unquote(value: string): string {
	const first = value.charAt(0);
	if ((first === '"' || first === "'") && value.length >= 2 && value.charAt(value.length - 1) === first) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * No SVG presentation or geometry attribute begins with "on", so the prefix test needs no
 * allowlist beside it. Case-insensitive because an XML attribute name is case-sensitive to the
 * parser but an HTML-namespaced node smuggled in through a raw special is not.
 */
function isEventHandler(localName: string): boolean {
	return localName.length > 2 && localName.slice(0, 2).toLowerCase() === 'on';
}

/**
 * The one form of reference we keep: one into this very document. `xlink:href="#glyph1"` is how
 * every dvi2html <use> points at its glyph, and `url(#clip)` is how clip paths, masks, patterns and
 * gradients work.
 *
 * Leading whitespace is trimmed before the test because a renderer trims it too, which is what
 * makes `href=" javascript:…"` and `href="&#10;javascript:…"` work in the first place.
 */
function isSameDocumentFragment(value: string): boolean {
	const v = value.trim();
	return v.length > 0 && v[0] === '#' && !/\s/.test(v);
}

function describeMarkup(node: Node): string {
	if (node.nodeType === COMMENT_NODE) return `<!--${node.nodeValue ?? ''}-->`;
	return `<?${(node as ProcessingInstruction).target} ${node.nodeValue ?? ''}?>`;
}

function removeAttr(el: Element, attr: Attr): void {
	if (attr.namespaceURI === null) el.removeAttribute(attr.name);
	else el.removeAttributeNS(attr.namespaceURI, attr.localName);
}

function clip(value: string): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat;
}
