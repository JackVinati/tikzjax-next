/**
 * The TeX input the worker writes for a block: the assembled preamble, then the block itself.
 *
 * A module of its own, out of worker.ts, so that what TeX is given can be tested without booting an
 * engine — worker.ts is an entry point that inflates a 156 MiB dump the moment it is imported.
 */
import type { RenderOptions } from './protocol';
import { needsTs1Shim, TS1_SHIM } from './ts1-shim';

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
}

export const buildInput = (source: string, options: RenderOptions): TexInput => {
	const packages = Object.entries(options.texPackages ?? {})
		.map(([name, opts]) => `\\usepackage${opts ? `[${opts}]` : ''}{${name}}`)
		.join('');

	const libraries = options.tikzLibraries ? `\\usetikzlibrary{${options.tikzLibraries}}` : '';
	const given = `${packages}${libraries}${options.addToPreamble ?? ''}`;

	// Only for an input that can use one of its symbols (./ts1-shim), and ahead of everything the
	// user gave, so that a preamble file redefining one of the same commands still has the last word.
	const shim = needsTs1Shim(`${given}\n${source}`) ? TS1_SHIM : '';

	// \nonstopmode is why a bad diagram produces a transcript and, usually, a drawing. Without it
	// TeX stops at the interactive `? ` prompt on the first error: upstream's engine then suspended
	// its asyncify'd wasm for good, and this one, which reads the end of its terminal input there,
	// stops the run with "Emergency stop" and draws nothing. Upstream #18 #23 #27 #39 #51 #82 #85
	// #89, roughly 22 reporters, are all downstream of this one token.
	const preamble = `\\nonstopmode${shim}${given}`;

	const wrap = options.wrap ?? 'auto';
	const needsWrap = wrap === 'always' || (wrap === 'auto' && !DOCUMENT_START.test(source));

	const head = needsWrap ? `${preamble}\\begin{document}\n` : `${preamble}\n`;
	const tail = needsWrap ? '\n\\end{document}\n' : '\n';
	return { text: `${head}${source}${tail}`, bodyLine: head.split('\n').length };
};
