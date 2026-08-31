import type { Artifact } from '../types';

/**
 * The skeleton shown while a diagram compiles.
 *
 * Sized from the cached bounding box whenever we have one. Without an intrinsic size, a note with
 * twenty diagrams jumps as each one lands, and the reader loses their place — the classic layout
 * shift. With it, the diagram simply appears in a hole that was already the right shape.
 *
 * The default 4:3 at 80px minimum is a guess, and it is only ever used for a diagram nobody has
 * rendered yet on this device.
 */
export function renderPlaceholder(container: HTMLElement, known: Pick<Artifact, 'w' | 'h'> | undefined): HTMLElement {
	const el = container.createDiv({ cls: 'tikzjax-placeholder' });
	el.setAttribute('aria-busy', 'true');
	el.setAttribute('aria-label', 'Rendering diagram');

	if (known && known.w > 0 && known.h > 0) {
		el.style.aspectRatio = `${known.w} / ${known.h}`;
		el.style.maxWidth = `${known.w}px`;
	} else {
		el.style.aspectRatio = '4 / 3';
	}
	return el;
}

/** The "Render diagram" affordance for manual mode and for blocks past the queue depth cap. */
export function renderManualTrigger(container: HTMLElement, onRender: () => void, label = 'Render diagram'): void {
	const wrap = container.createDiv({ cls: 'tikzjax-manual' });
	const button = wrap.createEl('button', { text: label });
	button.addEventListener('click', onRender);
}
