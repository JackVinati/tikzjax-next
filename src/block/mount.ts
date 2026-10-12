import type { Artifact, Presentation } from '../types';
import { stampIds } from '../svg/ids';
import { parseSvg, serializeSvg } from '../svg/serialize';
import { parseViewBox, formatViewBox, formatNumber, parseLength, type InkBounds } from '../svg/geometry';

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

	applyBounds(svg, artifact.viewBox);
	applyPresentation(container, svg, presentation, artifact);
	container.appendChild(fragment);

	return { svg: svg, nonce };
}

/**
 * What one more mount of this artifact would show, as a standalone string: its own id nonce and
 * the measured frame.
 *
 * For the commands that take a diagram out of the note — Copy and Save SVG, Finalize, the zoom
 * view. They used to be handed the stored template itself, which still carries the `__TZ__`
 * placeholders where its ids belong (svg/freeze.ts calls freezing one the caller's bug) and the
 * engine's frame, an inch short of the drawing.
 */
export function standaloneMarkup(artifact: Artifact): string {
	const markup = stampIds(artifact.template, String(++instanceCounter));
	if (artifact.viewBox === null) return markup;
	try {
		const doc = parseSvg(markup);
		applyBounds(doc.documentElement, artifact.viewBox);
		return serializeSvg(doc);
	} catch {
		// The template parsed once already, on its way through the pipeline. Should it not now, the
		// engine's frame is still a diagram, and a better answer than none.
		return markup;
	}
}

/**
 * Put the measured ink box on a mounted <svg>.
 *
 * The template keeps the engine's frame, and the corrected box is stored beside it
 * (`Artifact.viewBox`) precisely so that every later mount is arithmetic — but it was only ever
 * written onto the svg that had just been measured. Nothing applied it on a mount, so a diagram
 * was framed right the first time and clipped again on every cache hit after (#66 #71 #29).
 *
 * `width`/`height` are rescaled with it, as svg/geometry.ts's applyInkBounds does for a document:
 * one user unit stays one point, so only the frame moves, not the size of the drawing. A
 * percentage extent is resolved against the container, not in user units, and is left alone.
 */
export function applyBounds(svg: Element, viewBox: string | null): void {
	const box = parseViewBox(viewBox);
	if (box === null || box.width <= 0 || box.height <= 0) return;

	const current = parseViewBox(svg.getAttribute('viewBox'));
	rescaleExtent(svg, 'width', box.width, current?.width);
	rescaleExtent(svg, 'height', box.height, current?.height);
	svg.setAttribute('viewBox', formatViewBox(box));
}

function rescaleExtent(
	svg: Element,
	attribute: 'width' | 'height',
	extent: number,
	previous: number | undefined,
): void {
	const length = parseLength(svg.getAttribute(attribute));
	if (length === null || length.unit === '%') return;
	const ratio = previous !== undefined && previous > 0 ? length.value / previous : 1;
	svg.setAttribute(attribute, formatNumber(extent * ratio) + length.unit);
}

/**
 * A wrapper whose width the block chose, with `width=` or `scale=`. base.css has the svg fill it:
 * left to its own `width` attribute the svg can shrink into a narrower wrapper (`max-width`) but
 * never grow into a wider one, so `scale=2` drew a diagram at its natural size and `width=420`
 * worked only as a cap.
 */
const SIZED_CLASS = 'is-sized';

/**
 * `scale` sizes the wrapper from the diagram's width: the measured one when there is one, and
 * until then the frame the engine drew, which is what is on screen. Waiting for the measurement
 * meant `scale=` did nothing at all the first time a diagram rendered.
 *
 * In points, because that is the unit of the width: one user unit is one point (svg/geometry.ts).
 * It used to be written in pixels, which put every scale three quarters of the way to where it
 * meant to be.
 */
export function applyScale(
	container: HTMLElement,
	svg: SVGSVGElement,
	presentation: Presentation,
	artifact: Artifact,
): void {
	if (!presentation.scale || presentation.scale === 1) return;
	const width = artifact.w > 0 ? artifact.w : (parseViewBox(svg.getAttribute('viewBox'))?.width ?? 0);
	if (width <= 0) return;
	container.setCssStyles({ width: `${formatNumber(width * presentation.scale)}pt` });
	container.addClass(SIZED_CLASS);
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
	if (presentation.width) {
		container.setCssStyles({ width: presentation.width });
		if (presentation.width !== 'auto') container.addClass(SIZED_CLASS);
	}
	if (presentation.maxWidth) container.setCssStyles({ maxWidth: presentation.maxWidth });
	applyScale(container, svg, presentation, artifact);

	// Accessibility: an unlabelled <svg> is invisible to a screen reader, and today every diagram
	// is one. `alt=""` is a deliberate "this is decorative", not a missing value.
	if (presentation.alt === '') {
		svg.setAttribute('aria-hidden', 'true');
	} else if (presentation.alt) {
		svg.setAttribute('role', 'img');
		// createSvg, not createEl: this `<title>` has to be in the SVG namespace, and an HTML <title>
		// inside an <svg> is not a label, it is nothing. `prepend` because the accessible name comes
		// from the FIRST title child.
		const title = svg.createSvg('title', { prepend: true });
		title.textContent = presentation.alt;
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
