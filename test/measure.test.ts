// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { visibleBox } from '../src/svg/measure';

/**
 * svg/measure.ts against a geometry of the test's own: happy-dom lays nothing out, so `getBBox`
 * and `getScreenCTM` are stood in for, from attributes. A shape's box is its `data-box`; a group's
 * is its children's, through their transforms, as a browser's is, leaving out what is not drawn
 * and groups with nothing in them; `transform` takes translate, scale and matrix; and the root's
 * screen transform is its `data-screen`. What browsers make of real diagrams was checked in
 * Chromium and WebKit (internal/DECISIONS.md D42); this is about what the walk makes of the boxes
 * it is given.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NOT_DRAWN = new Set(['clipPath', 'defs', 'title']);

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];

function times(p: M, q: M): M {
	return [
		p[0] * q[0] + p[2] * q[1],
		p[1] * q[0] + p[3] * q[1],
		p[0] * q[2] + p[2] * q[3],
		p[1] * q[2] + p[3] * q[3],
		p[0] * q[4] + p[2] * q[5] + p[4],
		p[1] * q[4] + p[3] * q[5] + p[5],
	];
}

function parseTransform(value: string | null): M {
	let m = I;
	for (const [, fn, args] of (value ?? '').matchAll(/(\w+)\(([^)]*)\)/g)) {
		const n = (args ?? '')
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		if (fn === 'translate') m = times(m, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]);
		else if (fn === 'scale') m = times(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]);
		else if (fn === 'matrix') m = times(m, n as M);
	}
	return m;
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

function through(m: M, b: Box): Box {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const [px, py] of [
		[b.x, b.y],
		[b.x + b.width, b.y],
		[b.x, b.y + b.height],
		[b.x + b.width, b.y + b.height],
	] as const) {
		xs.push(m[0] * px + m[2] * py + m[4]);
		ys.push(m[1] * px + m[3] * py + m[5]);
	}
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function bbox(el: Element): Box {
	const own = el.getAttribute('data-box');
	if (own) {
		const [x = 0, y = 0, width = 0, height = 0] = own.split(' ').map(Number);
		return { x, y, width, height };
	}
	let out: Box | null = null;
	for (const child of Array.from(el.children)) {
		if (NOT_DRAWN.has(child.localName) || empty(child)) continue;
		const b = through(parseTransform(child.getAttribute('transform')), bbox(child));
		if (!out) out = b;
		else {
			const x = Math.min(out.x, b.x);
			const y = Math.min(out.y, b.y);
			out = {
				x,
				y,
				width: Math.max(out.x + out.width, b.x + b.width) - x,
				height: Math.max(out.y + out.height, b.y + b.height) - y,
			};
		}
	}
	return out ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** A group with nothing drawn in it, which a browser leaves out of its parent's box. */
function empty(el: Element): boolean {
	if (el.hasAttribute('data-box')) return false;
	return Array.from(el.children).every((child) => NOT_DRAWN.has(child.localName) || empty(child));
}

function screen(el: Element): M | null {
	if (el.localName === 'svg') {
		const s = el.getAttribute('data-screen');
		return s === 'none' ? null : s ? (s.split(' ').map(Number) as M) : I;
	}
	const parent = el.parentElement;
	const above = parent ? screen(parent) : I;
	return above ? times(above, parseTransform(el.getAttribute('transform'))) : null;
}

let restore: (() => void) | null = null;

beforeEach(() => {
	const w = window as unknown as Record<string, { prototype: object } | undefined>;
	const protos = ['SVGElement', 'SVGGraphicsElement', 'SVGSVGElement']
		.map((name) => w[name]?.prototype)
		.filter((p): p is object => p !== undefined);
	const saved = protos.map((p) => Object.getOwnPropertyDescriptors(p));
	for (const p of protos) {
		Object.defineProperty(p, 'getBBox', {
			configurable: true,
			value(this: Element) {
				return bbox(this);
			},
		});
		Object.defineProperty(p, 'getScreenCTM', {
			configurable: true,
			value(this: Element) {
				const m = screen(this);
				return m ? { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } : null;
			},
		});
	}
	restore = () => {
		protos.forEach((p, i) => {
			for (const name of ['getBBox', 'getScreenCTM']) {
				const before = saved[i]?.[name];
				if (before) Object.defineProperty(p, name, before);
				else delete (p as Record<string, unknown>)[name];
			}
		});
	};
});

afterEach(() => {
	restore?.();
	document.body.replaceChildren();
});

