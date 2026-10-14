/**
 * The TeX input the worker writes for a block: the assembled preamble, then the block itself.
 *
 * A module of its own, out of worker.ts, so that what TeX is given can be tested without booting an
 * engine — worker.ts is an entry point that inflates a 156 MiB dump the moment it is imported.
 */
import { commentStart } from './comment';
import type { RenderOptions } from './protocol';
import { needsTs1Shim, TS1_SHIM } from './ts1-shim';
import { bridgeUnicode } from './unicode';

const DOCUMENT_START = /\\begin\s*\{document\}/;

/** The input file's text, and the line of it on which the block's own first line sits. */
export interface TexInput {
	text: string;
	/**
	 * TeX's `l.NN` counts lines of the whole file, preamble included, so a block line is
	 * `l.NN - bodyLine + 1`, and an `l.NN` below `bodyLine` is in the preamble. Counted from what
	 * was actually written rather than assumed: a preamble file of three lines moves the block down
	 * by two, and the error card used to show the wrong line of the block by exactly that much.
	 */
	bodyLine: number;
	/** The characters ./unicode declared, which the worker puts back into the SVG TeX's output becomes. */
	unicode: readonly number[];
}

/**
 * What LaTeX does with a package or class it cannot find: report it, as an error, and go on without
 * it.
 *
 * LaTeX itself asks at the terminal for another name, and pressing Return there goes on without the
 * file (latex.ltx, `\@missing@onefilewithoptions` and `\@missingfileerror`). In nonstop mode TeX
 * cannot read an answer, so it ended the run with an emergency stop, and a diagram that loads a
 * package it never uses, `inputenc` or `amsthm` say, failed. 0.1.5 drew those diagrams: its
 * `\filesize` said every file existed, and LaTeX read a missing package as an empty file. This is
 * LaTeX's own code for the Return answer, with the question replaced by `\@latex@error`, so the
 * card still names the file and the run goes on as it does after any other error. A missing
 * `\input` is left alone: Return there hands LaTeX the name `.tex`, and it has no way on to give
 * (internal/DECISIONS.md D19).
 *
 * On the first line, with no line break, ahead of every package the block or a preamble loads,
 * because the plugin counts a preamble's lines from the block up (verify-worker.mjs checks it).
 */
export const MISSING_PACKAGE =
	'\\makeatletter\\def\\@missing@onefilewithoptions#1{' +
	"\\@latex@error{File `\\@currpath\\@currname.\\@currext' not found}" +
	'{This engine does not have the file, so LaTeX goes on without it, as when Return is pressed here.}' +
	'\\global\\let\\@currpath\\@empty\\global\\let\\@currname\\@empty\\gdef\\@currext{tex}}\\makeatother';

export const buildInput = (source: string, options: RenderOptions): TexInput => {
	const packages = Object.entries(options.texPackages ?? {})
		.map(([name, opts]) => `\\usepackage${opts ? `[${opts}]` : ''}{${name}}`)
		.join('');

	const libraries = options.tikzLibraries ? `\\usetikzlibrary{${options.tikzLibraries}}` : '';
	const given = `${packages}${libraries}${options.addToPreamble ?? ''}`;

	// Only for an input that can use one of its symbols (./ts1-shim), and ahead of everything the
	// user gave, so that a preamble file redefining one of the same commands still has the last word.
	const shim = needsTs1Shim(`${given}\n${source}`) ? TS1_SHIM : '';

	// Every character the engine cannot draw, from the block or a preamble, declared as a box the
	// worker writes the character back over (./unicode). Ahead of everything the user gave, so that
	// a preamble declaring one of the same characters itself still has the last word.
	const unicode = bridgeUnicode(`${given}\n${source}`);

	// \nonstopmode is why a bad diagram produces a transcript and, usually, a drawing. Without it
	// TeX stops at the interactive `? ` prompt on the first error: upstream's engine then suspended
	// its asyncify'd wasm for good, and this one, which reads the end of its terminal input there,
	// stops the run with "Emergency stop" and draws nothing. Upstream #18 #23 #27 #39 #51 #82 #85
	// #89, roughly 22 reporters, are all downstream of this one token.
	const preamble = `\\nonstopmode${MISSING_PACKAGE}${shim}${unicode.preamble}${given}`;

	const wrap = options.wrap ?? 'auto';
	const needsWrap = wrap === 'always' || (wrap === 'auto' && !DOCUMENT_START.test(source));

	const head = needsWrap ? `${preamble}\\begin{document}\n` : `${preamble}\n`;
	const tail = needsWrap ? '\n\\end{document}\n' : '\n';
	return {
		text: `${head}${source}${tail}`,
		bodyLine: head.split('\n').length,
		unicode: unicode.codepoints,
	};
};

/**
 * Where a run of `text` is likely to be saved: just past the line of its first `\begin{document}`
 * that is not in a comment (./comment), which is how far TeX has read when its \begin{document} is
 * done (engine-src/snapshot.ts). For a block the worker wraps, that is exactly where, the end of the
 * worker's own `\begin{document}` line. For a block with its own it is a guess, which a
 * `\begin{document}` inside a macro, a verbatim or a file the block writes can make wrong. The
 * worker saves a run whatever this guessed, or whether it guessed at all, under what TeX had really
 * read; this only names runs (routeOf), for the host, which sends a diagram to the engine that holds
 * the run of its name. A wrong guess, or none, costs a diagram the engine it could have resumed in,
 * never a save and never a wrong drawing.
 */
export const predictedPoint = (text: string): number | undefined => {
	const pattern = new RegExp(DOCUMENT_START.source, 'g');
	for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
		const lineStart = text.lastIndexOf('\n', m.index) + 1;
		if (commentStart(text.slice(lineStart, m.index)) >= 0) continue;
		const lineEnd = text.indexOf('\n', m.index + m[0].length);
		return lineEnd < 0 ? undefined : lineEnd + 1;
	}
	return undefined;
};

/**
 * A short name for a saved run: a 53-bit hash of the text it stands for and of whether the log was
 * kept, in hexadecimal (cyrb53). The host names each diagram by the text its run would stand for
 * (routeOf), the worker each run it holds as the host named the diagram that saved it, or by the
 * text it was saved under where routeOf has no name, and the host sends a diagram to the engine that
 * holds its name (src/engine/worker-host.ts). Two texts that
 * share a name are told apart where it matters, in the worker, which compares the text itself.
 */
export const routeKey = (prefix: string, logging: boolean): string => {
	let h1 = 0xdeadbeef ^ (logging ? 1 : 0);
	let h2 = 0x41c6ce57 ^ (logging ? 1 : 0);
	for (let i = 0; i < prefix.length; i++) {
		const c = prefix.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/** The name of the run a render of `text` would save or resume from, if it has one (routeKey). */
export const routeOf = (text: string, logging: boolean): string | undefined => {
	const at = predictedPoint(text);
	return at === undefined ? undefined : routeKey(text.slice(0, at), logging);
};
