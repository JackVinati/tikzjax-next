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
 * Removal is deliberately not silent. The list returned here drives the "removed active content
 * from this diagram" chip on a MOUNTED(degraded) block, so someone with a legitimate raw special
 * learns why their markup vanished instead of filing a rendering bug.
 */

/** Elements and attributes we take out, in the shape the warning chip wants. */
export type RemovalKind =
	| 'script' //              <script>, in any namespace
	| 'foreign-object' //      <foreignObject>: an HTML subtree inside the SVG
	| 'event-handler' //       on*= — onload, onclick, onbegin, …
	| 'external-reference'; // href/xlink:href that leaves the document

export interface SanitizerRemoval {
	kind: RemovalKind;
	/** Human-readable, bounded: `<script>`, `onload=`, `href="javascript:alert(1)"`. */
	detail: string;
}

const ELEMENT_NODE = 1;

/** A hostile payload can carry a megabyte in one attribute; the chip and the log take a snippet. */
const DETAIL_MAX = 80;

export function sanitizeSvg(doc: XMLDocument): SanitizerRemoval[] {
	const removed: SanitizerRemoval[] = [];
	const root = doc.documentElement as Element | undefined;
	if (root) sanitizeElement(root, removed);
	return removed;
}

function sanitizeElement(el: Element, removed: SanitizerRemoval[]): void {
	sanitizeAttributes(el, removed);

	// Snapshot: childNodes is live, and removing a child during iteration skips its sibling.
	const children: Element[] = [];
	for (let i = 0; i < el.childNodes.length; i++) {
		const node = el.childNodes[i];
		if (node && node.nodeType === ELEMENT_NODE) children.push(node as Element);
	}

	for (const child of children) {
		const finding = forbiddenElement(child);
		if (finding) {
			// Do not descend: everything inside goes with it, and reporting the on* handlers of a
			// node that no longer exists would bury the one removal that matters in noise.
			removed.push(finding);
			child.remove();
			continue;
		}
		sanitizeElement(child, removed);
	}
}

/**
 * SMIL animation elements. Not active content in themselves, but `attributeName` lets one *write*
 * an attribute we just refused to accept: `<a href="#x"><set attributeName="xlink:href"
 * to="javascript:alert(1)"/></a>` is the classic SVG payload, and `<animate attributeName="onload"
 * …>` the same trick against the handler rule. Removing only the element's own attributes leaves
 * the payload in `to`/`values`/`from`/`by`, so the element goes.
 */
const ANIMATION_ELEMENTS: ReadonlySet<string> = new Set([
	'animate',
	'animateTransform',
	'animateMotion',
	'set',
]);

/**
 * Matched on `localName`, not on a CSS selector or `tagName`. An XML document is case-sensitive and
 * namespace-aware: `querySelectorAll('script')` misses an HTML-namespaced <script> smuggled in
 * through a raw special, and `tagName` carries whatever prefix the payload chose.
 */
function forbiddenElement(el: Element): SanitizerRemoval | null {
	if (el.localName === 'script') return { kind: 'script', detail: clip(`<${el.localName}>`) };
	if (el.localName === 'foreignObject') {
		return { kind: 'foreign-object', detail: clip(`<${el.localName}>`) };
	}

	if (ANIMATION_ELEMENTS.has(el.localName)) {
		// `attributeName` is a QName, so `xlink:href` and `href` name the same target; nothing TeX
		// emits animates either, which is why this is an outright removal rather than a filter on
		// the animated values.
		const target = (el.getAttribute('attributeName') ?? '').trim();
		const local = target.slice(target.indexOf(':') + 1);
		const detail = clip(`<${el.localName} attributeName="${target}">`);
		if (isEventHandler(local)) return { kind: 'event-handler', detail };
		if (local.toLowerCase() === 'href') return { kind: 'external-reference', detail };
	}

	return null;
}

function sanitizeAttributes(el: Element, removed: SanitizerRemoval[]): void {
	// Same live-collection hazard as childNodes: removing an attribute shifts the NamedNodeMap.
	const attrs: Attr[] = [];
	for (let i = 0; i < el.attributes.length; i++) {
		const attr = el.attributes[i];
		if (attr) attrs.push(attr);
	}

	for (const attr of attrs) {
		const name = attr.localName;

		if (isEventHandler(name)) {
			removeAttr(el, attr);
			// The NAME is clipped too, not only the value: nothing bounds an attribute name in XML,
			// and this string is persisted in `Artifact.warn` and replayed into the degraded chip.
			removed.push({ kind: 'event-handler', detail: clip(`${attr.name}=`) });
			continue;
		}

		// Covers both `href` and `xlink:href`, which are the same attribute to a renderer.
		if (name === 'href' && !isSameDocumentFragment(attr.value)) {
			removeAttr(el, attr);
			removed.push({ kind: 'external-reference', detail: clip(`${attr.name}="${attr.value}"`) });
		}
	}
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
 * The one form we keep: a reference into this very document. `xlink:href="#glyph1"` is how every
 * dvi2html <use> points at its glyph, and `url(#clip)` — which lives in other attributes and is
 * left alone here — is how clip paths, masks and gradients work.
 *
 * Leading whitespace is trimmed before the test because a renderer trims it too, which is what
 * makes `href=" javascript:…"` and `href="&#10;javascript:…"` work in the first place.
 *
 * Not covered, deliberately: `url(http://…)` inside a paint or style attribute, which leaks a
 * request but cannot execute. It is left to the colour and id stages, which parse those values
 * anyway; duplicating a URL parser here would be a second place to get it wrong.
 */
function isSameDocumentFragment(value: string): boolean {
	const v = value.trim();
	return v.length > 0 && v[0] === '#' && !/\s/.test(v);
}

function removeAttr(el: Element, attr: Attr): void {
	if (attr.namespaceURI === null) el.removeAttribute(attr.name);
	else el.removeAttributeNS(attr.namespaceURI, attr.localName);
}

function clip(value: string): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat;
}