/** Parsed as XML, so that `clipPath` keeps its case as a browser's HTML parser keeps it. */
function diagram(inner: string, attrs = ''): SVGSVGElement {
	const parsed = new DOMParser().parseFromString(
		`<svg xmlns="${SVG_NS}" ${attrs}>${inner}</svg>`,
		'image/svg+xml',
	);
	const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
	document.body.appendChild(svg);
	return svg;
}

const AXIS = '<clipPath id="axis"><path data-box="0 0 100 100"/></clipPath>';

describe('visibleBox', () => {
	it('cuts a clipped curve down to its clip path, the axis it is drawn in (discussion #4)', () => {
		const svg = diagram(
			AXIS +
				'<g clip-path="url(#axis)"><path data-box="0 -500 100 600"/></g><path data-box="-10 100 20 10"/>',
		);

		expect(svg.getBBox()).toEqual({ x: -10, y: -500, width: 110, height: 610 });
		expect(visibleBox(svg)).toEqual({ x: -10, y: 0, width: 110, height: 110 });
	});

	it('gives the box getBBox gives when the clipping hides nothing', () => {
		const svg = diagram(
			AXIS +
				'<g clip-path="url(#axis)"><path data-box="10 10 50 50"/></g><path data-box="0 0 100 100"/>',
		);

		expect(visibleBox(svg)).toEqual(svg.getBBox());
	});

	it('puts the clip path in the clipped element’s own space, its transform and the clip path’s', () => {
		const shifted = diagram(
			AXIS + '<g transform="translate(50 0)" clip-path="url(#axis)"><path data-box="0 0 300 10"/></g>',
		);
		expect(visibleBox(shifted)).toEqual({ x: 50, y: 0, width: 100, height: 10 });

		const scaled = diagram(
			'<clipPath id="axis" transform="scale(2)"><path data-box="0 0 100 100"/></clipPath>' +
				'<g clip-path="url(#axis)"><path data-box="0 0 300 10"/></g>',
		);
		expect(visibleBox(scaled)).toEqual({ x: 0, y: 0, width: 200, height: 10 });
	});

	it('leaves out a group with nothing drawn in it, as getBBox does', () => {
		const svg = diagram(
			AXIS +
				'<g clip-path="url(#axis)"><path data-box="0 -500 100 600"/></g>' +
				'<g transform="translate(-50 -50)"><g><title>shading</title></g></g>',
		);

		expect(visibleBox(svg)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it('meets the clip paths of nested groups, and leaves out what one hides entirely', () => {
		const svg = diagram(
			AXIS +
				'<clipPath id="left"><path data-box="-50 0 100 100"/></clipPath>' +
				'<g clip-path="url(#axis)"><g clip-path="url(#left)"><path data-box="-100 -100 400 400"/></g>' +
				'<path data-box="200 200 10 10"/></g>',
		);

		expect(visibleBox(svg)).toEqual({ x: 0, y: 0, width: 50, height: 100 });
	});

	it('clips nothing for a reference to no clip path, or one in object-bounding-box units', () => {
		const missing = diagram('<g clip-path="url(#nowhere)"><path data-box="0 0 300 10"/></g>');
		expect(visibleBox(missing)).toEqual({ x: 0, y: 0, width: 300, height: 10 });

		const relative = diagram(
			'<clipPath id="axis" clipPathUnits="objectBoundingBox"><path data-box="0 0 1 1"/></clipPath>' +
				'<g clip-path="url(#axis)"><path data-box="0 0 300 10"/></g>',
		);
		expect(visibleBox(relative)).toEqual({ x: 0, y: 0, width: 300, height: 10 });
	});

	it('answers in the root’s user units, whatever the screen does to them', () => {
		const svg = diagram(
			AXIS + '<g clip-path="url(#axis)"><path data-box="0 -500 100 600"/></g>',
			'data-screen="2 0 0 2 30 40"',
		);

		expect(visibleBox(svg)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it('leaves the document as it found it', () => {
		const svg = diagram(AXIS + '<g clip-path="url(#axis)"><path id="p" data-box="0 -500 100 600"/></g>');
		const before = svg.outerHTML;

		visibleBox(svg);
		expect(svg.outerHTML).toBe(before);
	});

	it('is null for a diagram not laid out, to be measured on a later mount', () => {
		const svg = diagram(
			AXIS + '<g clip-path="url(#axis)"><path data-box="0 0 10 10"/></g>',
			'data-screen="none"',
		);

		expect(visibleBox(svg)).toBeNull();
	});
});
