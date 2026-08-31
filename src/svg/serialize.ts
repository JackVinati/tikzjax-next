import { TexError } from '../types';

/**
 * The single DOMParser / XMLSerializer boundary. See docs/DESIGN.md §7.2, stages 1 and 6.
 *
 * Every other module in src/svg/ takes an already-parsed document and mutates it, which is what
 * keeps them pure enough to unit-test and cheap enough to chain: the engine's SVG is parsed once
 * per render, not once per stage. Nothing outside this file may call DOMParser, XMLSerializer,
 * innerHTML or outerHTML — the shipped plugin assigns the engine's string straight into
 * `innerHTML`, which is how a `dvisvgm:raw` payload becomes live markup (§2.2 defect 17).
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Why a parse was rejected. Kept separate from the message so hints can switch on it. */
export type SvgParseFailure =
	| 'empty' //         the engine returned nothing at all
	| 'parsererror' //   the XML parser produced its error document
	| 'not-svg'; //      it parsed, but the root is not <svg>

/**
 * A parse failure, typed as `empty-output` because that is what it means to the user: TeX ran and
 * no diagram came out. Extending TexError rather than inventing a parallel taxonomy means the
 * error card, the log capture and the poison set all handle it with no special case.
 */
export class SvgParseError extends TexError {
	readonly reason: SvgParseFailure;

	constructor(reason: SvgParseFailure, detail: string) {
		super('empty-output', [], detail, undefined, `SVG parse failed (${reason}): ${detail}`);
		this.reason = reason;
		this.name = 'SvgParseError';
	}
}

/**
 * Parse the engine's SVG string.
 *
 * `parseFromString` never throws: on malformed XML it returns a *document describing the error*,
 * so the only way to notice is to look for it. Browsers disagree about where that element lands —
 * Chrome roots an XHTML `<parsererror>`, Firefox roots one in its own namespace, WebKit and
 * happy-dom nest it inside the partial tree — so we accept a match anywhere. The cost is that a
 * diagram legitimately containing an element named `parsererror` is rejected; nothing TeX emits
 * ever is, and a payload that smuggles one in has nothing to gain.
 */
export function parseSvg(text: string): XMLDocument {
	if (text.trim().length === 0) {
		throw new SvgParseError('empty', 'the engine produced no output');
	}

	const doc = new DOMParser().parseFromString(text, 'image/svg+xml');

	// lib.dom types documentElement as non-nullable. A failed parse genuinely can leave it unset,
	// and reading `.localName` off undefined here would mask the real error with a TypeError.
	const root = doc.documentElement as Element | undefined;
	if (!root) {
		throw new SvgParseError('parsererror', 'the parser produced no root element');
	}

	if (root.localName === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
		throw new SvgParseError('parsererror', firstLine(errorText(doc)));
	}

	// The NAMESPACE is checked, not just the name. `<svg>` with no `xmlns` parses fine as XML and
	// its root is still called "svg", but it is an element in no namespace: a renderer draws
	// nothing and reports nothing. Accepting it would store a blank diagram as the artifact and
	// replay it forever — the silent-blank failure this pipeline exists to make impossible. Reachable
	// from the L3 legacy read-through, which replays whatever string the old plugin stored.
	if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
		throw new SvgParseError('not-svg', describeRoot(root));
	}

	return doc;
}

/**
 * Serialize the `<svg>` element, not the document.
 *
 * Serializing the document would carry along anything sitting beside the root — comments, a
 * processing instruction, an XML declaration in some engines — into a string that is then stored
 * as the artifact template and stamped at every later mount. The template is exactly one element.
 */
export function serializeSvg(doc: XMLDocument): string {
	const root = doc.documentElement as Element | undefined;
	if (!root) {
		throw new SvgParseError('empty', 'the document has no root element to serialize');
	}
	return new XMLSerializer().serializeToString(root);
}

function describeRoot(root: Element): string {
	if (root.namespaceURI === null) {
		return `root element <${root.localName}> is in no namespace; expected xmlns="${SVG_NS}"`;
	}
	return `root element is <${root.localName}> in ${root.namespaceURI}, expected <svg> in ${SVG_NS}`;
}

function errorText(doc: Document): string {
	const el = doc.getElementsByTagName('parsererror')[0];
	const text = el?.textContent ?? '';
	return text.trim().length > 0 ? text.trim() : 'malformed XML';
}

/** The parser's error document is a multi-line HTML blob; an error card holds one line. */
function firstLine(text: string): string {
	const nl = text.indexOf('\n');
	const line = nl === -1 ? text : text.slice(0, nl);
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
