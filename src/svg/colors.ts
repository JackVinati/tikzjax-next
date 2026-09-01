import type { ColorMode } from '../types';

/**
 * The colour model. See internal/DESIGN.md §7.5.
 *
 * The shipped plugin string-replaces "black" and "white" over `outerHTML`. That is wrong three
 * times over: it cannot see `<span style="line-height: 0; color: black; ...">` (emitter 4 below,
 * unquoted CSS inside a declaration), it rewrites the endpoints of gradient ramps and flattens
 * `ball color` shading (#73), and it writes `var(--...)` into presentation attributes, which is
 * invalid-at-computed-value-time outside Obsidian — `fill` then falls back to BLACK, not white,
 * which is why copied and exported SVGs come out wrong today (#21, #97).
 *
 * The four emitters this pass must handle, all verified in the engine:
 *   1. `HTMLMachine` sets `q.color = "black"` — the default ink is a literal string.
 *   2. `putRule` writes `<rect ... fill="black">` for fraction bars, \hrule and table rules.
 *   3. `putText` at svgDepth > 0 writes `<text ... fill="black">`.
 *   4. `putText` at svgDepth == 0 writes `<span style="line-height: 0; color: black; ...">`.
 *
 * There is no marker distinguishing TeX's default ink from an author's `\fill[black]`, so this is
 * a deliberate heuristic, not a proof. What it must never do is destroy an author's white.
 */

/** The paints we look at. `color` is here for emitter 4 and for `currentColor` inheritance. */
const PAINT_PROPERTIES = ['fill', 'stroke', 'color'] as const;
type PaintProperty = (typeof PAINT_PROPERTIES)[number];

export const PAPER_FILL_CLASS = 'tz-paper-fill';
export const PAPER_STROKE_CLASS = 'tz-paper-stroke';

/** `color` is absent deliberately — see the comment on `paperClassFor`. */
const PAPER_CLASSES: Partial<Record<PaintProperty, string>> = {
	fill: PAPER_FILL_CLASS,
	stroke: PAPER_STROKE_CLASS,
};

export type PaintClass = 'ink' | 'paper' | 'other';

/**
 * Subtrees where black and white are DATA, not ink, so no recolouring is defensible.
 *
 * - `stop`: #73. A `ball color` ramp runs black→colour→white; moving its endpoints toward each
 *   other flattens the shading. The "Adapt gradients: ink-only" setting is not implemented; the
 *   default is "never".
 * - `mask`: pgf's dvisvgm driver implements `\tikzfading`, `path fading` and `scope fading` as a
 *   `<mask>`, and a mask's LUMINANCE is its alpha channel — white is fully opaque, black is fully
 *   transparent. Recolouring one does not change a colour, it changes what is visible, and in a
 *   dark theme `var(--tikz-paper)` is nearly black, so a faded diagram all but disappears. The
 *   whole subtree is skipped, not just the `<mask>` element: its children inherit its paint.
 *
 * `pattern` and `marker` deliberately are NOT here — a hatch pattern or an arrow head really is
 * ink and must follow the theme like everything else.
 */
const OPAQUE_SUBTREES: ReadonlySet<string> = new Set(['stop', 'mask']);

/**
 * Classify one CSS colour value.
 *
 * The recognised sets are exactly the ones dvi2html and SVGO can produce: its colour-special
 * mapper emits `"gray 0"→"black"`, `"gray 1"→"white"` and `rgb ...`→hex, and SVGO's
 * `convertColors` shortens `#000000` to `#000`. Anything else — `#010101`, a half-transparent
 * black, `currentColor` — is left alone, which is also what makes this pass idempotent.
 */
export function classifyColor(value: string): PaintClass {
	const normalized = trimAscii(value).toLowerCase();
	if (normalized === 'black') return 'ink';
	if (normalized === 'white') return 'paper';
	if (normalized.charAt(0) === '#') return classifyHex(normalized);
	if (normalized.startsWith('rgb(') || normalized.startsWith('rgba(')) return classifyRgb(normalized);
	return 'other';
}

/**
 * Rewrite the document's paints so the stored artifact is theme-neutral.
 *
 * `preserve` and `invert` are no-ops here on purpose: `invert` is a CSS filter over the literal
 * black-on-white the engine produced, and it only works if that literal survives to mount time.
 * `paper` runs the same DOM pass as `adapt` — the difference between the two is entirely in the
 * `--tikz-ink` / `--tikz-paper` values the wrapper class sets, which is what keeps the colour mode
 * out of the cache key (types.ts: `colors` lives in `Presentation`, not `BakedOptions`).
 */
