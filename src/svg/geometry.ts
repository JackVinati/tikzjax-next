/**
 * Geometry. See docs/DESIGN.md §7.4.
 *
 * dvi2html emits `width="Wpt" height="Hpt" viewBox="-72 -72 W H"`: the 1-inch DVI origin shift is
 * applied to the ORIGIN but not to the EXTENT, so the frame is systematically an inch short of the
 * ink and the right/bottom of every diagram is clipped (#66, #71, #29). There is no arithmetic fix
 * — the paper size is not the ink size — so the correction is a measured bounding box applied here.
 *
 * Everything in this file is arithmetic on strings and numbers. The one DOM measurement in the
 * plugin lives in svg/measure.ts; this module only consumes its result, which is what lets every
 * mount after the first (and every export) be pure.
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A parsed `viewBox`, in user units. */
export type ViewBox = Rect;

/** A measured ink bounding box, in the same user units as the document's `viewBox`. */
export type InkBounds = Rect;

/**
 * Decimal places kept when writing a number back.
 *
 * The engine's own numbers carry far fewer, and a `viewBox` written as `12.000000000000002` both
 * bloats every cached artifact and makes golden comparisons flaky.
 */
const PRECISION = 5;

/**
 * Parse a `viewBox` value. Returns null for anything that is not four finite numbers with a
 * non-negative extent — a negative width or height is an error per the SVG spec, and treating it
 * as data would let a malformed document propagate into the cached artifact.
 */
export function parseViewBox(value: string | null | undefined): ViewBox | null {
	if (value === null || value === undefined) return null;

	const numbers: number[] = [];
	for (const part of value.split(/[\s,]+/)) {
		if (part === '') continue;
		const n = Number(part);
		if (!Number.isFinite(n)) return null;
		numbers.push(n);
	}
	if (numbers.length !== 4) return null;

	const [x, y, width, height] = numbers;
	if (x === undefined || y === undefined || width === undefined || height === undefined)
		return null;
	if (width < 0 || height < 0) return null;
	return { x, y, width, height };
}

export function formatViewBox(box: ViewBox): string {
	return (
		formatNumber(box.x) +
		' ' +
		formatNumber(box.y) +
		' ' +
		formatNumber(box.width) +
		' ' +
		formatNumber(box.height)
	);
}

/**
 * Rewrite `viewBox`, `width` and `height` from a measured ink bounding box.
 *
 * `width`/`height` are rescaled rather than replaced, so the diagram keeps the physical size it
 * had: only the frame moves. The scale comes from the document's own `viewBox`, which for the
 * engine's output is 1 user unit = 1 pt.
 *
 * Throws on a bounding box that cannot be trusted. The caller (§7.4) must then mount with the
 * engine's `viewBox` and re-measure on the next mount: the corrected box is PERSISTED into the
 * artifact and is an output, not a key input, so no later input change would ever invalidate a
 * bad one. A cache that poisons itself is worse than no cache.
 */
export function applyInkBounds(doc: Document, bbox: InkBounds): void {
	// `documentElement` is typed non-nullable, but a parse failure elsewhere in the pipeline can
	// still hand us a document without one, and this runs inside a try/catch that turns a thrown
	// error into a named degradation rather than a crash.
	const root = doc.documentElement as Element | undefined;
	if (root === undefined || root.localName !== 'svg') {
		throw new Error('applyInkBounds: the document root is not <svg>');
	}
	if (!isUsableBounds(bbox)) {
		throw new RangeError(
			`applyInkBounds: refusing a degenerate bounding box ` +
				`${bbox.x},${bbox.y} ${bbox.width}x${bbox.height}`,
		);
	}

	const current = parseViewBox(root.getAttribute('viewBox'));
	rewriteExtent(root, 'width', bbox.width, current === null ? undefined : current.width);
	rewriteExtent(root, 'height', bbox.height, current === null ? undefined : current.height);
	root.setAttribute('viewBox', formatViewBox(bbox));
}

/**
 * A zero-area box means the measurement found no ink (a `display:none` ancestor, or fonts that had
 * not resolved). Writing it would collapse the diagram to nothing, which looks exactly like the
 * blank-render bug this whole module exists to fix.
 */
function isUsableBounds(bbox: InkBounds): boolean {
	return (
		Number.isFinite(bbox.x) &&
		Number.isFinite(bbox.y) &&
		Number.isFinite(bbox.width) &&
		Number.isFinite(bbox.height) &&
		bbox.width > 0 &&
		bbox.height > 0
	);
}

function rewriteExtent(
	root: Element,
	attribute: 'width' | 'height',
	inkExtent: number,
	viewBoxExtent: number | undefined,
): void {
	const length = parseLength(root.getAttribute(attribute));
	// No attribute means the SVG already sizes itself from its viewBox and its container; adding
	// one would change the layout rather than correct the frame.
	if (length === null) return;
	// A percentage extent is resolved against the CONTAINER, not against the document's user
	// units, so there is no scale that relates it to the ink box — rescaling `width="100%"` by the
	// viewBox ratio would shrink the diagram to a fraction of its box. Such a document already
	// sizes itself, exactly like one with no attribute at all; only the frame needs correcting.
	if (length.unit === '%') return;

	// The identity fallback is not a guess: the engine writes `width="Wpt"` against
	// `viewBox="-72 -72 W H"`, so one user unit is one point unless something downstream (SVGO,
	// an author's edit) has already rescaled the document and left us a viewBox to read.
	const scale =
		viewBoxExtent !== undefined && viewBoxExtent > 0 ? length.value / viewBoxExtent : 1;
	root.setAttribute(attribute, formatNumber(inkExtent * scale) + length.unit);
}

export function parseLength(
	value: string | null | undefined,
): { value: number; unit: string } | null {
	if (value === null || value === undefined) return null;
	const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
	if (match === null) return null;
	const [, digits, unit] = match;
	if (digits === undefined) return null;
	const n = Number(digits);
	if (!Number.isFinite(n)) return null;
	return { value: n, unit: unit === undefined ? '' : unit };
}

/**
 * Fixed-point, then trailing zeros trimmed by hand.
 *
 * `String.prototype.replace` with a regex is exactly the shape #48 broke (a plugin replaced
 * `String.prototype.replaceAll` with one that stringified its RegExp argument), and this runs on
 * every mount, so the trimming is index arithmetic instead.
 */
export function formatNumber(n: number): string {
	if (!Number.isFinite(n)) return '0';

	const fixed = n.toFixed(PRECISION);
	let end = fixed.length;
	if (fixed.indexOf('.') >= 0) {
		while (end > 0 && fixed.charAt(end - 1) === '0') end--;
		if (end > 0 && fixed.charAt(end - 1) === '.') end--;
	}
	const trimmed = fixed.slice(0, end);
	// `(-0.0000001).toFixed(5)` is "-0.00000"; the trim above leaves "-0", which is legal SVG but
	// compares unequal to "0" in every golden fixture.
	return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}
