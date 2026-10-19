import type { Rect } from './geometry';

/**
 * The box of what a mounted diagram shows, for the frame block/mount.ts measures (DESIGN.md §7.4).
 *
 * `getBBox()` on the root counts every shape whole: SVG defines the bounding box as geometry,
 * before clipping. pgfplots clips each plot to its axis, so a curve that runs past the axis, `x^2`
 * over a domain of -8:8 with `ymax=8`, made the frame as tall as the whole curve, 45 cm for an
 * axis of 10, and all of it empty but the axis (discussion #4). TikZ clips too, with `\clip`, and a
 * shading is clipped to its shape. Here the box of each clipped element is cut down to the box of
 * its clip path.
 *
 * Boxes, not shapes: a clip path is taken as its bounding box, which for pgf's, a rectangle round
 * an axis or the outline of a shape, is the region it lets through or a little more. The frame can
 * come out a little larger than what shows, never smaller.
 *
 * Only a subtree that has a clip path in it is walked. Every other one is measured whole, by the
 * browser's own `getBBox()`, so that a diagram without clipping is framed exactly as before.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Elements that draw nothing where they stand: definitions, and what other elements refer to. */
const NOT_DRAWN = new Set([
	'clipPath',
	'defs',
	'desc',
	'filter',
	'linearGradient',
	'marker',
	'mask',
	'metadata',
	'pattern',
	'radialGradient',
	'script',
	'style',
	'symbol',
	'title',
]);

/** Containers whose children are drawn in their place. */
const GROUPS = new Set(['a', 'g', 'switch']);

