import { describe, expect, it } from 'vitest';
import { buildInput, MISSING_PACKAGE } from '../engine-src/document';
import { isTs1Symbol, needsTs1Shim, TS1_SHIM, TS1_SYMBOLS } from '../engine-src/ts1-shim';

/*
 * LaTeX sets °, ×, µ, the arrows, £, €, © and a few more from TS1, whose font (tcrm1000) the SVG
 * converter cannot draw, so a single ° lost the whole diagram — as did siunitx's \micro and \ohm,
 * every bulleted list and a \$ in a label. The worker redefines those text commands to glyphs in the
 * math fonts, or to LaTeX's own constructions out of Computer Modern, only for an input that can use
 * one. Which glyphs render is measured through the engine by smoke and verify:worker (the
 * ts1-symbols, ts1-currency, ts1-small-caps and siunitx fixtures); these hold the shim's shape and
 * its trigger.
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

	it('covers the currency, the legal marks and the ordinals, typed and as commands', () => {
		const commands = TS1_SYMBOLS.map((symbol) => symbol.command);
		for (const ch of ['£', '€', '©', '®', 'ª', 'º'])
			expect(isTs1Symbol(ch.codePointAt(0) ?? 0)).toBe(true);
		for (const command of [
			'textsterling',
			'texteuro',
			'textcopyright',
			'textregistered',
			'textordfeminine',
			'textordmasculine',
			'textdollar',
		])
			expect(commands).toContain(command);
	});

	it('keeps the ordinals lowercase in small caps, where LaTeX sets the TS1 ones from the upright font', () => {
		// TS1 has no small-capital shape: in \textsc LaTeX substitutes the upright tcrm1000, so ª is
		// a raised lowercase a there. Set in the current shape, the shim's a came out a small capital.
		for (const command of ['textordfeminine', 'textordmasculine']) {
			const symbol = TS1_SYMBOLS.find((s) => s.command === command);
			expect(symbol?.drawnAs).toContain('\\ulcshape');
		}
	});

	it('draws each command from fonts the converter has, in the preamble line it injects', () => {
		for (const { command, drawnAs } of TS1_SYMBOLS) {
			expect(TS1_SHIM).toContain(`\\DeclareRobustCommand\\${command}{${drawnAs}}`);
		}
		// Redefined at \begin{document}, after every package has defined its own version.
		expect(TS1_SHIM.startsWith('\\AtBeginDocument{')).toBe(true);
		expect(TS1_SHIM).not.toContain('\n');
	});

	it('leaves alone what the engine already draws natively', () => {
		// Greek and the yen have no stand-in here; é, ä and, since the converter was fixed, Ł are native.
		for (const ch of ['Ω', 'α', '¥', 'é', 'ä', '–', 'Ł', 'ł'])
			expect(isTs1Symbol(ch.codePointAt(0) ?? 0)).toBe(false);
	});

	it.each([
		['a typed symbol', picture('90° and 3×4')],
		['a command', picture('45\\textdegree')],
		['\\S', picture('see \\S 3')],
		['a typed currency sign', picture('£5 and 3€')],
		['\\pounds', picture('\\pounds 5')],
		['\\copyright', picture('\\copyright{} 2026')],
		['\\$, which is \\textdollar in text', picture('costs \\$5')],
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
		['native accented letters', picture('Grüße, café, Łódź')],
		['a name that only starts like \\pounds', picture('\\poundsign')],
	])('is not injected for %s', (_, source) => {
		expect(needsTs1Shim(source)).toBe(false);
		expect(buildInput(source, {}).text).not.toContain(TS1_SHIM);
	});

	it('is injected for siunitx loaded as a package option, and costs no line', () => {
		const source = picture('\\SI{3.5}{\\kilo\\ohm}');
		const plain = buildInput(source, {});
		const shimmed = buildInput(source, { texPackages: { siunitx: '' } });
		expect(plain.text).not.toContain(TS1_SHIM);
		expect(shimmed.text).toContain(`\\nonstopmode${MISSING_PACKAGE}${TS1_SHIM}\\usepackage{siunitx}`);
		expect(shimmed.bodyLine).toBe(plain.bodyLine);
	});

	it('comes before a preamble file, so a definition of the user’s own still wins', () => {
		const addToPreamble = '\\AtBeginDocument{\\renewcommand\\textdegree{deg}}';
		const { text } = buildInput(picture('90°'), { addToPreamble });
		expect(text.indexOf(TS1_SHIM)).toBeLessThan(text.indexOf(addToPreamble));
	});
});
