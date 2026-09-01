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
export function renderPlaceholder(
	container: HTMLElement,
	known: Pick<Artifact, 'w' | 'h'> | undefined,
): HTMLElement {
	const el = container.createDiv({ cls: 'tikzjax-placeholder' });
	el.setAttribute('aria-busy', 'true');
	el.setAttribute('aria-label', 'Rendering diagram');

	// setCssProps rather than element.style: these are computed per diagram, which is exactly the
	// case Obsidian's guidelines carve out for it, and a CSS class cannot carry a measured ratio.
	if (known && known.w > 0 && known.h > 0) {
		el.setCssProps({ 'aspect-ratio': `${known.w} / ${known.h}`, 'max-width': `${known.w}px` });
	} else {
		el.setCssProps({ 'aspect-ratio': '4 / 3' });
	}
	return el;
}

/** The "Render diagram" affordance for manual mode and for blocks past the queue depth cap. */
export function renderManualTrigger(
	container: HTMLElement,
	onRender: () => void,
	label = 'Render diagram',
): void {
	const wrap = container.createDiv({ cls: 'tikzjax-manual' });
	const button = wrap.createEl('button', { text: label });
	button.addEventListener('click', onRender);
}
