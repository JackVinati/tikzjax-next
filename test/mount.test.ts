// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { mountArtifact } from '../src/block/mount';
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