/** A 2D affine transform, as `DOMMatrix` and `SVGMatrix` carry it. */
interface Affine {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

/** Edges rather than an extent, which is what intersecting and joining need. */
interface Edges {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

type Measurable = Element & {
	getBBox(): { x: number; y: number; width: number; height: number };
	getScreenCTM(): Affine | null;
};

/**
 * The visible box of `svg`, in its own user units, as `getBBox()` gives its box. Null when it
 * cannot be measured now (not laid out, or not drawn); the caller measures on a later mount.
 */
export function visibleBox(svg: SVGSVGElement): Rect | null {
	let screen: Affine | null;
	try {
		screen = svg.getScreenCTM();
	} catch {
		return null;
	}
	const toRoot = screen ? invert(screen) : null;
	if (!toRoot) return null;

	const found: { box: Edges | null } = { box: null };
	walk(svg, svg, null, toRoot, found);
	const box = found.box;
	if (!box) return null;
	return { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

function walk(
	svg: SVGSVGElement,
	parent: Element,
	clip: Edges | null,
	toRoot: Affine,
	found: { box: Edges | null },
): void {
	for (const el of Array.from(parent.children)) {
		if (NOT_DRAWN.has(el.localName) || !measurable(el)) continue;
		if (el.getAttribute('display') === 'none') continue;

		let within = clip;
		if (el.hasAttribute('clip-path')) {
			const region = clipRegion(svg, el, toRoot);
			if (region) within = within ? meet(within, region) : region;
		}

		if (GROUPS.has(el.localName) && el.querySelector('[clip-path]') !== null) {
			walk(svg, el, within, toRoot, found);
			continue;
		}

		let box = boxOf(el, toRoot);
		if (!box) continue;
		// A group with nothing drawn in it measures as a point at its origin, which the browser
		// leaves out of the root's box, and so does this. pgf writes such groups: one round each
		// shading, at the picture's origin, left of and above the drawing.
		if (GROUPS.has(el.localName) && box.x0 === box.x1 && box.y0 === box.y1) continue;
		if (within) {
			box = meet(box, within);
			// Wholly outside its clip path: nothing of it shows.
			if (box.x1 < box.x0 || box.y1 < box.y0) continue;
		}
		found.box = found.box ? join(found.box, box) : box;
	}
}

/**
 * The box a clip path lets through, in the root's user units.
 *
 * A clip path is drawn in the user space of the element it clips, its own `transform` on top. The
 * shapes in it are measured where they would be drawn: copied into a hidden group put beside the
 * element, with the element's transform and the clip path's, and taken out again at once.
 * `getBBox()` does not measure a shape inside `<clipPath>` itself, which is never drawn, in every
 * engine.
 *
 * Null, which leaves the element unclipped, for a reference that names no clip path in this
 * diagram, and for `clipPathUnits="objectBoundingBox"`, which pgf does not write.
 */
function clipRegion(svg: SVGSVGElement, el: Element, toRoot: Affine): Edges | null {
	const ref = /^url\(\s*["']?#([^"')\s]+)["']?\s*\)$/.exec((el.getAttribute('clip-path') ?? '').trim());
	const id = ref?.[1];
	if (id === undefined) return null;
	const path = Array.from(svg.getElementsByTagNameNS(SVG_NS, 'clipPath')).find((p) => p.id === id);
	if (!path || path.getAttribute('clipPathUnits') === 'objectBoundingBox') return null;
	const parent = el.parentNode;
	if (!parent) return null;

	const probe = el.ownerDocument.createElementNS(SVG_NS, 'g');
	probe.setAttribute('visibility', 'hidden');
	const transform = [el.getAttribute('transform'), path.getAttribute('transform')]
		.filter(Boolean)
		.join(' ');
	if (transform) probe.setAttribute('transform', transform);
	for (const shape of Array.from(path.children)) {
		const copy = shape.cloneNode(true) as Element;
		// Not two elements with one id, even for the moment the probe is in the document.
		copy.removeAttribute('id');
		for (const named of Array.from(copy.querySelectorAll('[id]'))) named.removeAttribute('id');
		probe.appendChild(copy);
	}
	parent.insertBefore(probe, el);
	try {
		return measurable(probe) ? boxOf(probe, toRoot) : null;
	} finally {
		probe.remove();
	}
}

function measurable(el: Element): el is Measurable {
	const m = el as Partial<Measurable>;
	return typeof m.getBBox === 'function' && typeof m.getScreenCTM === 'function';
}

/** An element's box in the root's user units: its own box, through the transforms down to it. */
function boxOf(el: Measurable, toRoot: Affine): Edges | null {
	let local: { x: number; y: number; width: number; height: number };
	let screen: Affine | null;
	try {
		local = el.getBBox();
		screen = el.getScreenCTM();
	} catch {
		// A shape that is not drawn (display:none above it) throws in some engines.
		return null;
	}
	if (!screen) return null;
	const { x, y, width, height } = local;
	if (![x, y, width, height].every(Number.isFinite)) return null;

	const m = multiply(toRoot, screen);
	const xs: number[] = [];
	const ys: number[] = [];
	for (const [px, py] of [
		[x, y],
		[x + width, y],
		[x, y + height],
		[x + width, y + height],
	] as const) {
		xs.push(m.a * px + m.c * py + m.e);
		ys.push(m.b * px + m.d * py + m.f);
	}
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function meet(p: Edges, q: Edges): Edges {
	return {
		x0: Math.max(p.x0, q.x0),
		y0: Math.max(p.y0, q.y0),
		x1: Math.min(p.x1, q.x1),
		y1: Math.min(p.y1, q.y1),
	};
}

function join(p: Edges, q: Edges): Edges {
	return {
		x0: Math.min(p.x0, q.x0),
		y0: Math.min(p.y0, q.y0),
		x1: Math.max(p.x1, q.x1),
		y1: Math.max(p.y1, q.y1),
	};
}

/** `p` after `q`: a point goes through `q` first. */
function multiply(p: Affine, q: Affine): Affine {
	return {
		a: p.a * q.a + p.c * q.b,
		b: p.b * q.a + p.d * q.b,
		c: p.a * q.c + p.c * q.d,
		d: p.b * q.c + p.d * q.d,
		e: p.a * q.e + p.c * q.f + p.e,
		f: p.b * q.e + p.d * q.f + p.f,
	};
}

function invert(m: Affine): Affine | null {
	const det = m.a * m.d - m.b * m.c;
	if (!Number.isFinite(det) || det === 0) return null;
	return {
		a: m.d / det,
		b: -m.b / det,
		c: -m.c / det,
		d: m.a / det,
		e: (m.c * m.f - m.d * m.e) / det,
		f: (m.b * m.e - m.a * m.f) / det,
	};
}
