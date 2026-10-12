import { describe, expect, it } from 'vitest';
import { buildInput } from '../engine-src/document';
import type { RenderOptions } from '../engine-src/protocol';

/*
 * The TeX input the worker writes is the assembled preamble, then the block. TeX's `l.NN` counts
 * lines of that whole file, so the block's own line is `l.NN - bodyLine + 1`, and the plugin can
 * only say which line of the block TeX blamed if the worker says where the block starts. The card
 * used to assume line 2 always, and a preamble of several lines moved every blame down by as many.
 */

const SOURCE = '\\begin{tikzpicture}\n\\node {\\undefinedthing};\n\\end{tikzpicture}';

/** Every line of `source` must be at `bodyLine + i` of the input, in order. */
function expectBodyAt(source: string, options: RenderOptions): number {
	const { text, bodyLine } = buildInput(source, options);
	const lines = text.split('\n');
	source.split('\n').forEach((line, i) => {
		expect(lines[bodyLine - 1 + i]).toBe(line);
	});
	return bodyLine;
}

describe('buildInput', () => {
	it('puts the block on line 2 when the preamble is one line', () => {
		expect(expectBodyAt(SOURCE, {})).toBe(2);
		expect(expectBodyAt(SOURCE, { texPackages: { pgfplots: '' }, tikzLibraries: 'calc' })).toBe(2);
	});

	it('moves the block down by every line a preamble file adds', () => {
		// The case the card got wrong: three preamble lines, and TeX's l.5 shown as the block's line 3.
		const addToPreamble =
			'\\usepackage{amsmath}\n\\newcommand{\\R}{\\mathbb{R}}\n\\tikzset{every node/.style={}}';
		expect(expectBodyAt(SOURCE, { addToPreamble })).toBe(4);
		expect(expectBodyAt(SOURCE, { addToPreamble: `${addToPreamble}\n` })).toBe(5);
	});

	it('knows where the block starts whether or not it is wrapped in a document', () => {
		const own = `\\usepackage{amsmath}\n\\begin{document}\n${SOURCE}\n\\end{document}`;
		const addToPreamble = 'a\nb';
		expect(expectBodyAt(own, { addToPreamble })).toBe(3);
		expect(expectBodyAt(own, { addToPreamble, wrap: 'never' })).toBe(3);
		expect(expectBodyAt(SOURCE, { addToPreamble, wrap: 'always' })).toBe(3);
		expect(buildInput(own, {}).text).not.toContain('\\begin{document}\n\\usepackage');
	});

	it('wraps only a block that has no document of its own', () => {
		expect(buildInput(SOURCE, {}).text).toBe(
			`\\nonstopmode\\begin{document}\n${SOURCE}\n\\end{document}\n`,
		);
		const own = `\\begin{document}\n${SOURCE}\n\\end{document}`;
		expect(buildInput(own, {}).text).toBe(`\\nonstopmode\n${own}\n`);
	});
});
