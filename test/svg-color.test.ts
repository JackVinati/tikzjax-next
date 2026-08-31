// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
	applyColorModel,
	classifyColor,
	PAPER_FILL_CLASS,
	PAPER_STROKE_CLASS,
} from '../src/svg/colors';
import { applyInkBounds, formatNumber, formatViewBox, parseViewBox } from '../src/svg/geometry';
import { PipelineError, runPipeline, type Stage } from '../src/svg/pipeline';

function parse(svg: string): Document {
	return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

function serialize(doc: Document): string {
	return new XMLSerializer().serializeToString(doc);
}

function one(doc: Document, selector: string): Element {
	const el = doc.querySelector(selector);
	if (el === null) throw new Error(`fixture has no ${selector}`);
	return el;
}

function svgDoc(body: string, rootAttrs = 'viewBox="-72 -72 100 50"'): Document {
	return parse(`<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${body}</svg>`);
}

// -------------------------------------------------------------------------------------------
// colors.ts

describe('classifyColor', () => {
	it('recognises every black the engine and SVGO can emit', () => {
		for (const value of [
			'black',
			'BLACK',
			' black ',
			'#000',
			'#000000',
			'#000f',
			'#000000ff',
			'rgb(0,0,0)',
			'rgb(0, 0, 0)',
			'rgb(0%,0%,0%)',
			'rgb(0 0 0)',
			'rgba(0,0,0,1)',
		]) {
			expect(classifyColor(value), value).toBe('ink');
		}
	});

	it('recognises the same set for white', () => {
		for (const value of [
			'white',
			'#fff',
			'#FFFFFF',
			'#ffff',
			'rgb(255,255,255)',
			'rgb(100%, 100%, 100%)',
			'rgba(255 255 255 / 1)',
		]) {
			expect(classifyColor(value), value).toBe('paper');
		}
	});

	it('leaves everything else alone, including near-black and translucent paints', () => {
		for (const value of [
			'currentColor',
			'none',
			'#010101',
			'#001',
			'red',
			'#ff7f00',
			'rgb(0,0,0,0.5)',
			'rgba(0,0,0,0)',
			'#00000080',
			'url(#gradient)',
			'',
			'rgb(0,0)',
			'#0000000',
		]) {
			expect(classifyColor(value), value).toBe('other');
		}
	});
});

describe('applyColorModel — the four emitters', () => {
	// The engine's four sources of default ink, verified in the bundle (DESIGN §7.5).
	const emitters = [
		'<rect x="0" y="0" width="10" height="1" fill="black"/>',
		'<text alignment-baseline="baseline" font-family="cmr10" fill="black">x</text>',
		'<span style="line-height: 0; color: black; font-family: cmr10;">y</span>',
		'<path d="M0 0" stroke="#000" fill="none"/>',
	].join('');

	it('rewrites all four to currentColor', () => {
		const doc = svgDoc(emitters);
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'rect').getAttribute('fill')).toBe('currentColor');
		expect(one(doc, 'text').getAttribute('fill')).toBe('currentColor');
		expect(one(doc, 'path').getAttribute('stroke')).toBe('currentColor');
		expect(one(doc, 'span').getAttribute('style')).toContain('color: currentColor');
		// Emitter 4 is the one a regex over outerHTML cannot reach; make sure nothing survives.
		expect(serialize(doc)).not.toContain('black');
	});

	it('preserves the rest of an unquoted style declaration', () => {
		const doc = svgDoc(emitters);
		applyColorModel(doc, 'adapt');

		const style = one(doc, 'span').getAttribute('style') ?? '';
		expect(style).toContain('line-height: 0');
		expect(style).toContain('font-family: cmr10');
	});

	it('does not disturb the attributes it has no opinion about', () => {
		const doc = svgDoc(emitters);
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'text').getAttribute('alignment-baseline')).toBe('baseline');
		expect(one(doc, 'path').getAttribute('fill')).toBe('none');
	});

	it('handles a style declaration with no spaces and in upper case', () => {
		const doc = svgDoc('<span style="COLOR:BLACK">y</span><g style="fill:#000;stroke:#000"/>');
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'span').getAttribute('style')).toBe('color: currentColor');
		expect(one(doc, 'g').getAttribute('style')).toBe(
			'fill: currentColor; stroke: currentColor',
		);
	});

	it('keeps !important when rewriting a declaration', () => {
		const doc = svgDoc('<g style="stroke: rgb(0%,0%,0%) !important"/>');
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'g').getAttribute('style')).toBe('stroke: currentColor !important');
	});

	it('leaves a style attribute byte-identical when nothing in it matched', () => {
		const doc = svgDoc('<g style="fill:red;stroke-width:.4pt"/>');
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'g').getAttribute('style')).toBe('fill:red;stroke-width:.4pt');
	});

	it('splits declarations on top-level semicolons only', () => {
		const doc = svgDoc(`<g style="fill:white;background-image:url('a;b.png')"/>`);
		applyColorModel(doc, 'adapt');

		const g = one(doc, 'g');
		expect(g.getAttribute('style')).toBe(`background-image:url('a;b.png')`);
		expect(g.getAttribute('class')).toBe(PAPER_FILL_CLASS);
	});

	it('removes the style attribute when the paper paint was all it held', () => {
		const doc = svgDoc('<g style="fill: white"/>');
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'g').hasAttribute('style')).toBe(false);
		expect(one(doc, 'g').getAttribute('class')).toBe(PAPER_FILL_CLASS);
	});
});

