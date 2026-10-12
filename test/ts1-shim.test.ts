import { describe, expect, it } from 'vitest';
import { buildInput } from '../engine-src/document';
import { isTs1Symbol, needsTs1Shim, TS1_SHIM, TS1_SYMBOLS } from '../engine-src/ts1-shim';

/*
 * LaTeX sets °, ×, µ, the arrows and a few more from TS1, whose font (tcrm1000) the SVG converter
 * cannot draw, so a single ° lost the whole diagram — as did siunitx's \micro and \ohm, and every
 * bulleted list. The worker redefines those text commands to glyphs in the math fonts, only for an
 * input that can use one. Which glyphs render is measured through the engine by smoke and
 * verify:worker (the ts1-symbols and siunitx fixtures); these hold the shim's shape and its trigger.
 */

const PICTURE = '\\begin{tikzpicture}\n\\node {%s};\n\\end{tikzpicture}';
const picture = (label: string) => PICTURE.split('%s').join(label);

describe('the TS1 shim', () => {
	it('covers what the review found failing, typed and as commands', () => {
		const commands = TS1_SYMBOLS.map((symbol) => symbol.command);
		for (const ch of ['°', '×', '→', '±', 'µ']) expect(isTs1Symbol(ch.codePointAt(0) ?? 0)).toBe(true);
		for (const command of ['textdegree', 'textmu', 'texttimes', 'textpm', 'textrightarrow', 'textohm'])
			expect(commands).toContain(command);
	});

	it('draws each command from a math font, in the preamble line it injects', () => {
		for (const { command, drawnAs } of TS1_SYMBOLS) {
			expect(TS1_SHIM).toContain(`\\DeclareRobustCommand\\${command}{${drawnAs}}`);
		}
		// Redefined at \begin{document}, after every package has defined its own version.
		expect(TS1_SHIM.startsWith('\\AtBeginDocument{')).toBe(true);
		expect(TS1_SHIM).not.toContain('\n');
	});

	it('leaves alone what the engine already draws natively', () => {
		// Greek, the euro and the rest have no math-font stand-in here; é and ä are native.
		for (const ch of ['Ω', 'α', '€', 'é', 'ä', '–'])
			expect(isTs1Symbol(ch.codePointAt(0) ?? 0)).toBe(false);
	});

	it.each([
		['a typed symbol', picture('90° and 3×4')],
		['a command', picture('45\\textdegree')],
		['\\S', picture('see \\S 3')],
		['a bulleted list, whose label is \\textbullet', picture('\\begin{itemize}\\item a\\end{itemize}')],
		[
			'siunitx in the source',
			`\\usepackage{siunitx}\n\\begin{document}\n${picture('\\si{\\micro\\metre}')}`,
		],
	])('is needed for %s', (_, source) => {
		expect(needsTs1Shim(source)).toBe(true);
	});

	it.each([
		['a plain picture', picture('basic')],
		['a name that only starts like a mapped command', picture('$\\Sigma \\textdegreesign \\Phi$')],
		['native accented letters', picture('Grüße, café')],
	])('is not injected for %s', (_, source) => {
		expect(needsTs1Shim(source)).toBe(false);
		expect(buildInput(source, {}).text).not.toContain(TS1_SHIM);
	});

	it('is injected for siunitx loaded as a package option, and costs no line', () => {
		const source = picture('\\SI{3.5}{\\kilo\\ohm}');
		const plain = buildInput(source, {});
		const shimmed = buildInput(source, { texPackages: { siunitx: '' } });
		expect(plain.text).not.toContain(TS1_SHIM);
		expect(shimmed.text).toContain(`\\nonstopmode${TS1_SHIM}\\usepackage{siunitx}`);
		expect(shimmed.bodyLine).toBe(plain.bodyLine);
	});

	it('comes before a preamble file, so a definition of the user’s own still wins', () => {
		const addToPreamble = '\\AtBeginDocument{\\renewcommand\\textdegree{deg}}';
		const { text } = buildInput(picture('90°'), { addToPreamble });
		expect(text.indexOf(TS1_SHIM)).toBeLessThan(text.indexOf(addToPreamble));
	});
});
