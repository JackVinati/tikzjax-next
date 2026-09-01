import type { Artifact, Presentation } from '../types';
import { stampIds } from '../svg/ids';
import { parseViewBox, formatViewBox, type InkBounds } from '../svg/geometry';

/**
 * Putting a finished artifact into the document. See internal/DESIGN.md §7.2 steps 7-9.
 *
 * Never `outerHTML`. The shipped plugin assigns to it (main.ts:183), which destroys node identity,
 * throws `NoModificationAllowedError` when the parent has been detached, executes event-handler
 * content attributes, and is forbidden by the community-store guidelines.
 */

let instanceCounter = 0;

export interface MountResult {
	svg: SVGSVGElement;
	/** The nonce stamped over this mount's ids, so a caller can scope a later lookup. */
	nonce: string;
}

/**
 * Mount one artifact.
 *
 * The id nonce is what makes two copies of the same diagram safe. pgf namespaces its ids by
 * CONTENT hash, so the same source in two panes emits byte-identical `<clipPath id=...>`, and
 * `url(#id)` resolves to the first match in document order — one pane silently loses its clipping
 * (#12). The stored template carries `__TZ__n` placeholders and each mount stamps its own counter.
 */
export function mountArtifact(
	container: HTMLElement,
	artifact: Artifact,
	presentation: Presentation,
): MountResult | null {
	const nonce = String(++instanceCounter);
	const markup = stampIds(artifact.template, nonce);

	// A range fragment rather than innerHTML: it parses in the document's own context and does not
	// re-serialise anything already in the container. The sanitize stage has already run over the
	// parsed document, and it is mandatory precisely because this insertion path executes what it
	// is given.
	// eslint-disable-next-line no-unsanitized/method -- the sanitize stage is mandatory, non-skippable and has already run over this markup (svg/stages.ts); it is what makes this insertion safe.
	const fragment = container.doc.createRange().createContextualFragment(markup);
	const svg = fragment.querySelector('svg');
	if (!svg) return null;

	applyPresentation(container, svg, presentation, artifact);
	container.appendChild(fragment);

	return { svg: svg, nonce };
}

/**
 * Width, alignment and scale go on the WRAPPER, never on the `<svg>`.
 *
 * Sizing the svg directly fights the viewBox and produces the "diagram renders tiny" and "scaling
 * does not work" reports (#14, #26, #42, #50). The wrapper is layout; the svg is content.
 */
function applyPresentation(
	container: HTMLElement,
	svg: SVGSVGElement,
	presentation: Presentation,
	artifact: Artifact,
): void {
	const figure = container.closest('.tikzjax-figure') ?? container;

	if (presentation.align) figure.setAttribute('data-align', presentation.align);
	if (presentation.colors && presentation.colors !== 'adapt') {
		figure.addClass(`is-${presentation.colors}`);
	}

	// setCssStyles rather than `.style.x =`: it is the API Obsidian documents for setting a real CSS
	// property from code, and every value here comes from the block's own options.
	if (presentation.width) container.setCssStyles({ width: presentation.width });
	if (presentation.maxWidth) container.setCssStyles({ maxWidth: presentation.maxWidth });
	if (presentation.scale && presentation.scale !== 1 && artifact.w > 0) {
		container.setCssStyles({ width: `${artifact.w * presentation.scale}px` });
	}

	// Accessibility: an unlabelled <svg> is invisible to a screen reader, and today every diagram
	// is one. `alt=""` is a deliberate "this is decorative", not a missing value.
	if (presentation.alt === '') {
		svg.setAttribute('aria-hidden', 'true');
	} else if (presentation.alt) {
		svg.setAttribute('role', 'img');
		// createElementNS, not createEl: `<title>` here has to be in the SVG namespace, and Obsidian's
		// helpers build HTML elements. An HTML <title> inside an <svg> is not a label, it is nothing.
		const title = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'title');
		title.textContent = presentation.alt;
		svg.insertBefore(title, svg.firstChild);
	} else {
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'TikZ diagram');
	}
}

/**
 * Measure the real ink bounds, once per key, and only when the fonts behind them have loaded.
 *
 * dvi2html emits `viewBox="-72 -72 W H"`: the one-inch DVI origin shift is applied to the origin
 * but not to the extent, so the frame is systematically an inch short of the drawing (#66 #71 #29).
 *
 * `await document.fonts.ready` is not politeness. The output contains real `<text font-family="cmr10">`
 * elements, so a bbox taken before those faces resolve is wrong — and because the corrected viewBox
 * is PERSISTED into the artifact, it would be wrong forever: the bbox is an output, not a key
 * input, so no input change would ever invalidate it. A cache that poisons itself is worse than no
 * cache. If a referenced face has not loaded we mount with the engine's viewBox and try again on
 * the next mount rather than storing a guess.
 */
export async function measureInk(svg: SVGSVGElement, doc: Document): Promise<InkBounds | null> {
	try {
		await doc.fonts.ready;
	} catch {
		return null;
	}

	try {
		const box = svg.getBBox();
		if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
		if (box.width <= 0 || box.height <= 0) return null;
		return { x: box.x, y: box.y, width: box.width, height: box.height };
	} catch {
		// getBBox throws on a detached or display:none element in some engines. Not an error:
		// the block simply is not visible, and the next mount will measure it.
		return null;
	}
}

/** Fold a measured bbox into the artifact so every later mount is pure arithmetic. */
export function withMeasuredBounds(artifact: Artifact, bounds: InkBounds): Artifact {
	const existing = parseViewBox(artifact.viewBox);
	if (existing && existing.width === bounds.width && existing.height === bounds.height) {
		return artifact;
	}
	return {
		...artifact,
		viewBox: formatViewBox(bounds),
		w: bounds.width,
		h: bounds.height,
	};
}
