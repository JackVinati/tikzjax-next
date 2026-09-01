// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { freezeSvg, type FreezeOptions } from '../src/svg/freeze';
import { applyColorModel, PAPER_FILL_CLASS, PAPER_STROKE_CLASS } from '../src/svg/colors';

/**
 * What these tests are for: a frozen SVG is read by something that has NEVER seen Obsidian's
 * stylesheet — a file manager preview, an `<img src>`, Publish, an email, Inkscape. So every
 * assertion here is about what survives that: literals instead of `currentColor`, literals instead
 * of the `.tz-paper-*` classes, the referenced faces and only those, and a document that parses on
 * its own. Upstream #21, #33, #95, #97.
 */

const INK = '#e0def4';
const PAPER = '#191724';

/** Four faces, one per shape the real stylesheet emits, plus one that must never be selected. */
const FONT_CSS = [
	"@font-face{font-family:cmr10;src:url(data:font/woff2;base64,AAAAcmr10) format('woff2');font-display:block}",
	"@font-face{font-family:'cmmi10';src:url(data:font/woff2;base64,AAAAcmmi10) format('woff2')}",
	'@font-face { font-family : CMSY10 ; src : url(data:font/woff2;base64,AAAAcmsy10) format("woff2") }',
	"@font-face{font-family:cmbx12;src:url(data:font/woff2;base64,AAAAcmbx12) format('woff2')}",
].join('\n');

function options(overrides: Partial<FreezeOptions> = {}): FreezeOptions {
	return { ink: INK, paper: PAPER, fontCss: FONT_CSS, ...overrides };
}