export function applyColorModel(doc: Document, mode: ColorMode): void {
	if (mode !== 'adapt' && mode !== 'paper') return;

	const root = doc.documentElement as Element | null;
	if (root === null) return;

	// An explicit stack rather than `querySelectorAll('*')` plus an ancestor test: skipping a
	// subtree has to be a skip, and `closest()` per element is both O(depth) and unevenly
	// implemented on elements of an XML document. Depth-first, children pushed in reverse so the
	// walk stays in document order.
	const stack: Element[] = [root];
	for (let element = stack.pop(); element !== undefined; element = stack.pop()) {
		if (OPAQUE_SUBTREES.has(element.localName)) continue;

		rewriteAttributes(element);
		rewriteStyle(element);

		const children = element.children;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children.item(i);
			if (child !== null) stack.push(child);
		}
	}
}

function rewriteAttributes(element: Element): void {
	for (const property of PAINT_PROPERTIES) {
		const value = element.getAttribute(property);
		if (value === null) continue;

		const kind = classifyColor(value);
		if (kind === 'ink') {
			element.setAttribute(property, 'currentColor');
			continue;
		}
		if (kind !== 'paper') continue;

		const paperClass = paperClassFor(property);
		if (paperClass === undefined) continue;
		// Remove rather than rewrite: a class resolves through the stylesheet inside Obsidian and
		// degrades to the UA default outside it, whereas `fill="var(--tikz-paper)"` degrades to
		// black — the opposite of white, on the one path (export, copy) where nobody is watching.
		element.removeAttribute(property);
		addClass(element, paperClass);
	}
}

function rewriteStyle(element: Element): void {
	const style = element.getAttribute('style');
	if (style === null) return;

	const kept: string[] = [];
	let changed = false;

	for (const declaration of splitDeclarations(style)) {
		if (trimAscii(declaration) === '') continue;

		// A property name can hold neither a colon nor a bracket, so the first colon is the
		// separator even when the value contains more of them (`url(data:...)`).
		const colon = declaration.indexOf(':');
		if (colon < 0) {
			kept.push(trimAscii(declaration));
			continue;
		}

		const property = trimAscii(declaration.slice(0, colon)).toLowerCase();
		if (!isPaintProperty(property)) {
			kept.push(trimAscii(declaration));
			continue;
		}

		const { body, priority } = splitPriority(declaration.slice(colon + 1));
		const kind = classifyColor(body);

		if (kind === 'ink') {
			kept.push(property + ': currentColor' + priority);
			changed = true;
			continue;
		}
		if (kind === 'paper') {
			const paperClass = paperClassFor(property);
			if (paperClass !== undefined) {
				// An inline declaration outranks any stylesheet rule, so the class only takes
				// effect once the declaration is gone.
				addClass(element, paperClass);
				changed = true;
				continue;
			}
		}
		kept.push(trimAscii(declaration));
	}

	if (!changed) return;
	if (kept.length === 0) {
		element.removeAttribute('style');
		return;
	}
	element.setAttribute('style', kept.join('; '));
}

/**
 * White `color` is deliberately left verbatim.
 *
 * styles.css defines `.tz-paper-fill` and `.tz-paper-stroke` and nothing for `color`; emitting a
 * class the stylesheet does not define would silently resolve to the inherited ink and turn white
 * label text into ink-coloured text on top of the author's own fill. `\color{white}` on text is a
 * deliberate choice in a way that TeX's default ink never is, so it survives untouched.
 */
function paperClassFor(property: PaintProperty): string | undefined {
	return PAPER_CLASSES[property];
}

function isPaintProperty(value: string): value is PaintProperty {
	for (const property of PAINT_PROPERTIES) {
		if (property === value) return true;
	}
	return false;
}

/**
 * `class` is read and written as an attribute on purpose: on SVG elements `className` is an
 * `SVGAnimatedString` rather than a string, and `classList` on elements inside an XML document is
 * not uniformly implemented. The attribute is the contract every DOM agrees on.
 */
function addClass(element: Element, name: string): void {
	const existing = element.getAttribute('class');
	if (existing === null || trimAscii(existing) === '') {
		element.setAttribute('class', name);
		return;
	}
	for (const token of existing.split(/\s+/)) {
		if (token === name) return;
	}
	element.setAttribute('class', existing + ' ' + name);
}