describe('applyColorModel — paper', () => {
	it('removes the attribute and adds a class rather than writing var()', () => {
		const doc = svgDoc('<circle fill="white"/><line stroke="#FFFFFF"/>');
		applyColorModel(doc, 'adapt');

		const circle = one(doc, 'circle');
		expect(circle.hasAttribute('fill')).toBe(false);
		expect(circle.getAttribute('class')).toBe(PAPER_FILL_CLASS);

		const line = one(doc, 'line');
		expect(line.hasAttribute('stroke')).toBe(false);
		expect(line.getAttribute('class')).toBe(PAPER_STROKE_CLASS);

		// #21/#97: an unresolvable var() in a presentation attribute is invalid at computed-value
		// time and `fill` falls back to BLACK, so a copied SVG comes out inverted.
		expect(serialize(doc)).not.toContain('var(');
	});

	it('appends to an existing class list without duplicating', () => {
		const doc = svgDoc(`<g class="pgfsys" fill="white" stroke="white"/>`);
		applyColorModel(doc, 'adapt');
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'g').getAttribute('class')).toBe(
			`pgfsys ${PAPER_FILL_CLASS} ${PAPER_STROKE_CLASS}`,
		);
	});

	it('leaves a white `color` verbatim — there is no tz-paper-color rule to resolve it', () => {
		const doc = svgDoc('<span style="color: white">y</span><text color="white">z</text>');
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'span').getAttribute('style')).toBe('color: white');
		expect(one(doc, 'text').getAttribute('color')).toBe('white');
	});
});

describe("applyColorModel — the author's deliberate white (#15)", () => {
	// white-fill.tex: a white disc punched out of an orange rectangle, outlined in black.
	const fixture =
		'<path fill="#ff7f00" d="M-56 -28h112v56h-112z"/>' +
		'<circle cx="0" cy="0" r="17" fill="white"/>' +
		'<circle cx="0" cy="0" r="17" fill="none" stroke="black"/>';

	it('adapt: the white disc becomes paper, never black, and the orange is untouched', () => {
		const doc = svgDoc(fixture);
		applyColorModel(doc, 'adapt');

		const disc = doc.querySelectorAll('circle')[0];
		expect(disc?.hasAttribute('fill')).toBe(false);
		expect(disc?.getAttribute('class')).toBe(PAPER_FILL_CLASS);

		expect(one(doc, 'path').getAttribute('fill')).toBe('#ff7f00');
		expect(doc.querySelectorAll('circle')[1]?.getAttribute('stroke')).toBe('currentColor');

		const out = serialize(doc);
		expect(out).not.toContain('#000');
		expect(out).not.toContain('black');
		expect(out).not.toContain('white');
	});

	it('preserve: the document is left exactly as the engine emitted it', () => {
		const doc = svgDoc(fixture);
		const before = serialize(doc);
		applyColorModel(doc, 'preserve');

		expect(serialize(doc)).toBe(before);
	});

	it('invert is a CSS filter, so the literal black and white must survive the pass', () => {
		const doc = svgDoc(fixture);
		const before = serialize(doc);
		applyColorModel(doc, 'invert');

		expect(serialize(doc)).toBe(before);
	});

	it('paper runs the same DOM pass as adapt — the mode lives in the CSS variables', () => {
		const adapted = svgDoc(fixture);
		applyColorModel(adapted, 'adapt');
		const papered = svgDoc(fixture);
		applyColorModel(papered, 'paper');

		expect(serialize(papered)).toBe(serialize(adapted));
	});

	it('is idempotent, so a re-run over a cached artifact changes nothing', () => {
		const doc = svgDoc(fixture);
		applyColorModel(doc, 'adapt');
		const once = serialize(doc);
		applyColorModel(doc, 'adapt');

		expect(serialize(doc)).toBe(once);
	});
});

