import type { Stage } from './pipeline';

/**
 * SVG optimisation. See docs/DESIGN.md §7.3.
 *
 * Three modes, and the interesting one is `targeted`.
 *
 * The shipped plugin runs SVGO's `preset-default` over every diagram, on the main thread, for one
 * documented reason: it fixes misaligned text on mobile (upstream #6). That is a 2022 issue with
 * zero comments and no reproducer, and paying 8–270 ms per diagram plus 587 KB of bundle for it is
 * a poor trade if a 40-line transform does the same job. But we will not delete SVGO on a guess
 * either — `preset` stays the default until #6 is reproduced on a real device against a fixture.
 *
 * Both known regressions in the shipped configuration are fixed here:
 *   - `removeViewBox` is enabled by preset-default and strips the attribute the whole geometry
 *     correction depends on;
 *   - `cleanupNumericValues` converts pt→px whenever the string comes out shorter, so
 *     `width="113.386pt" height="56.693pt"` silently becomes `151.181`/`75.591` (×4/3) — and for
 *     `100.0pt`/`50.00000pt` it converts only the HEIGHT, breaking the aspect ratio (#12 #42 #50 #66).
 */

export type OptimizeMode = 'preset' | 'targeted' | 'off';

// -------------------------------------------------------------------------------------------
// The targeted transform

const TRANSFORM_CHAIN = /^\s*scale\(\s*-1\s*,?\s*1\s*\)\s*translate\(([^)]*)\)\s*scale\(\s*-1\s*,?\s*-1\s*\)\s*$/;

/**
 * Collapse dvi2html's text-group transform into a single matrix and drop `alignment-baseline`.
 *
 * `alignment-baseline` is not valid on `<text>` per the SVG spec (it applies to `<tspan>` and
 * friends), and it is precisely where WebKit and Blink disagree — the most plausible mechanism
 * behind #6's misaligned mobile text. Removing it is the fix; collapsing the transform chain is
 * the cheap byte win that comes with walking the tree anyway.
 *
 * Implemented as arithmetic on the transform ATTRIBUTE STRING, deliberately, not via
 * `SVGTransformList.consolidate()`: neither jsdom nor happy-dom implements `consolidate`, so a
 * DOM-based version could not be tested in Node at all — and an untestable transform on the hot
 * path is how you ship a subtly wrong diagram to everyone.
 */
export function targetedTransform(doc: Document): void {
	for (const text of Array.from(doc.getElementsByTagName('text'))) {
		text.removeAttribute('alignment-baseline');
	}

	for (const el of Array.from(doc.querySelectorAll('[transform]'))) {
		const value = el.getAttribute('transform');
		if (value === null) continue;

		const m = TRANSFORM_CHAIN.exec(value);
		if (!m) continue;

		const parts = (m[1] ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
		const [a = 0, b = 0] = parts;
		if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

		// scale(-1,1) · translate(a,b) · scale(-1,-1)  ==  matrix(1, 0, 0, -1, -a, b)
		el.setAttribute('transform', `matrix(1 0 0 -1 ${trim(-a)} ${trim(b)})`);
	}
}

/** Drops the trailing zeros JSON-ish number formatting leaves behind, without losing precision. */
function trim(n: number): string {
	return String(Number(n.toFixed(6)));
}

// -------------------------------------------------------------------------------------------
// SVGO

/**
 * Overrides for SVGO's `preset-default`. Every one of these is a live regression in the shipped
 * plugin, not a preference.
 *
 * `cleanupIds` is spelled with a lowercase `d` in SVGO 3+; it was `cleanupIDs` in v2. The shipped
 * plugin passes `cleanupIDs: false` against a vendored v2, which is correct there and becomes a
 * SILENT NO-OP on any upgrade — re-minifying ids to `a`, `b`, `c` and reintroducing #12 across
 * every diagram in a note. A unit test asserts ids are unchanged after optimize(), which is the
 * guard against that rename landmine in either direction.
 */
export const SVGO_OVERRIDES = {
	cleanupIds: false,
	removeViewBox: false,
	removeTitle: false,
	removeDesc: false,
	cleanupNumericValues: { convertToPx: false },
	convertPathData: { floatPrecision: 5 },
} as const;

export interface SvgoLike {
	optimize(svg: string, config: unknown): { data?: string; error?: string };
}

/**
 * SVGO operates on a string, not a DOM, so it cannot be a `Stage` over the parsed document. It is
 * applied by the caller around the DOM stages instead; this wraps the call so the failure shapes
 * are handled in one place.
 *
 * SVGO v2 returns `{ error }` with NO `.data` on a parse failure. The shipped plugin reads `.data`
 * behind a `@ts-ignore`, so a failed optimisation writes the literal string `"undefined"` into the
 * note.
 */
export function optimizeString(svgo: SvgoLike, svg: string): string {
	const result = svgo.optimize(svg, {
		plugins: [{ name: 'preset-default', params: { overrides: SVGO_OVERRIDES } }],
	});
	if (typeof result.data !== 'string' || result.data.length === 0) {
		throw new Error(`SVGO returned no output${result.error ? `: ${result.error}` : ''}`);
	}
	return result.data;
}

/** The targeted transform as a pipeline stage. Skippable: a failure degrades, it does not block. */
export function targetedStage(): Stage {
	return {
		name: 'optimize',
		run: targetedTransform,
	};
}