/**
 * Split a style attribute on top-level semicolons only.
 *
 * `url('a;b.png')` and `rgb(0, 0, 0)` both contain characters a naive `split(';')` mishandles, and
 * this attribute is also what the `ids` stage sweeps for `url(#…)` references, so being sloppy
 * here would corrupt a declaration nobody asked us to touch.
 */
function splitDeclarations(style: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;

	for (let i = 0; i < style.length; i++) {
		const ch = style.charAt(i);
		if (quote !== '') {
			if (ch === quote && style.charAt(i - 1) !== '\\') quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			if (depth > 0) depth--;
		} else if (ch === ';' && depth === 0) {
			out.push(style.slice(start, i));
			start = i + 1;
		}
	}
	out.push(style.slice(start));
	return out;
}

function splitPriority(value: string): { body: string; priority: string } {
	const trimmed = trimAscii(value);
	const bang = trimmed.lastIndexOf('!');
	if (bang < 0) return { body: trimmed, priority: '' };
	if (trimAscii(trimmed.slice(bang + 1)).toLowerCase() !== 'important') {
		return { body: trimmed, priority: '' };
	}
	return { body: trimAscii(trimmed.slice(0, bang)), priority: ' !important' };
}

function classifyHex(value: string): PaintClass {
	const digits = value.slice(1);
	for (const ch of digits) {
		if ('0123456789abcdef'.indexOf(ch) < 0) return 'other';
	}

	let channels: string[];
	let alpha: string;
	if (digits.length === 3 || digits.length === 4) {
		channels = [digits.charAt(0), digits.charAt(1), digits.charAt(2)];
		alpha = digits.length === 4 ? digits.charAt(3) : 'f';
	} else if (digits.length === 6 || digits.length === 8) {
		channels = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
		alpha = digits.length === 8 ? digits.slice(6, 8) : 'ff';
	} else {
		return 'other';
	}

	// A translucent paint is not the flat ink or paper this pass is allowed to reinterpret.
	if (alpha !== 'f' && alpha !== 'ff') return 'other';

	const first = channels[0];
	if (first === undefined) return 'other';
	for (const channel of channels) {
		if (channel !== first) return 'other';
	}
	if (first === '0' || first === '00') return 'ink';
	if (first === 'f' || first === 'ff') return 'paper';
	return 'other';
}

function classifyRgb(value: string): PaintClass {
	if (!value.endsWith(')')) return 'other';
	const open = value.indexOf('(');

	const parts: string[] = [];
	for (const part of value.slice(open + 1, value.length - 1).split(/[\s,/]+/)) {
		const trimmed = trimAscii(part);
		if (trimmed !== '') parts.push(trimmed);
	}
	if (parts.length !== 3 && parts.length !== 4) return 'other';

	const alpha = parts.length === 4 ? parts[3] : undefined;
	if (alpha !== undefined && !isOpaqueAlpha(alpha)) return 'other';

	let ink = true;
	let paper = true;
	for (let i = 0; i < 3; i++) {
		const channel = channelValue(parts[i]);
		if (channel === undefined) return 'other';
		if (channel !== 0) ink = false;
		if (channel !== 255) paper = false;
	}
	if (ink) return 'ink';
	if (paper) return 'paper';
	return 'other';
}

/** The 0–255 value of one `rgb()` component, percentage or number. */
function channelValue(part: string | undefined): number | undefined {
	if (part === undefined) return undefined;
	if (part.endsWith('%')) {
		const percent = Number(part.slice(0, part.length - 1));
		if (!Number.isFinite(percent)) return undefined;
		return (percent * 255) / 100;
	}
	const n = Number(part);
	return Number.isFinite(n) ? n : undefined;
}

function isOpaqueAlpha(part: string): boolean {
	if (part.endsWith('%')) return Number(part.slice(0, part.length - 1)) === 100;
	return Number(part) === 1;
}

/**
 * `String.prototype.trim` covers the full Unicode whitespace set, which is more than CSS means.
 * Keeping a local helper is also the #48 lesson: Pretty BibTeX 2.0.0 monkey-patched
 * `String.prototype.replaceAll` out from under this plugin and silently killed two whole stages.
 */
function trimAscii(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && isAsciiSpace(value.charAt(start))) start++;
	while (end > start && isAsciiSpace(value.charAt(end - 1))) end--;
	return value.slice(start, end);
}

function isAsciiSpace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}