describe('applyColorModel — gradients (#73)', () => {
	const fixture =
		'<defs>' +
		'<linearGradient id="g">' +
		'<stop offset="0" stop-color="#000"/>' +
		'<stop offset="1" stop-color="#fff" style="stop-color:#fff"/>' +
		'</linearGradient>' +
		'<radialGradient id="b">' +
		'<stop offset="0" fill="black" style="color: black; stop-color: white"/>' +
		'</radialGradient>' +
		'</defs>' +
		'<rect fill="url(#g)" stroke="black"/>';

	it('leaves every stop alone — rewriting a ball-colour ramp flattens the shading', () => {
		const doc = svgDoc(fixture);
		applyColorModel(doc, 'adapt');

		const stops = doc.querySelectorAll('stop');
		expect(stops.length).toBe(3);
		expect(stops[0]?.getAttribute('stop-color')).toBe('#000');
		expect(stops[1]?.getAttribute('style')).toBe('stop-color:#fff');
		expect(stops[2]?.getAttribute('fill')).toBe('black');
		expect(stops[2]?.getAttribute('style')).toBe('color: black; stop-color: white');
		for (const stop of stops) expect(stop.hasAttribute('class')).toBe(false);
	});

	it('still adapts the element that references the gradient', () => {
		const doc = svgDoc(fixture);
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'rect').getAttribute('fill')).toBe('url(#g)');
		expect(one(doc, 'rect').getAttribute('stroke')).toBe('currentColor');
	});
});

// -------------------------------------------------------------------------------------------
// geometry.ts

describe('parseViewBox / formatViewBox', () => {
	it('accepts the separators the spec allows', () => {
		expect(parseViewBox('-72 -72 100 50')).toEqual({
			x: -72,
			y: -72,
			width: 100,
			height: 50,
		});
		expect(parseViewBox('0,0,10,5')).toEqual({
			x: 0,
			y: 0,
			width: 10,
			height: 5,
		});
		expect(parseViewBox('  0 , 0   10\n5 ')).toEqual({
			x: 0,
			y: 0,
			width: 10,
			height: 5,
		});
		expect(parseViewBox('0 0 1e2 5.5')).toEqual({
			x: 0,
			y: 0,
			width: 100,
			height: 5.5,
		});
	});

	it('rejects anything that is not four usable numbers', () => {
		expect(parseViewBox(null)).toBeNull();
		expect(parseViewBox(undefined)).toBeNull();
		expect(parseViewBox('')).toBeNull();
		expect(parseViewBox('0 0 10')).toBeNull();
		expect(parseViewBox('0 0 10 5 5')).toBeNull();
		expect(parseViewBox('0 0 10px 5')).toBeNull();
		// A negative extent is an error per the SVG spec, not data to carry forward.
		expect(parseViewBox('0 0 -10 5')).toBeNull();
	});

	it('round-trips and trims noise from the numbers', () => {
		expect(formatViewBox({ x: -72, y: -72, width: 100, height: 50 })).toBe('-72 -72 100 50');
		expect(formatViewBox({ x: 0.1 + 0.2, y: 0, width: 1 / 3, height: 2 })).toBe(
			'0.3 0 0.33333 2',
		);
		expect(formatNumber(-0.0000001)).toBe('0');
	});
});

