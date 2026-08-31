/**
 * Stage 3 of the SVG pipeline, plus the mount-time counterpart. See docs/DESIGN.md §7.2.
 *
 * dvi2html numbers its ids from zero per run, so the same diagram rendered in two panes emits
 * byte-identical ids. `url(#g0)` then resolves to whichever copy the browser parsed first, and the
 * second one loses its clip paths, gradients and glyph <use>s — upstream #12. Storing ids in the
 * artifact at all is therefore wrong; the artifact stores placeholders and each *mount* stamps its
 * own nonce over them.
 *
 * This stage always runs, including under `raw` and on a degraded mount. An artifact without
 * placeholders is not merely unoptimised, it is a collision waiting for the second pane.
 */

/** The placeholder infix. `__TZ__0` … `__TZ__n`, in document order. */
export const ID_TOKEN = '__TZ__';

/** A nonce must be safe inside both an `id` and a `url(#…)`, so no dots, colons or spaces. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * `url(#id)`, with optional quotes and whitespace, as it appears in a paint attribute *and* inside
 * a `style` declaration — `fill="url(#g)"` and `style="fill:url(#g)"` are the same reference and
 * both must be swept, which is the half of this that the shipped plugin never had.
 */
const URL_REF = /url\(\s*(["']?)#([^"'()\s]+)\1\s*\)/g;

/** A `href`/`xlink:href` pointing into this document. Anything else was removed by sanitize. */
const FRAGMENT_REF = /^#(\S+)$/;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

/**
 * Thrown when the document already contains the placeholder token, which would make stamping
 * corrupt content it does not own. The caller's recovery (§7.2) is to retry with a random token
 * and store it in the record, which is why the token is a parameter rather than a constant here —
 * generating one would need randomness, and this module stays pure.
 */
export class IdTokenCollisionError extends Error {
	readonly token: string;

	constructor(token: string, where: string) {
		super(`the id placeholder token ${token} already occurs in the SVG (${where})`);
		this.token = token;
		this.name = 'IdTokenCollisionError';
	}
}

/**
 * Rewrite every `id` to `<token>n` and sweep every reference to it.
 *
 * Dangling references — `url(#gone)` naming an id no element carries — are left exactly as they
 * are. Pointing them at a placeholder would invent a target; leaving them alone keeps the diagram
 * as broken as the engine made it, which is the honest outcome and a far easier bug to find.
 */
export function placeholderIds(doc: XMLDocument, token: string = ID_TOKEN): void {
	const root = doc.documentElement as Element | undefined;
	if (!root) return;

	const elements: Element[] = [];
	collect(root, elements, token);

	// Old id -> placeholder. Duplicate ids in the source (which is exactly the #12 symptom) each
	// get their own unique placeholder so the document stays well-formed, but references keep
	// resolving to the first one, as they did before this stage ran.
	const map = new Map<string, string>();
	let n = 0;
	for (const el of elements) {
		const id = el.getAttribute('id');
		if (id === null) continue;
		const placeholder = `${token}${n++}`;
		el.setAttribute('id', placeholder);
		if (!map.has(id)) map.set(id, placeholder);
	}

	if (map.size === 0) return;

	for (const el of elements) {
		sweepAttributes(el, map);
		// <style> is not something dvi2html emits, but SVGO and a raw special both can, and a rule
		// body carries `url(#…)` just like an attribute does. CSS id *selectors* are deliberately
		// not rewritten: `#fff` in a `fill:` is a colour, and no id-vs-colour heuristic is worth
		// the corruption it would cause on the miss.
		if (el.localName === 'style') sweepStyleElement(el, map);
	}
}

/**
 * Stamp a per-mount nonce over a stored template. This is the hot path: once per mount, on every
 * pane, on every reopen of a note.
 */
export function stampIds(template: string, nonce: string, token: string = ID_TOKEN): string {
	if (!NONCE_PATTERN.test(nonce)) {
		throw new Error(`unsafe id nonce ${JSON.stringify(nonce)}; expected [A-Za-z0-9_-]+`);
	}

	// Computed ONCE, before the replace. A function replacer would be evaluated per match, so a
	// definition and its reference could receive different nonces — breaking every clip path,
	// mask, marker and gradient in the diagram, which is the exact bug this stage exists to fix.
	// Leading letter because an id may not begin with a digit.
	const replacement = `t${nonce}_`;
	return replaceLiteral(template, token, replacement);
}

/**
 * Literal replace-all without `String.prototype.replaceAll`.
 *
 * Pretty BibTeX 2.0.0 monkey-patched `replaceAll` to stringify a RegExp argument and silently
 * killed rendering plugin-wide with no error anywhere (upstream #48). Nothing on this path may
 * depend on a String prototype method a third-party plugin can redefine.
 */
function replaceLiteral(haystack: string, needle: string, replacement: string): string {
	if (needle.length === 0) return haystack;

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

/**
 * One walk: gathers the elements and proves the token is not already in the document.
 *
 * The invariant that has to hold is not "no id contains the token" but "the token does not occur
 * anywhere in `serializeSvg(doc)`" — `stampIds` is a blind string pass over that whole string.
 * So every construct the serializer can emit is checked: element and attribute NAMES (`__TZ__x` is
 * a well-formed XML name, `_` being a name-start character), attribute values, text and CDATA, and
 * comments and processing instructions, which survive into the template because they sit inside the
 * root. A miss here does not corrupt an id, it silently rewrites markup this stage does not own.
 */
function collect(el: Element, out: Element[], token: string): void {
	out.push(el);

	if (el.nodeName.indexOf(token) !== -1) {
		throw new IdTokenCollisionError(token, `element name <${el.nodeName}>`);
	}

	for (let i = 0; i < el.attributes.length; i++) {
		const attr = el.attributes[i];
		if (!attr) continue;
		if (attr.name.indexOf(token) !== -1) {
			throw new IdTokenCollisionError(token, `attribute name ${attr.name} of <${el.localName}>`);
		}
		if (attr.value.indexOf(token) !== -1) {
			throw new IdTokenCollisionError(token, `${attr.name} of <${el.localName}>`);
		}
	}

	for (let i = 0; i < el.childNodes.length; i++) {
		const node = el.childNodes[i];
		if (!node) continue;
		if (node.nodeType === ELEMENT_NODE) {
			collect(node as Element, out, token);
		} else if (
			node.nodeType === TEXT_NODE ||
			node.nodeType === CDATA_SECTION_NODE ||
			node.nodeType === COMMENT_NODE ||
			node.nodeType === PROCESSING_INSTRUCTION_NODE
		) {
			// Text matters too: stamping is a blind string pass over the serialized template, so a
			// node label reading `__TZ__` would be rewritten into someone else's id space.
			if ((node.nodeValue ?? '').indexOf(token) !== -1) {
				throw new IdTokenCollisionError(token, `child node of <${el.localName}>`);
			}
			if (node.nodeName.indexOf(token) !== -1) {
				throw new IdTokenCollisionError(token, `node name ${node.nodeName} in <${el.localName}>`);
			}
		}
	}
}

function sweepAttributes(el: Element, map: ReadonlyMap<string, string>): void {
	for (let i = 0; i < el.attributes.length; i++) {
		const attr = el.attributes[i];
		if (!attr) continue;
		if (attr.localName === 'id') continue;

		let next = attr.value;

		// href/xlink:href — <use xlink:href="#glyph">, <textPath href="#p">, gradient inheritance.
		if (attr.localName === 'href') next = rewriteFragment(next, map);

		// Every other reference form is a url(#…): clip-path, mask, filter, marker-start/mid/end,
		// fill, stroke, and the same names again inside `style`. Sweeping by value rather than by
		// an attribute allowlist means a form we did not enumerate is still covered.
		if (next.indexOf('url(') !== -1) next = rewriteUrlRefs(next, map);

		if (next !== attr.value) attr.value = next;
	}
}

function sweepStyleElement(el: Element, map: ReadonlyMap<string, string>): void {
	const css = el.textContent ?? '';
	if (css.indexOf('url(') === -1) return;
	const next = rewriteUrlRefs(css, map);
	if (next !== css) el.textContent = next;
}

/**
 * A function replacer is fine here and not a contradiction of `stampIds`: this runs once per
 * render, and the mapping it consults is fixed before the first call, so every occurrence of one
 * id resolves to the same placeholder.
 */
function rewriteUrlRefs(value: string, map: ReadonlyMap<string, string>): string {
	return value.replace(URL_REF, (match: string, quote: string, id: string) => {
		const next = map.get(id);
		return next === undefined ? match : `url(${quote}#${next}${quote})`;
	});
}

function rewriteFragment(value: string, map: ReadonlyMap<string, string>): string {
	const m = FRAGMENT_REF.exec(value);
	const id = m?.[1];
	if (id === undefined) return value;
	const next = map.get(id);
	return next === undefined ? value : `#${next}`;
}
