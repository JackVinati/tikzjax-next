/*
 * Literal-Unicode bridge for the 8-bit TeX engine.
 *
 * TeX still owns layout: every Unicode codepoint is represented by a one-em box while the DVI is
 * built. dvi2html preserves the surrounding raw-SVG marker and supplies the current baseline
 * coordinates. Once conversion is complete we replace the proxy glyphs with the original text.
 * This keeps CJK text in ordinary TikZ nodes without pretending that the engine itself has become
 * Unicode-aware.
 */

export interface UnicodeBridge {
	source: string;
	preamble: string;
	runs: readonly string[];
}

const CALL = String.raw`\csname tikzjaxUnicodeBridge\endcsname`;

// Kept out of the source body so TeX's l.N diagnostics continue to refer to the user's line.
const PREAMBLE = String.raw`\expandafter\long\expandafter\def\csname tikzjaxUnicodeBridge\endcsname#1#2{\special{dvisvgm:raw <g data-tikzjax-unicode="#1">}#2\special{dvisvgm:raw </g>}}`;

const PROXY = String.raw`\hbox to1em{M\hss}`;

/** Replace literal non-Latin-1 runs outside TeX comments with measurable ASCII proxy boxes. */
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
		if (cp <= 0xff) {
			encoded += ch;
			i++;
			continue;
		}

		const start = i;
		let count = 0;
		while (i < source.length) {
			const next = source.codePointAt(i) ?? 0;
			if (next <= 0xff) break;
			i += next > 0xffff ? 2 : 1;
			count++;
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

	return svg.replace(
		/<g data-tikzjax-unicode="([0-9]+)">([\s\S]*?)<\/g>/g,
		(whole: string, rawId: string, body: string) => {
			const text = runs[Number(rawId)];
			if (text === undefined) return whole;
			const opening = /<text\b[^>]*>/.exec(body)?.[0];
			if (opening === undefined) return whole;

			// The Computer Modern webfont contains no CJK glyphs. Asking for the platform sans family
			// explicitly gives every supported OS a predictable font-fallback path.
			const family = /\sfont-family="[^"]*"/.test(opening)
				? opening.replace(/\sfont-family="[^"]*"/, ' font-family="sans-serif"')
				: opening.replace(/>$/, ' font-family="sans-serif">');
			return `<g data-tikzjax-unicode="${rawId}">${family}${escapeXml(text)}</text></g>`;
		},
	);
}

function isEscaped(source: string, at: number): boolean {
	let slashes = 0;
	for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
	return slashes % 2 === 1;
}

function escapeXml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