describe('applyInkBounds', () => {
	it('replaces the engine frame with the measured ink, keeping the physical size', () => {
		// The engine's frame: origin shifted by an inch, extent not (#66, #71) — so the ink
		// genuinely runs past the right edge of `viewBox="-72 -72 100 50"`.
		const doc = svgDoc('', 'width="100pt" height="50pt" viewBox="-72 -72 100 50"');
		applyInkBounds(doc, { x: -70.5, y: -40, width: 120.25, height: 60 });

		const root = doc.documentElement;
		expect(root.getAttribute('viewBox')).toBe('-70.5 -40 120.25 60');
		expect(root.getAttribute('width')).toBe('120.25pt');
		expect(root.getAttribute('height')).toBe('60pt');
	});

	it('honours a document whose width is not 1:1 with its user units', () => {
		const doc = svgDoc('', 'width="200" height="100" viewBox="0 0 100 50"');
		applyInkBounds(doc, { x: 1, y: 2, width: 10, height: 5 });

		const root = doc.documentElement;
		expect(root.getAttribute('viewBox')).toBe('1 2 10 5');
		expect(root.getAttribute('width')).toBe('20');
		expect(root.getAttribute('height')).toBe('10');
	});

	it('falls back to 1 user unit = 1 pt when there is no readable viewBox', () => {
		const doc = svgDoc('', 'width="100pt" height="50pt"');
		applyInkBounds(doc, { x: 0, y: 0, width: 10, height: 5 });

		expect(doc.documentElement.getAttribute('width')).toBe('10pt');
		expect(doc.documentElement.getAttribute('height')).toBe('5pt');
		expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 10 5');
	});

	it('does not invent width/height on a document that sizes itself', () => {
		const doc = svgDoc('', 'viewBox="-72 -72 100 50"');
		applyInkBounds(doc, { x: 0, y: 0, width: 10, height: 5 });

		expect(doc.documentElement.hasAttribute('width')).toBe(false);
		expect(doc.documentElement.hasAttribute('height')).toBe(false);
		expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 10 5');
	});

	it('refuses a bounding box that would collapse the diagram', () => {
		const doc = svgDoc('', 'width="100pt" height="50pt" viewBox="-72 -72 100 50"');
		const before = serialize(doc);

		expect(() => applyInkBounds(doc, { x: 0, y: 0, width: 0, height: 5 })).toThrow(RangeError);
		expect(() => applyInkBounds(doc, { x: 0, y: 0, width: NaN, height: 5 })).toThrow(
			RangeError,
		);
		expect(() => applyInkBounds(doc, { x: Infinity, y: 0, width: 1, height: 5 })).toThrow(
			RangeError,
		);
		// A refusal must leave the engine's own frame in place to mount with.
		expect(serialize(doc)).toBe(before);
	});

	it('refuses a document that is not an SVG', () => {
		const doc = parse('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>');
		expect(() => applyInkBounds(doc, { x: 0, y: 0, width: 1, height: 1 })).toThrow(/not <svg>/);
	});
});

// -------------------------------------------------------------------------------------------
// pipeline.ts

function stage(name: string, run: (doc: Document) => void, mandatory?: boolean): Stage {
	return mandatory === undefined ? { name, run } : { name, mandatory, run };
}

function mark(name: string): Stage {
	return stage(name, (doc) => {
		doc.documentElement.setAttribute(`data-${name}`, '1');
	});
}

