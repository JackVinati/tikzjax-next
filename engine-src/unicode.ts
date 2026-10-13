/*
 * Literal-Unicode bridge for the 8-bit TeX engine.
 *
 * TeX still owns layout: every Unicode codepoint is represented by a one-em box while the DVI is
 * built. dvi2html preserves the surrounding raw-SVG marker and supplies the current baseline
 * coordinates. Once conversion is complete we replace the proxy glyphs with the original text.
 * This keeps CJK text in ordinary TikZ nodes without pretending that the engine itself has become
 * Unicode-aware.
 */

import { isNativeUnicode } from '../src/source/native-unicode';

export interface UnicodeBridge {
	source: string;
	preamble: string;
	runs: readonly string[];
}

const CALL = String.raw`\csname tikzjaxUnicodeBridge\endcsname`;

// Kept out of the source body so TeX's l.N diagnostics continue to refer to the user's line.
const PREAMBLE = String.raw`\expandafter\long\expandafter\def\csname tikzjaxUnicodeBridge\endcsname#1#2{\special{dvisvgm:raw <g data-tikzjax-unicode="#1" data-quad="\the\fontdimen6\font">}#2\special{dvisvgm:raw </g>}}`;

const PROXY = String.raw`\hbox to1em{M\hss}`;

/** Replace non-native literal runs outside TeX comments and macro names with proxy boxes. */
export function bridgeUnicode(source: string): UnicodeBridge {
	const runs: string[] = [];
	let encoded = '';
	let i = 0;

	while (i < source.length) {
		const ch = source[i] ?? '';
		if (ch === '%' && !isEscaped(source, i)) {
			const end = source.indexOf('\n', i);
			if (end === -1) {
				encoded += source.slice(i);
				break;
			}
			encoded += source.slice(i, end + 1);
			i = end + 1;
			continue;
		}

		const cp = source.codePointAt(i) ?? 0;
		if (cp <= 0x7f || isNativeUnicode(cp)) {
			const length = cp > 0xffff ? 2 : 1;
			encoded += source.slice(i, i + length);
			i += length;
			continue;
		}

		const start = i;
		let count = 0;
		while (i < source.length) {
			const next = source.codePointAt(i) ?? 0;
			if (next <= 0x7f || isNativeUnicode(next)) break;
			i += next > 0xffff ? 2 : 1;
			count++;
		}
		if (isEscaped(source, start)) {
			encoded += source.slice(start, i);
			continue;
		}
		const id = runs.length;
		runs.push(source.slice(start, i));
		encoded += `${CALL}{${id}}{${PROXY.repeat(count)}}`;
	}

	return { source: encoded, preamble: runs.length > 0 ? PREAMBLE : '', runs };
}

/** Restore bridge markers in raw dvi2html output while retaining TikZ's position, size and fill. */
export function restoreUnicode(svg: string, runs: readonly string[]): string {
	if (runs.length === 0) return svg;
	if ((svg.match(/<g\b/g) ?? []).length !== (svg.match(/<\/g\s*>/g) ?? []).length) {
		throw new Error('Unicode bridge markers are unbalanced in the converted SVG.');
	}

	return svg.replace(
		/<g data-tikzjax-unicode="([0-9]+)" data-quad="([0-9]+(?:\.[0-9]+)?)pt">([\s\S]*?)<\/g>/g,
		(_whole: string, rawId: string, rawQuad: string, body: string) => {
			const text = runs[Number(rawId)];
			const opening = /<text\b[^>]*>/.exec(body)?.[0];
			const x = opening === undefined ? undefined : /\sx="([^"]+)"/.exec(opening)?.[1];
			if (
				text === undefined ||
				opening === undefined ||
				x === undefined ||
				!Number.isFinite(Number(x))
			) {
				throw new Error('Unicode bridge marker has no recoverable text position.');
			}
			const middle = Number(x) + (Number(rawQuad) * [...text].length) / 2;
			const centred = opening
				.replace(/\sx="[^"]*"/, ` x="${middle}"`)
				.replace(/>$/, ' text-anchor="middle">');

			// The Computer Modern webfont contains no CJK glyphs. Asking for the platform sans family
			// explicitly gives every supported OS a predictable font-fallback path.
			const family = /\sfont-family="[^"]*"/.test(centred)
				? centred.replace(/\sfont-family="[^"]*"/, ' font-family="sans-serif"')
				: centred.replace(/>$/, ' font-family="sans-serif">');
			return `<g data-tikzjax-unicode="${rawId}" data-quad="${rawQuad}pt">${family}${escapeXml(text)}</text></g>`;
		},
	);
}

function isEscaped(source: string, at: number): boolean {
	let slashes = 0;
	for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
	return slashes % 2 === 1;
}

function escapeXml(text: string): string {
	// Iterate Unicode scalars: valid surrogate pairs survive; lone halves and XML 1.0's forbidden
	// characters become U+FFFD even in DOM implementations that accept malformed XML.
	return text
		.replace(/[\s\S]/gu, (ch) => {
			const cp = ch.codePointAt(0) ?? 0;
			return cp === 0x09 ||
				cp === 0x0a ||
				cp === 0x0d ||
				(cp >= 0x20 && cp <= 0xd7ff) ||
				(cp >= 0xe000 && cp <= 0xfffd) ||
				cp >= 0x10000
				? ch
				: '\uFFFD';
		})
		.split('&')
		.join('&amp;')
		.split('<')
		.join('&lt;')
		.split('>')
		.join('&gt;');
}
