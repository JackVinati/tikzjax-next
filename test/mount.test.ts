// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { mountArtifact } from '../src/block/mount';
import { renderPlaceholder } from '../src/block/placeholder';
import type { Artifact, Presentation } from '../src/types';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

const SVG_NS = 'http://www.w3.org/2000/svg';

function artifact(template: string): Artifact {
	return {
		template,
		w: 100,
		h: 80,
		revision: 1,
		engineId: 'test',
		createdAt: 0,
	} as unknown as Artifact;
}

function presentation(over: Partial<Presentation> = {}): Presentation {
	return { scale: 1, colors: 'adapt', ...over } as Presentation;
}

function mount(over: Partial<Presentation> = {}): SVGSVGElement {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const result = mountArtifact(
		container,
		artifact(`<svg xmlns="${SVG_NS}" viewBox="0 0 100 80"><path d="M0 0"/></svg>`),
		presentation(over),
	);
	if (!result) throw new Error('the fixture has an <svg>, so the mount cannot be null');
	return result.svg;
}

/**
 * The accessible name of a diagram.
 *
 * Worth a test of its own because the failure is invisible: an HTML `<title>` inside an `<svg>` sits
 * in the DOM looking correct and names nothing at all — a screen reader reads neither it nor the
 * element. Only the namespace tells the two apart, so that is what is asserted, along with the
 * position: the accessible name comes from the FIRST title child, not from any title child.
 */
describe('mountArtifact: the accessible name', () => {
	it('puts the alt text in an SVG-namespaced <title>, first, and marks the svg as an image', () => {
		const svg = mount({ alt: 'an RC low-pass filter' });
		const title = svg.firstElementChild;

		expect(title?.tagName.toLowerCase()).toBe('title');
		expect(title?.namespaceURI).toBe(SVG_NS);
		expect(title?.textContent).toBe('an RC low-pass filter');
		expect(svg.getAttribute('role')).toBe('img');
		expect(svg.getAttribute('aria-hidden')).toBeNull();
	});

	it('hides a diagram marked decorative rather than naming it', () => {
		const svg = mount({ alt: '' });

		expect(svg.getAttribute('aria-hidden')).toBe('true');
		expect(svg.querySelector('title')).toBeNull();
	});

	it('falls back to a generic label when the block says nothing', () => {
		const svg = mount();

		expect(svg.getAttribute('role')).toBe('img');
		expect(svg.getAttribute('aria-label')).toBe('TikZ diagram');
		expect(svg.querySelector('title')).toBeNull();
	});
});

// The frame as the engine writes it: one inch short of the drawing (#66 #71 #29).
const ENGINE_SVG = `<svg xmlns="${SVG_NS}" width="85.75pt" height="92.36pt" viewBox="-72 -72 85.75 92.36"><path d="M0 0"/></svg>`;

function stored(over: Partial<Artifact>): Artifact {
	return {
		v: 1,
		template: ENGINE_SVG,
		w: 0,
		h: 0,
		viewBox: null,
		fonts: [],
		bytes: ENGINE_SVG.length,
		engineId: 'test',
		origin: 'render',
		createdAt: 0,
		lastUsed: 0,
		...over,
	};
}

function mountStored(artifact: Artifact, over: Partial<Presentation> = {}) {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const result = mountArtifact(container, artifact, presentation(over));
	if (!result) throw new Error('the fixture has an <svg>, so the mount cannot be null');
	return { container, svg: result.svg };
}

describe('mountArtifact: the measured frame', () => {
	/**
	 * The corrected viewBox is measured once and stored in the artifact so that every later mount
	 * is arithmetic. It was only ever written onto the svg that had just been measured: the template
	 * keeps the engine's frame, and nothing read `artifact.viewBox` back — so a diagram was framed
	 * right the first time and clipped again on every cache hit after.
	 */
	it('puts the stored viewBox on the svg, and rescales width and height with it', () => {
		const { svg } = mountStored(stored({ viewBox: '-80 -90 120 100', w: 120, h: 100 }));

		expect(svg.getAttribute('viewBox')).toBe('-80 -90 120 100');
		// One user unit stays one point: only the frame moves, not the drawing's size.
		expect(svg.getAttribute('width')).toBe('120pt');
		expect(svg.getAttribute('height')).toBe('100pt');
	});

	it('leaves the engine frame alone until there is a measurement', () => {
		const { svg } = mountStored(stored({}));

		expect(svg.getAttribute('viewBox')).toBe('-72 -72 85.75 92.36');
		expect(svg.getAttribute('width')).toBe('85.75pt');
	});

	it('does not rescale a percentage extent, which is not in user units', () => {
		const template = ENGINE_SVG.split('width="85.75pt"').join('width="100%"');
		const { svg } = mountStored(stored({ template, viewBox: '0 0 10 5', w: 10, h: 5 }));

		expect(svg.getAttribute('width')).toBe('100%');
		expect(svg.getAttribute('viewBox')).toBe('0 0 10 5');
	});
});

describe('mountArtifact: scale', () => {
	it('applies on the first render too, before any measurement exists', () => {
		// A fresh render has no measured width yet; `scale=2` used to do nothing until the note was
		// reopened. The frame on screen until the measurement lands is the engine's.
		const { container } = mountStored(stored({}), { scale: 2 });

		expect(container.style.width).toBe('171.5px');
	});

	it('uses the measured width once there is one', () => {
		const { container } = mountStored(stored({ viewBox: '0 0 120 100', w: 120, h: 100 }), { scale: 0.5 });

		expect(container.style.width).toBe('60px');
	});
});

describe('the placeholder', () => {
	it('is as wide as the diagram that replaces it, in the unit the diagram is drawn in', () => {
		// The measured width is in the svg's user units, which are points; the svg's own `width`
		// is written in pt. A placeholder capped at that many PIXELS is three quarters as wide as
		// the diagram that lands in it, and the note shifts when it does.
		const container = document.createElement('div');
		const el = renderPlaceholder(container, { w: 120, h: 100 });

		expect(el.style.maxWidth).toBe('120pt');
		expect(el.style.aspectRatio).toBe('120 / 100');
	});
});