describe('runPipeline', () => {
	it('runs stages in order and leaves the input document untouched', () => {
		const doc = svgDoc('<rect/>');
		const before = serialize(doc);
		const seen: string[] = [];

		const result = runPipeline(doc, [
			stage('a', (d) => {
				seen.push('a');
				d.documentElement.setAttribute('data-order', 'a');
			}),
			stage('b', (d) => {
				seen.push('b');
				d.documentElement.setAttribute(
					'data-order',
					`${d.documentElement.getAttribute('data-order') ?? ''}b`,
				);
			}),
		]);

		expect(seen).toEqual(['a', 'b']);
		expect(result.doc.documentElement.getAttribute('data-order')).toBe('ab');
		expect(result.degraded).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(serialize(doc)).toBe(before);
	});

	it('skips a throwing stage, keeps the previous output, and names it in the warning', () => {
		const doc = svgDoc('<rect/>');
		let sawHalfWrite: string | null = 'unset';

		const result = runPipeline(doc, [
			mark('first'),
			stage('optimize', (d) => {
				// Mutate, THEN fail: the half-written state must not survive.
				d.documentElement.setAttribute('data-half-written', '1');
				throw new TypeError('svgo.optimize is not a function');
			}),
			stage('last', (d) => {
				sawHalfWrite = d.documentElement.getAttribute('data-half-written');
			}),
		]);

		expect(result.degraded).toBe(true);
		expect(result.skipped).toEqual(['optimize']);
		expect(result.warnings[0]).toContain('optimize');
		expect(result.warnings[0]).toContain('svgo.optimize is not a function');
		expect(sawHalfWrite).toBeNull();
		expect(result.doc.documentElement.getAttribute('data-half-written')).toBeNull();
		// The document itself is intact, not a raw-SVG fall-through (#15, #48).
		expect(result.doc.documentElement.getAttribute('data-first')).toBe('1');
		expect(result.doc.querySelector('rect')).not.toBeNull();
	});

	it('still runs sanitize and ids when a stage between them degrades', () => {
		const result = runPipeline(svgDoc('<rect/>'), [
			mark('sanitize'),
			stage('colors', () => {
				throw new Error('boom');
			}),
			mark('ids'),
		]);

		expect(result.degraded).toBe(true);
		expect(result.doc.documentElement.getAttribute('data-sanitize')).toBe('1');
		expect(result.doc.documentElement.getAttribute('data-ids')).toBe('1');
	});

	it('treats sanitize and ids as mandatory even when the flag was forgotten', () => {
		expect(() =>
			runPipeline(svgDoc('<rect/>'), [
				stage('sanitize', () => {
					throw new Error('cannot certify this document');
				}),
			]),
		).toThrow(PipelineError);

		try {
			runPipeline(svgDoc('<rect/>'), [
				stage('ids', () => {
					throw new Error('token already present');
				}),
			]);
			expect.unreachable('a failing ids stage must not degrade silently');
		} catch (error) {
			expect(error).toBeInstanceOf(PipelineError);
			expect((error as PipelineError).stage).toBe('ids');
			expect((error as PipelineError).message).toContain('token already present');
		}
	});

	it('honours an explicit mandatory flag on any stage', () => {
		expect(() =>
			runPipeline(svgDoc('<rect/>'), [
				stage(
					'entities',
					() => {
						throw new Error('nope');
					},
					true,
				),
			]),
		).toThrow(PipelineError);
	});

	it('raw runs only the mandatory stages, and that is not a degradation', () => {
		const result = runPipeline(
			svgDoc('<rect/>'),
			[mark('sanitize'), mark('optimize'), mark('ids')],
			{
				raw: true,
			},
		);

		expect(result.doc.documentElement.getAttribute('data-sanitize')).toBe('1');
		expect(result.doc.documentElement.getAttribute('data-ids')).toBe('1');
		expect(result.doc.documentElement.hasAttribute('data-optimize')).toBe(false);
		expect(result.degraded).toBe(false);
	});

	it('says so in the warning when it could not snapshot before the failure', () => {
		const doc = svgDoc('<rect/>');
		// A host whose documents cannot be cloned: the runner has to fall back to mutating in
		// place, and must be honest that a partial edit may have survived.
		const uncloneable = new Proxy(doc, {
			get(target, property) {
				if (property === 'cloneNode') {
					return () => {
						throw new Error('cloneNode is not supported here');
					};
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});

		const result = runPipeline(uncloneable, [
			stage('colors', (d) => {
				d.documentElement.setAttribute('data-half-written', '1');
				throw new Error('boom');
			}),
		]);

		expect(result.degraded).toBe(true);
		expect(result.warnings[0]).toContain('may have been applied');
		expect(result.doc.documentElement.getAttribute('data-half-written')).toBe('1');
	});

	it('reports a non-Error throw rather than losing it', () => {
		const result = runPipeline(svgDoc('<rect/>'), [
			stage('optimize', () => {
				throw 'string thrown by a minified dependency';
			}),
		]);

		expect(result.warnings[0]).toContain('string thrown by a minified dependency');
	});

	it('is a no-op for an empty stage list', () => {
		const doc = svgDoc('<rect/>');
		const result = runPipeline(doc, []);

		expect(result.doc).toBe(doc);
		expect(result.degraded).toBe(false);
	});

	it('carries the real colour and geometry stages', () => {
		const doc = svgDoc(
			'<rect fill="black"/>',
			'width="100pt" height="50pt" viewBox="-72 -72 100 50"',
		);
		const result = runPipeline(doc, [
			stage('colors', (d) => {
				applyColorModel(d, 'adapt');
			}),
			stage('geometry', (d) => {
				applyInkBounds(d, { x: -72, y: -72, width: 110, height: 60 });
			}),
		]);

		expect(result.degraded).toBe(false);
		expect(one(result.doc, 'rect').getAttribute('fill')).toBe('currentColor');
		expect(result.doc.documentElement.getAttribute('viewBox')).toBe('-72 -72 110 60');
	});

	it('degrades rather than losing the diagram when geometry gets a bad measurement', () => {
		const doc = svgDoc(
			'<rect fill="black"/>',
			'width="100pt" height="50pt" viewBox="-72 -72 100 50"',
		);
		const result = runPipeline(doc, [
			stage('colors', (d) => {
				applyColorModel(d, 'adapt');
			}),
			stage('geometry', (d) => {
				applyInkBounds(d, { x: 0, y: 0, width: 0, height: 0 });
			}),
			mark('ids'),
		]);

		expect(result.degraded).toBe(true);
		expect(result.skipped).toEqual(['geometry']);
		expect(one(result.doc, 'rect').getAttribute('fill')).toBe('currentColor');
		expect(result.doc.documentElement.getAttribute('viewBox')).toBe('-72 -72 100 50');
		expect(result.doc.documentElement.getAttribute('data-ids')).toBe('1');
	});
});

// -------------------------------------------------------------------------------------------
// Adversarial review additions

describe('applyColorModel — <mask> contents are opacity data, not ink', () => {
	// pgf's dvisvgm driver implements \tikzfading / `path fading` / `scope fading` by emitting a
	// <mask>, where the LUMINANCE of the mask content is the alpha channel: white = fully opaque,
	// black = fully transparent. Recolouring it does not merely change a colour, it changes what
	// is visible — and in a dark theme `var(--tikz-paper)` is nearly black, so a masked diagram
	// fades out to almost nothing. Same family as the #73 gradient-stop skip, worse consequence.
	const fixture =
		'<defs><mask id="fade">' +
		'<rect x="0" y="0" width="10" height="10" fill="white"/>' +
		'<circle cx="5" cy="5" r="2" fill="black" style="stroke: black"/>' +
		'</mask></defs>' +
		'<rect fill="black" mask="url(#fade)"/>';

	it('leaves every paint inside a mask exactly as the engine wrote it', () => {
		const doc = svgDoc(fixture);
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'mask rect').getAttribute('fill')).toBe('white');
		expect(one(doc, 'mask rect').hasAttribute('class')).toBe(false);
		expect(one(doc, 'mask circle').getAttribute('fill')).toBe('black');
		expect(one(doc, 'mask circle').getAttribute('style')).toBe('stroke: black');
	});

	it('still adapts the masked element itself', () => {
		const doc = svgDoc(fixture);
		applyColorModel(doc, 'adapt');

		const painted = doc.querySelectorAll('svg > rect')[0];
		expect(painted?.getAttribute('fill')).toBe('currentColor');
		expect(painted?.getAttribute('mask')).toBe('url(#fade)');
	});

	it('does not skip a <pattern>, whose contents really are ink (#59)', () => {
		const doc = svgDoc(
			'<defs><pattern id="p"><path d="M0 0" stroke="black"/></pattern></defs>' +
				'<rect fill="url(#p)"/>',
		);
		applyColorModel(doc, 'adapt');

		expect(one(doc, 'pattern path').getAttribute('stroke')).toBe('currentColor');
	});
});