function parse(svg: string): Document {
	return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

function one(doc: Document, selector: string): Element {
	const el = doc.querySelector(selector);
	if (el === null) throw new Error(`the frozen document has no ${selector}`);
	return el;
}

/** Reparse the frozen output. Every assertion below reads it back as a real document. */
function frozen(markup: string, overrides: Partial<FreezeOptions> = {}): Document {
	return parse(freezeSvg(markup, options(overrides)));
}

/** The families the emitted `<style>` actually carries, in the order it carries them. */
function inlinedFamilies(output: string): string[] {
	const families: string[] = [];
	for (const rule of output.split('@font-face').slice(1)) {
		const match = /font-family\s*:\s*['"]?([^;'"}]+)/i.exec(rule);
		if (match?.[1] !== undefined) families.push(match[1].trim().toLowerCase());
	}
	return families;
}

/** The text of the `<style>` this module emitted, as a CSS parser would receive it. */
function frozenStyleText(doc: Document): string {
	const style = doc.querySelector('style');
	if (style === null) throw new Error('the frozen document has no <style>');
	return style.textContent ?? '';
}

function countOf(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-72 -72 100 50">';

// -------------------------------------------------------------------------------------------
// currentColor

describe('freezeSvg: currentColor', () => {
	it('resolves currentColor inside a nested pattern, where a root-level color does not reach', () => {
		const doc = frozen(
			`${HEAD}<defs><pattern id="hatch" width="4" height="4">` +
				'<g><path id="tick" d="M0 0 L4 4" stroke="currentColor"/></g>' +
				'</pattern></defs><rect fill="url(#hatch)" width="10" height="10"/></svg>',
		);

		expect(one(doc, '#tick').getAttribute('stroke')).toBe(INK);
		expect(
			freezeSvg(
				`${HEAD}<defs><pattern><path stroke="currentColor"/></pattern></defs></svg>`,
				options(),
			),
		).not.toContain('currentColor');
	});

	it('resolves currentColor inside marker, mask and defs content too', () => {
		const doc = frozen(
			`${HEAD}<defs>` +
				'<marker id="m"><path id="head" fill="currentColor" d="M0 0"/></marker>' +
				'<mask id="k"><rect id="veil" fill="currentColor" width="1" height="1"/></mask>' +
				'<linearGradient id="g"><stop id="end" offset="1" stop-color="currentColor"/></linearGradient>' +
				'</defs></svg>',
		);

		expect(one(doc, '#head').getAttribute('fill')).toBe(INK);
		expect(one(doc, '#veil').getAttribute('fill')).toBe(INK);
		expect(one(doc, '#end').getAttribute('stop-color')).toBe(INK);
	});

	it('resolves currentColor inside a style declaration, keeping the rest of the declaration', () => {
		const doc = frozen(
			`${HEAD}<text id="t" style="line-height: 0; fill: currentColor !important; font-size: 10px">x</text></svg>`,
		);

		const style = one(doc, '#t').getAttribute('style') ?? '';
		expect(style).toContain(`fill: ${INK} !important`);
		expect(style).toContain('line-height: 0');
		expect(style).toContain('font-size: 10px');
	});

	it('follows an author colour rather than flattening a subtree to the theme ink', () => {
		// `\color{red}` survives colors.ts untouched — only TeX's default black became
		// currentColor — so a descendant's currentColor must resolve to the author's red.
		const doc = frozen(
			`${HEAD}<g color="red"><path id="p" stroke="currentColor" d="M0 0"/></g>` +
				'<path id="q" stroke="currentColor" d="M0 0"/></svg>',
		);

		expect(one(doc, '#p').getAttribute('stroke')).toBe('red');
		expect(one(doc, '#q').getAttribute('stroke')).toBe(INK);
	});

	it('pins the ink the plugin stylesheet supplies, so an unpainted glyph is not UA black', () => {
		// styles.css sets `.tikzjax-figure svg { fill: currentColor }` because dvi2html leaves the
		// glyph <use>s with no fill of their own. Outside Obsidian that rule is gone.
		const root = frozen(`${HEAD}<use id="g" href="#glyph"/></svg>`).documentElement;

		expect(root.getAttribute('fill')).toBe(INK);
		expect(root.getAttribute('color')).toBe(INK);
	});

	it('never overwrites a paint the document already declares on the root', () => {
		const root = frozen(
			`<svg xmlns="http://www.w3.org/2000/svg" fill="red" style="color: lime"/>`,
		).documentElement;

		expect(root.getAttribute('fill')).toBe('red');
		expect(root.getAttribute('color')).toBeNull();
		expect(root.getAttribute('style')).toContain('color: lime');
	});
});

// -------------------------------------------------------------------------------------------
// The paper classes

describe('freezeSvg: paper classes', () => {
	it('replaces the paper classes with literal paints and removes the class attribute', () => {
		const doc = frozen(
			`${HEAD}<rect id="plate" class="${PAPER_FILL_CLASS}" width="10" height="10"/>` +
				`<path id="edge" class="${PAPER_STROKE_CLASS}" d="M0 0"/></svg>`,
		);

		const plate = one(doc, '#plate');
		expect(plate.getAttribute('fill')).toBe(PAPER);
		expect(plate.getAttribute('class')).toBeNull();

		const edge = one(doc, '#edge');
		expect(edge.getAttribute('stroke')).toBe(PAPER);
		expect(edge.getAttribute('class')).toBeNull();
	});

	it('resolves the classes on the root itself, which SVGO hoists them onto', () => {
		const root = frozen(
			`<svg xmlns="http://www.w3.org/2000/svg" class="${PAPER_FILL_CLASS}"><path d="M0 0"/></svg>`,
		).documentElement;

		expect(root.getAttribute('fill')).toBe(PAPER);
		expect(root.getAttribute('class')).toBeNull();
	});

	it('keeps classes it does not own', () => {
		const doc = frozen(`${HEAD}<rect id="r" class="author-cls ${PAPER_FILL_CLASS} other"/></svg>`);

		expect(one(doc, '#r').getAttribute('fill')).toBe(PAPER);
		expect(one(doc, '#r').getAttribute('class')).toBe('author-cls other');
	});

	it('leaves no tz-paper class anywhere in the output', () => {
		const output = freezeSvg(
			`${HEAD}<g class="${PAPER_FILL_CLASS}"><rect class="${PAPER_STROKE_CLASS}"/></g></svg>`,
			options(),
		);

		expect(output).not.toContain('tz-paper');
	});
});

// -------------------------------------------------------------------------------------------
// The font subset

describe('freezeSvg: font subset', () => {
	it('inlines exactly the referenced faces and no others', () => {
		const output = freezeSvg(
			`${HEAD}<text font-family="cmr10">a</text><text font-family="CMSY10">b</text></svg>`,
			options(),
		);

		expect(inlinedFamilies(output).sort()).toEqual(['cmr10', 'cmsy10']);
		// The whole point of a subset: 140 faces is 4.8 MB, and a circle must not carry them.
		expect(output).not.toContain('cmbx12');
		expect(output).not.toContain('AAAAcmbx12');
		expect(output).not.toContain('AAAAcmmi10');
	});

	it('collects a family that appears only in a style declaration', () => {
		const output = freezeSvg(
			`${HEAD}<text style="font-size: 10px; font-family: cmmi10">x</text></svg>`,
			options(),
		);

		expect(inlinedFamilies(output)).toEqual(['cmmi10']);
	});

	it('collects every family of a fallback list, quoted or not', () => {
		const output = freezeSvg(
			`${HEAD}<text font-family="'cmr10', cmmi10, serif">x</text></svg>`,
			options(),
		);

		expect(inlinedFamilies(output).sort()).toEqual(['cmmi10', 'cmr10']);
	});

	it('copies the face rule verbatim, base64 payload and all', () => {
		const output = freezeSvg(`${HEAD}<text font-family="cmr10">x</text></svg>`, options());

		expect(output).toContain("url(data:font/woff2;base64,AAAAcmr10) format('woff2')");
	});

	it('emits a stylesheet a CSS parser accepts, whatever prose surrounds the rules', () => {
		// The caller hands over whole stylesheets — styles.css plus the cold string — and those are
		// authored files with comments in them. An `@font-face` occurrence that is NOT an at-rule
		// (the word inside a comment) must not be treated as the start of one: slicing from it
		// splices the comment's tail into the emitted <style>, and a stray `*/` there makes the
		// FIRST REAL RULE part of an invalid at-rule that the browser drops whole. The face then
		// silently fails to load and the export renders in a fallback face — the #21 symptom, from
		// the one stage that exists to prevent it.
		const css = `/* the ${'@font-' + 'face'} rules follow */
${FONT_CSS}`;
		const output = freezeSvg(
			`${HEAD}<text font-family="cmr10">x</text></svg>`,
			options({ fontCss: css }),
		);

		expect(inlinedFamilies(output)).toEqual(['cmr10']);

		const text = frozenStyleText(parse(output));
		expect(text.trimStart().startsWith('@font-face{')).toBe(true);
		expect(text).not.toContain('*/');
		expect(text).toContain('AAAAcmr10');
	});

	it('emits no style element when the diagram references no face', () => {
		const output = freezeSvg(`${HEAD}<path d="M0 0"/></svg>`, options());

		expect(output).not.toContain('<style');
		expect(output).not.toContain('@font-face');
	});

	it('emits no style element when the caller has no font stylesheet to give', () => {
		const output = freezeSvg(`${HEAD}<text font-family="cmr10">x</text></svg>`, options({ fontCss: '' }));

		expect(output).not.toContain('<style');
	});
});

// -------------------------------------------------------------------------------------------
// Namespaces

describe('freezeSvg: namespaces', () => {
	it('adds xmlns when it is missing — a fragment fine inline is invalid as a file', () => {
		const output = freezeSvg('<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>', options());

		expect(countOf(output, 'xmlns="http://www.w3.org/2000/svg"')).toBe(1);
		expect(parse(output).documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
	});

	it('does not duplicate a declaration that is already there', () => {
		const output = freezeSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0"/></svg>',
			options(),
		);

		expect(countOf(output, 'xmlns="')).toBe(1);
		expect(countOf(output, 'xmlns:xlink="')).toBe(1);
	});

	it('declares xlink, which dvi2html uses for every glyph reference', () => {
		// An undeclared prefix is a namespace error, not a cosmetic one: a real XML parser refuses
		// the whole file rather than the one attribute.
		const output = freezeSvg(`${HEAD}<use xlink:href="#glyph"/></svg>`, options());

		expect(countOf(output, 'xmlns:xlink="http://www.w3.org/1999/xlink"')).toBe(1);
	});

	it('does not accumulate on a re-freeze: no second font block, no second background', () => {
		// Freezing is lossy, so this is not a claim of reversibility — it is the promise that the
		// biggest node in the file is not silently doubled if the output is put through again.
		const source = `${HEAD}<text font-family="cmr10" fill="currentColor">x</text></svg>`;
		const once = freezeSvg(source, options({ opaque: true }));

		expect(freezeSvg(once, options({ opaque: true }))).toBe(once);
		expect(countOf(once, '@font-face')).toBe(1);
		expect(countOf(once, '<rect')).toBe(1);
	});
});

// -------------------------------------------------------------------------------------------
// The opaque background

describe('freezeSvg: opaque background', () => {
	it('prepends a paper rect covering the viewBox', () => {
		const doc = frozen(`${HEAD}<path id="p" d="M0 0"/></svg>`, { opaque: true });
		const rect = one(doc, 'rect');

		expect(rect.getAttribute('x')).toBe('-72');
		expect(rect.getAttribute('y')).toBe('-72');
		expect(rect.getAttribute('width')).toBe('100');
		expect(rect.getAttribute('height')).toBe('50');
		expect(rect.getAttribute('fill')).toBe(PAPER);
	});

	it('paints the rect behind the diagram, not over it', () => {
		// Also with a font block present, which is inserted at the same end of the document: SVG has
		// no z-index, so "behind" is only ever document order.
		const root = frozen(`${HEAD}<text font-family="cmr10">x</text></svg>`, {
			opaque: true,
		}).documentElement;
		const names: string[] = [];
		for (let i = 0; i < root.children.length; i++) {
			names.push(root.children.item(i)?.localName ?? '');
		}

		expect(names).toEqual(['style', 'rect', 'text']);
	});

	it('keeps a title first, so the accessible name still resolves', () => {
		const root = frozen(`${HEAD}<title>a graph</title><path d="M0 0"/></svg>`, {
			opaque: true,
		}).documentElement;

		expect(root.children.item(0)?.localName).toBe('title');
		expect(root.children.item(1)?.localName).toBe('rect');
	});

	it('keeps a title first even when the template carries the engine line breaks', () => {
		// SVGO collapses the whitespace between elements, but `raw` and `fast` (§7.11) skip SVGO
		// altogether, so a stored template really can begin with a line break. The injected nodes
		// must still land AFTER the <title>/<desc> pair, not in front of it.
		const nl = String.fromCharCode(10);
		const root = frozen(
			`${HEAD}${nl}	<title>a graph</title>${nl}	<desc>d</desc>${nl}	<text font-family="cmr10">x</text>${nl}</svg>`,
			{ opaque: true },
		).documentElement;
		const names: string[] = [];
		for (let i = 0; i < root.children.length; i++) names.push(root.children.item(i)?.localName ?? '');

		expect(names).toEqual(['title', 'desc', 'style', 'rect', 'text']);
	});

	it('falls back to the viewport when there is no viewBox to measure', () => {
		const doc = frozen('<svg xmlns="http://www.w3.org/2000/svg" width="10pt" height="5pt"/>', {
			opaque: true,
		});
		const rect = one(doc, 'rect');

		expect(rect.getAttribute('width')).toBe('100%');
		expect(rect.getAttribute('height')).toBe('100%');
	});

	it('adds nothing when the caller did not ask for it', () => {
		expect(freezeSvg(`${HEAD}<path d="M0 0"/></svg>`, options())).not.toContain('<rect');
		expect(freezeSvg(`${HEAD}<path d="M0 0"/></svg>`, options({ opaque: false }))).not.toContain('<rect');
	});
});

// -------------------------------------------------------------------------------------------
// The whole thing

describe('freezeSvg: the standalone file', () => {
	it('parses on its own as an SVG document, with nothing left to resolve', () => {
		const output = freezeSvg(
			'<svg viewBox="-72 -72 100 50">' +
				'<title>plot</title>' +
				`<g class="${PAPER_FILL_CLASS}"><rect id="plate" width="4" height="4"/></g>` +
				'<defs><pattern id="hatch"><path id="tick" stroke="currentColor" d="M0 0 L4 4"/></pattern></defs>' +
				'<text id="label" font-family="cmr10" fill="currentColor">n</text>' +
				'<use id="glyph" xlink:href="#tick"/>' +
				'</svg>',
			options({ opaque: true }),
		);

		const doc = parse(output);
		expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
		expect(doc.documentElement.localName).toBe('svg');
		expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(output).not.toContain('currentColor');
		expect(output).not.toContain('tz-paper');
		expect(output).not.toContain('var(--');
		expect(one(doc, '#tick').getAttribute('stroke')).toBe(INK);
		expect(one(doc, '#label').getAttribute('fill')).toBe(INK);
		expect(inlinedFamilies(output)).toEqual(['cmr10']);
	});

	it('undoes what the colour model actually did, not what a constant says it did', () => {
		// Every other test hands freeze a hand-written template. This one runs the REAL upstream
		// stage first, so the two modules are asserted against each other: if colors.ts ever moves
		// a paint to a different class, or stops writing `currentColor` for a paint freeze still
		// resolves, this fails where a test built from the exported constants would not.
		const engine =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-72 -72 100 50">' +
			'<rect id="bar" fill="black" width="4" height="4"/>' +
			'<rect id="plate" fill="white" width="8" height="8"/>' +
			'<path id="edge" stroke="#FFFFFF" fill="none" d="M0 0"/>' +
			'<text id="lbl" style="line-height: 0; color: black" font-family="cmr10">n</text>' +
			'</svg>';
		const doc = parse(engine);
		applyColorModel(doc, 'adapt');
		const neutral = new XMLSerializer().serializeToString(doc.documentElement);

		// The stored artifact leans on Obsidian for both halves.
		expect(neutral).toContain('currentColor');
		expect(neutral).toContain('tz-paper');

		const output = freezeSvg(neutral, options());
		const out = parse(output);
		expect(out.getElementsByTagName('parsererror')).toHaveLength(0);
		expect(one(out, '#bar').getAttribute('fill')).toBe(INK);
		expect(one(out, '#plate').getAttribute('fill')).toBe(PAPER);
		expect(one(out, '#edge').getAttribute('stroke')).toBe(PAPER);
		expect(one(out, '#lbl').getAttribute('style')).toContain(`color: ${INK}`);
		expect(output).not.toContain('tz-paper');
		expect(output).not.toContain('currentColor');
	});

	it('leaves the ids exactly as the caller stamped them', () => {
		const doc = frozen(
			`${HEAD}<defs><clipPath id="tabc1_2"><rect id="tabc1_3"/></clipPath></defs>` +
				'<g clip-path="url(#tabc1_2)"><use href="#tabc1_3"/></g></svg>',
			{ opaque: true },
		);

		expect(one(doc, '#tabc1_2')).toBeTruthy();
		expect(one(doc, '#tabc1_3')).toBeTruthy();
		expect(one(doc, 'g').getAttribute('clip-path')).toBe('url(#tabc1_2)');
	});
});

describe('inherited colour, per subtree', () => {
	/**
	 * In Obsidian the root carries `fill: currentColor` from styles.css, so an element with no fill
	 * of its own — dvi2html leaves most glyph <use>es and many <g>s that way — paints whatever
	 * `color` is in force AT ITS OWN DEPTH. A frozen file has no stylesheet, so pinning a single
	 * literal fill on the root flattens that: an author's `\color{red}` group, which the colour
	 * pass deliberately never touches, would have its unpainted children painted theme ink.
	 *
	 * Reported in review against exactly this shape.
	 */
	it('gives a colour-redefining group its own fill, so unpainted children follow it', () => {
		const doc = frozen(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
				`<g color="red"><use href="#glyph"/></g>` +
				`<use href="#other"/>` +
				`</svg>`,
		);

		// The group paints red, so its unpainted <use> inherits red rather than the ink.
		expect(one(doc, 'g').getAttribute('fill')).toBe('red');
		// The root still supplies the ink for everything outside that group.
		expect(doc.documentElement.getAttribute('fill')).toBe(INK);
	});

	it('does not put a fill on every node — only where the colour actually changes', () => {
		const doc = frozen(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
				`<g><use href="#glyph"/></g>` +
				`</svg>`,
		);
		expect(one(doc, 'g').hasAttribute('fill')).toBe(false);
		expect(one(doc, 'use').hasAttribute('fill')).toBe(false);
	});

	it('still leaves nothing unresolved', () => {
		const doc = frozen(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
				`<g color="red"><path fill="currentColor" d="M0 0"/></g>` +
				`</svg>`,
		);
		expect(new XMLSerializer().serializeToString(doc)).not.toContain('currentColor');
		expect(one(doc, 'path').getAttribute('fill')).toBe('red');
	});
});
