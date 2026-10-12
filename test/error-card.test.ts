// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { renderErrorCard, type ErrorCardOptions } from '../src/block/error-card';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

const SOURCE = [
	'\\begin{tikzpicture}',
	'\\draw (0,0) -- (1,1);',
	'\\node {\\undefinedthing};',
	'\\end{tikzpicture}',
].join('\n');

/** A three-line preamble from two files, as resolve.ts expands it. */
const PREAMBLE = {
	text: [
		'\\usetikzlibrary{arrows.meta}',
		'\\newcommand{\\vect}{\\mathbf}',
		'\\tikzset{box/.style={draw}}',
	].join('\n'),
	lines: [
		{ path: 'latex/diagrams.tex', line: 1 },
		{ path: 'latex/diagrams.tex', line: 2 },
		{ path: 'notes/tikz-preamble.tex', line: 4 },
	],
};

function card(line: number | undefined, over: Partial<ErrorCardOptions> = {}): HTMLElement {
	const container = document.body.createDiv();
	renderErrorCard(container, {
		diagnostic: { kind: 'tex-error', message: 'Undefined control sequence', line },
		source: SOURCE,
		log: [],
		...over,
	});
	return container;
}

const excerpt = (el: HTMLElement): string | null =>
	el.querySelector('.tikzjax-error-source span')?.textContent ?? null;
const where = (el: HTMLElement): string | null =>
	el.querySelector('.tikzjax-error-where')?.textContent ?? null;

describe('the line an error card points at', () => {
	/**
	 * Lines arrive numbered as the block's own, from 1, as pre-flight numbers them (the host turns
	 * TeX's l.NN into that). The card used to subtract 2 itself, so a pre-flight error showed the
	 * line above the one at fault, and a TeX error behind a preamble of several lines showed a line
	 * further down.
	 */
	it('is the block line it is given', () => {
		const el = card(3, { preamble: PREAMBLE });

		expect(excerpt(el)).toBe('3 | \\node {\\undefinedthing};\n');
		expect(where(el)).toBeNull();
	});

	it('is the first line, for line 1', () => {
		expect(excerpt(card(1))).toBe('1 | \\begin{tikzpicture}\n');
	});

	it('is the last line, for a line past the end: the \\end{document} the block was wrapped in', () => {
		expect(excerpt(card(5))).toBe('4 | \\end{tikzpicture}\n');
	});

	it('is in the preamble file TeX was reading, at that file’s own line, for a line above the block', () => {
		// 0 is the line just above the block, the preamble's last; -1 the one above that.
		const last = card(0, { preamble: PREAMBLE });
		expect(where(last)).toBe('In the preamble: notes/tikz-preamble.tex, line 4');
		expect(excerpt(last)).toBe('4 | \\tikzset{box/.style={draw}}\n');

		const second = card(-1, { preamble: PREAMBLE });
		expect(where(second)).toBe('In the preamble: latex/diagrams.tex, line 2');
		expect(excerpt(second)).toBe('2 | \\newcommand{\\vect}{\\mathbf}\n');
	});

	/**
	 * Most saved files end in a newline, and so does the expanded preamble then: its last line is
	 * empty, and the worker's `\begin{document}` is on a line of its own, just above the block. An
	 * error TeX reports there — an `\AtBeginDocument` hook, a package's or the TS1 shim's — was put
	 * on a line of the preamble file that does not exist, with nothing to show for it.
	 */
	it('names \\begin{document}, not a line past the end of the file, behind a preamble that ends in a newline', () => {
		const preamble = {
			text: '\\usepackage{amsmath}\n',
			lines: [
				{ path: 'tikz-preamble.tex', line: 1 },
				{ path: 'tikz-preamble.tex', line: 2 },
			],
		};

		const begin = card(0, { preamble });
		expect(where(begin)).toBe(
			'TeX stopped before reaching the diagram, at \\begin{document}: in something a package or the preamble runs as the document starts.',
		);
		expect(excerpt(begin)).toBeNull();

		const above = card(-1, { preamble });
		expect(where(above)).toBe('In the preamble: tikz-preamble.tex, line 1');
		expect(excerpt(above)).toBe('1 | \\usepackage{amsmath}\n');
	});

	it('names no block line for an error before the block when there is no preamble', () => {
		// The one line the plugin writes itself: \nonstopmode, the block's packages and libraries,
		// \begin{document}. A bad `%!tikz packages=` option fails there.
		const el = card(0);

		expect(where(el)).toBe(
			'TeX stopped before reaching the diagram, on the line that loads its packages and libraries.',
		);
		expect(excerpt(el)).toBeNull();
	});

	it('shows the line without a file when nothing says where a preamble line came from', () => {
		const el = card(0, { preamble: { text: '\\usepackage{amsmath}', lines: [] } });

		expect(where(el)).toBe('In the preamble, line 1');
		expect(excerpt(el)).toBe('1 | \\usepackage{amsmath}\n');
	});

	it('shows nothing about a line when TeX named none', () => {
		const el = card(undefined, { preamble: PREAMBLE });

		expect(where(el)).toBeNull();
		expect(excerpt(el)).toBeNull();
	});
});
