/**
 * Text symbols the engine draws by borrowing a glyph from the math fonts.
 *
 * LaTeX sets °, ×, ±, µ, the arrows, the bullet of a list and a dozen more from TS1, the
 * text-companion encoding, in tcrm1000. TeX has that font's metrics, but the SVG converter's table
 * covers Computer Modern and the AMS fonts only, and no WOFF2 face for it ships. So one ° lost the
 * whole diagram with "Could not find font tcrm1000", and so did a siunitx \micro or \ohm, \S, a
 * dagger, and every bulleted list.
 *
 * Each of them has a glyph in the Computer Modern math fonts: ° is a raised \circ, × is \times, µ
 * is \mu, • is \bullet. The shim redefines the TS1 text commands to those. LaTeX's UTF-8 input
 * turns a typed ° into \textdegree, so the typed character and the command both come out of fonts
 * that ship. The compromise is typographic: µ is the italic math mu rather than an upright micro
 * sign, and ° is a math circle. Proper TS1 support needs tcrm metrics in the converter and a
 * cm-super face, and is a larger job. Every entry was rendered through the committed engine, typed
 * and as a command, in text and in math. The ts1-symbols and siunitx fixtures keep it that way.
 *
 * It imports nothing. The pre-flight lint reads the same table on the main thread, so that it does
 * not warn about a character the worker will draw.
 */

/** One TS1 text command, the character LaTeX's UTF-8 input maps to it, and what it becomes. */
export interface Ts1Symbol {
	/** Absent for a command no character maps to. */
	codepoint?: number;
	command: string;
	drawnAs: string;
}

export const TS1_SYMBOLS: readonly Ts1Symbol[] = [
	{ codepoint: 0x00a7, command: 'textsection', drawnAs: '\\ensuremath{\\mathsection}' }, // §
	{ codepoint: 0x00ac, command: 'textlnot', drawnAs: '\\ensuremath{\\neg}' }, // ¬
	{ codepoint: 0x00b0, command: 'textdegree', drawnAs: '\\ensuremath{{}^{\\circ}}' }, // °
	{ codepoint: 0x00b1, command: 'textpm', drawnAs: '\\ensuremath{\\pm}' }, // ±
	{ codepoint: 0x00b2, command: 'texttwosuperior', drawnAs: '\\textsuperscript{2}' }, // ²
	{ codepoint: 0x00b3, command: 'textthreesuperior', drawnAs: '\\textsuperscript{3}' }, // ³
	{ codepoint: 0x00b5, command: 'textmu', drawnAs: '\\ensuremath{\\mu}' }, // µ
	{ codepoint: 0x00b6, command: 'textparagraph', drawnAs: '\\ensuremath{\\mathparagraph}' }, // ¶
	{ codepoint: 0x00b7, command: 'textperiodcentered', drawnAs: '\\ensuremath{\\cdot}' }, // ·
	{ codepoint: 0x00b9, command: 'textonesuperior', drawnAs: '\\textsuperscript{1}' }, // ¹
	{ codepoint: 0x00d7, command: 'texttimes', drawnAs: '\\ensuremath{\\times}' }, // ×
	{ codepoint: 0x00f7, command: 'textdiv', drawnAs: '\\ensuremath{\\div}' }, // ÷
	{ codepoint: 0x2020, command: 'textdagger', drawnAs: '\\ensuremath{\\dagger}' }, // †
	{ codepoint: 0x2021, command: 'textdaggerdbl', drawnAs: '\\ensuremath{\\ddagger}' }, // ‡
	{ codepoint: 0x2022, command: 'textbullet', drawnAs: '\\ensuremath{\\bullet}' }, // •
	{ codepoint: 0x2103, command: 'textcelsius', drawnAs: '\\ensuremath{{}^{\\circ}}C' }, // ℃
	{ codepoint: 0x2122, command: 'texttrademark', drawnAs: '\\textsuperscript{TM}' }, // ™
	{ codepoint: 0x2126, command: 'textohm', drawnAs: '\\ensuremath{\\Omega}' }, // Ω, the ohm sign
	{ codepoint: 0x2190, command: 'textleftarrow', drawnAs: '\\ensuremath{\\leftarrow}' }, // ←
	{ codepoint: 0x2191, command: 'textuparrow', drawnAs: '\\ensuremath{\\uparrow}' }, // ↑
	{ codepoint: 0x2192, command: 'textrightarrow', drawnAs: '\\ensuremath{\\rightarrow}' }, // →
	{ codepoint: 0x2193, command: 'textdownarrow', drawnAs: '\\ensuremath{\\downarrow}' }, // ↓
	// The third level of an itemize list.
	{ command: 'textasteriskcentered', drawnAs: '\\ensuremath{\\ast}' },
];

/**
 * The preamble line that installs the shim.
 *
 * Inside \AtBeginDocument so it runs after every package has made its own definitions: siunitx,
 * for one, defines \micro and \ohm in terms of \textmu and \textohm at \begin{document}, and they
 * pick these up when they are used. \DeclareRobustCommand replaces each command outright, encoding
 * dispatch and all, which is what keeps it out of TS1. One line, so it moves no `l.NN`.
 */
export const TS1_SHIM = `\\AtBeginDocument{${TS1_SYMBOLS.map(
	({ command, drawnAs }) => `\\DeclareRobustCommand\\${command}{${drawnAs}}`,
).join('')}}`;

const CODEPOINTS = new Set(
	TS1_SYMBOLS.flatMap((symbol) => (symbol.codepoint === undefined ? [] : [symbol.codepoint])),
);

/**
 * What in a TeX input can reach one of the commands: the characters and the commands themselves,
 * the LaTeX commands built on them (\S, \P, \dag, \ddag), and the packages and environments that
 * use them without naming them: siunitx's units, and itemize, whose labels are \textbullet and
 * \textasteriskcentered.
 */
const TRIGGER = new RegExp(
	`[${[...CODEPOINTS].map((cp) => String.fromCharCode(cp)).join('')}]` +
		`|\\\\(?:${[...TS1_SYMBOLS.map((symbol) => symbol.command), 'S', 'P', 'dag', 'ddag'].join('|')})(?![A-Za-z])` +
		'|\\b(?:siunitx|itemize)\\b',
);

/**
 * Whether a TeX input can use a TS1 symbol, and so needs the shim.
 *
 * The worker injects it only then. A diagram that cannot use one is given exactly the input it
 * always was, with the same transcript and the same output.
 */
export const needsTs1Shim = (input: string): boolean => TRIGGER.test(input);

/** Whether the worker draws this codepoint through the shim. */
export const isTs1Symbol = (codepoint: number): boolean => CODEPOINTS.has(codepoint);