describe('applyInkBounds — a percentage extent is not in user units', () => {
	it('leaves a percentage width/height alone and still corrects the frame', () => {
		// `width="100%"` is resolved against the CONTAINER, so no scale relates it to the ink box.
		// Rescaling it by viewBox ratio shrinks the diagram to a tenth of its box — the same class
		// of "the diagram is suddenly tiny" bug the geometry stage exists to fix.
		const doc = svgDoc('', 'width="100%" height="100%" viewBox="0 0 100 50"');
		applyInkBounds(doc, { x: 0, y: 0, width: 10, height: 5 });

		const root = doc.documentElement;
		expect(root.getAttribute('width')).toBe('100%');
		expect(root.getAttribute('height')).toBe('100%');
		expect(root.getAttribute('viewBox')).toBe('0 0 10 5');
	});

	it('still rescales an absolute extent alongside a percentage one', () => {
		const doc = svgDoc('', 'width="100%" height="50pt" viewBox="0 0 100 50"');
		applyInkBounds(doc, { x: 0, y: 0, width: 10, height: 5 });

		expect(doc.documentElement.getAttribute('width')).toBe('100%');
		expect(doc.documentElement.getAttribute('height')).toBe('5pt');
	});
});

describe('runPipeline — a stage throw can never escape', () => {
	it('survives a thrown value that cannot be stringified', () => {
		// #48 is a monkey-patched String.prototype killing a stage silently. A null-prototype
		// throw makes `String(error)` itself throw, so a describe() that is not defensive turns
		// the isolation layer into the thing that crashes the render.
		const result = runPipeline(svgDoc('<rect/>'), [
			stage('optimize', () => {
				throw Object.create(null) as unknown;
			}),
		]);

		expect(result.degraded).toBe(true);
		expect(result.skipped).toEqual(['optimize']);
		expect(result.warnings[0]).toContain('optimize');
		expect(result.doc.querySelector('rect')).not.toBeNull();
	});
})
