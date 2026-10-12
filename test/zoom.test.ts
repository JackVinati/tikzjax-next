// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from './stubs/obsidian-dom';
import { ZoomModal } from '../src/ui/zoom';
import type { ColorMode } from '../src/types';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

const MARKUP =
	'<svg xmlns="http://www.w3.org/2000/svg" width="40pt" height="20pt" viewBox="0 0 40 20">' +
	'<rect class="tz-paper-fill" width="10" height="10"/></svg>';

/** Open the modal on elements of its own: the stub Modal has none, and nothing else is used. */
function open(colors?: ColorMode): HTMLElement {
	const modal =
		colors === undefined ? new ZoomModal({} as App, MARKUP) : new ZoomModal({} as App, MARKUP, colors);
	const contentEl = document.body.createDiv();
	Object.assign(modal as unknown as Record<string, unknown>, {
		modalEl: document.body.createDiv(),
		titleEl: document.body.createDiv(),
		contentEl,
	});
	modal.onOpen();
	const surface = contentEl.querySelector<HTMLElement>('.tikzjax-zoom-surface');
	if (!surface) throw new Error('the zoom view has no surface');
	return surface;
}

describe('the zoom view', () => {
	/**
	 * It mounts the stored artifact outside any .tikzjax-figure, so it took no notice of the block's
	 * colour mode and drew every diagram as adapt: a `colors=paper` diagram lost its white paper,
	 * and an inverted one was not inverted. The surface carries the mode as the figure does, and
	 * base.css gives it the same tokens.
	 */
	it('carries the block’s colour mode, as the figure in the note does', () => {
		expect(open('paper').classList.contains('is-paper')).toBe(true);
		expect(open('invert').classList.contains('is-invert')).toBe(true);
		expect(open('preserve').classList.contains('is-preserve')).toBe(true);
	});

	it('adds no class for adapt, the default', () => {
		const surface = open();
		expect([...surface.classList]).toEqual(['tikzjax-zoom-surface']);
		expect(surface.querySelector('svg')).not.toBeNull();
	});
});
