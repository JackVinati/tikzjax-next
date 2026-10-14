import { describe, expect, it } from 'vitest';
import { buildInput, MISSING_PACKAGE, predictedPoint, routeKey, routeOf } from '../engine-src/document';
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
			`\\nonstopmode${MISSING_PACKAGE}\\begin{document}\n${SOURCE}\n\\end{document}\n`,
		);
		const own = `\\begin{document}\n${SOURCE}\n\\end{document}`;
		expect(buildInput(own, {}).text).toBe(`\\nonstopmode${MISSING_PACKAGE}\n${own}\n`);
	});

	it('has LaTeX go on without a package it cannot find, before any package is loaded', () => {
		// LaTeX asks for another name, which TeX in nonstop mode cannot read, and stops. The worker
		// answers for it as Return does, on the first line, so that the block does not move.
		const preamble = '\\usepackage{amsthm}\n\\newcommand{\\R}{\\mathbb{R}}';
		const options = { texPackages: { nosuchpackage: '' }, addToPreamble: preamble };
		const first = buildInput(SOURCE, options).text.split('\n')[0] ?? '';
		const answer = first.indexOf('\\def\\@missing@onefilewithoptions');
		expect(answer).toBeGreaterThan(first.indexOf('\\nonstopmode'));
		expect(answer).toBeLessThan(first.indexOf('\\usepackage{nosuchpackage}'));
		expect(answer).toBeLessThan(first.indexOf('\\usepackage{amsthm}'));
		expect(expectBodyAt(SOURCE, options)).toBe(3);
		expect(MISSING_PACKAGE).not.toContain('\n');
	});

	it('declares what the Unicode bridge draws, from the block and its preambles, ahead of them', () => {
		const addToPreamble = '\\newcommand\\city{北京}';
		const input = buildInput('\\node {开始 \\city};', { addToPreamble });
		expect(input.unicode).toEqual([0x4eac, 0x5317, 0x59cb, 0x5f00]);
		const first = input.text.split('\n')[0] ?? '';
		expect(first.indexOf('\\DeclareUnicodeCharacter{5317}')).toBeGreaterThan(
			first.indexOf(MISSING_PACKAGE),
		);
		expect(first.indexOf('\\DeclareUnicodeCharacter')).toBeLessThan(first.indexOf(addToPreamble));
		expect(input.bodyLine).toBe(buildInput('\\node {a};', { addToPreamble }).bodyLine);
		expect(buildInput(SOURCE, {}).unicode).toEqual([]);
	});

	it('keeps the preamble just above the block when the declarations take more than a line', () => {
		const many = Array.from({ length: 150 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
		const source = `\\begin{tikzpicture}\n\\node {${many}};\n\\end{tikzpicture}`;
		expect(expectBodyAt(source, { addToPreamble: 'a\nb' })).toBe(4);
		const { text, bodyLine } = buildInput(source, { addToPreamble: 'a\nb' });
		expect(text.split('\n')[bodyLine - 3]).toMatch(/}}a$/);
	});
});

/*
 * The worker saves a first pass at the end of its \begin{document} and names the run by where that
 * is likely to be in its input; the host names each diagram the same way and sends it to the engine
 * that holds its name (engine-src/snapshot.ts, src/engine/route.ts, internal/DECISIONS.md D32).
 */
describe('where a run is likely to be saved, and its name', () => {
	it("is the end of the worker's own \\begin{document} line for a block it wraps", () => {
		for (const options of [
			{},
			{ texPackages: { pgfplots: '' }, addToPreamble: 'a\nb\n' },
		] as RenderOptions[]) {
			const { text } = buildInput(SOURCE, options);
			const at = predictedPoint(text)!;
			expect(text.slice(0, at).endsWith('\\begin{document}\n')).toBe(true);
			expect(text.slice(at).startsWith(SOURCE)).toBe(true);
		}
	});

	it('is the end of the line of the first \\begin{document} not in a comment, with what follows on it', () => {
		const own = `% \\begin{document} in a comment\n\\newcommand\\x{X}\n\\begin{document} \\x\n${SOURCE}\n\\end{document}`;
		const { text } = buildInput(own, {});
		const at = predictedPoint(text)!;
		expect(text.slice(0, at).endsWith('\\begin{document} \\x\n')).toBe(true);
		expect(predictedPoint('\\begin{document}')).toBeUndefined();
		expect(predictedPoint('\\begin{tikzpicture}\\end{tikzpicture}\n')).toBeUndefined();
	});

	it('takes an escaped % before \\begin{document} on its line for what it is, and \\\\% for a comment', () => {
		const escaped = '\\newcommand\\pc{50\\%}\\begin{document}\nbody\n';
		expect(predictedPoint(escaped)).toBe(escaped.indexOf('body'));
		const comment = '\\def\\x{}\\\\% \\begin{document}\n\\begin{document}\nbody\n';
		expect(predictedPoint(comment)).toBe(comment.indexOf('body'));
	});

	it('is named the same for the same text and logging, and apart otherwise', () => {
		const a = buildInput(SOURCE, { texPackages: { pgfplots: '' } }).text;
		const b = buildInput('\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}', {
			texPackages: { pgfplots: '' },
		}).text;
		const c = buildInput(SOURCE, { texPackages: { circuitikz: '' } }).text;
		expect(routeOf(a, true)).toBe(routeOf(b, true));
		expect(routeOf(a, true)).not.toBe(routeOf(c, true));
		expect(routeOf(a, true)).not.toBe(routeOf(a, false));
		expect(routeOf(a, true)).toBe(routeKey(a.slice(0, predictedPoint(a)), true));
		expect(routeKey('x', true)).toMatch(/^[0-9a-f]{1,14}$/);
		// 10,000 preambles a character apart, and no two names alike.
		const names = new Set(Array.from({ length: 10_000 }, (_, i) => routeKey(`\\def\\a{${i}}\n`, true)));
		expect(names.size).toBe(10_000);
	});
});
