/**
 * Text symbols the engine draws by borrowing a glyph from the math fonts, or by building them out of
 * the Computer Modern text fonts.
 *
 * LaTeX sets °, ×, ±, µ, the arrows, the bullet of a list, £, €, © and a dozen more from TS1, the
 * text-companion encoding, in tcrm1000. TeX has that font's metrics, but the SVG converter's table
 * covers Computer Modern and the AMS fonts only, and no WOFF2 face for it ships. So one ° lost the
 * whole diagram with "Could not find font tcrm1000", and so did a siunitx \micro or \ohm, \S, a
 * dagger, every bulleted list, and a \$ in a label.
 *
 * Most of them have a glyph in the Computer Modern math fonts: ° is a raised \circ, × is \times, µ
 * is \mu, • is \bullet. The shim redefines the TS1 text commands to those. The currency signs, ©,
 * ® and the ordinals have none, and are built from text fonts the converter has, mostly as older
 * LaTeX releases built them before setting them in TS1: £ is character 36 of an italic font, which
 * is a pound sign there, and $ the same character of the roman; © and ® are a letter in cmsy's
 * large circle; € is the stand-in LaTeX sets for a font with no euro of its own; ª and º are a
 * raised a and o, underlined as the TS1 glyphs are. LaTeX's UTF-8 input turns a typed ° into
 * \textdegree, so the typed character and the command both come out of fonts that ship. The
 * compromise is typographic: µ is the italic math mu rather than an upright micro sign, ° is a math
 * circle, € is a C with a small = across it, and in bold type £ and ® stay medium, as does the
 * circle of ©. Proper TS1 support needs tcrm metrics in the converter and a cm-super face, and is a
 * larger job. Every entry was rendered through the committed engine, typed and as a command, in
 * text and in math. The ts1-symbols, ts1-currency, ts1-small-caps and siunitx fixtures keep it
 * that way.
 *
 * It imports nothing. The Unicode bridge (./bridged) reads the same table, so that it leaves to the
 * shim what the shim draws.
 */

/** One TS1 text command, the character LaTeX's UTF-8 input maps to it, and what it becomes. */
export interface Ts1Symbol {
	/** Absent for a command no character maps to. */
	codepoint?: number;
	command: string;
	drawnAs: string;
}

/**
 * The large circle of cmsy, character 13, with `letter` centred in it: the OMS form of \textcircled,
 * which older LaTeX releases used for © and ®, called by name because \textcircled itself now goes
 * to TS1. No @ in it, since the shim runs where @ is not a letter.
 */
const circled = (letter: string): string =>
	`\\UseTextAccent{OMS}{\\csname OMS\\string\\textcircled\\endcsname}{${letter}}`;

/**
 * Character 36 of an OT1 Computer Modern font, in `shape` for upright type and `slanted` for type
 * that leans. It is $ in the roman, slanted, sans and typewriter fonts and £ in the text italics,
 * cmti and the upright italic cmu, so £ also pins the family. In an \hbox, so that a typed £ in
 * math is still set as text.
 */
const char36 = (family: string, shape: string, slanted: string): string =>
	`\\leavevmode\\hbox{\\fontencoding{OT1}${family}` +
	`\\ifdim\\fontdimen1\\font>0pt \\fontshape{${slanted}}\\else\\fontshape{${shape}}\\fi\\selectfont\\char36}`;

/**
 * A raised, underlined `letter`, as the TS1 ordinals are drawn. Lowercase in small caps too:
 * TS1 has no small-capital shape, so there LaTeX sets the ordinal from the upright font, and
 * \ulcshape takes the small capitals off and leaves every other shape as it is.
 */
const ordinal = (letter: string): string => `\\textsuperscript{\\underline{\\ulcshape ${letter}}}`;

export const TS1_SYMBOLS: readonly Ts1Symbol[] = [
	// The OT1 \textsterling of older LaTeX releases, which took the upright italic's £ in upright type.
	{ codepoint: 0x00a3, command: 'textsterling', drawnAs: char36('\\fontfamily{cmr}', 'ui', 'it') }, // £
	{ codepoint: 0x00a7, command: 'textsection', drawnAs: '\\ensuremath{\\mathsection}' }, // §
	{ codepoint: 0x00a9, command: 'textcopyright', drawnAs: circled('c') }, // ©
	{ codepoint: 0x00aa, command: 'textordfeminine', drawnAs: ordinal('a') }, // ª
	{ codepoint: 0x00ac, command: 'textlnot', drawnAs: '\\ensuremath{\\neg}' }, // ¬
	// A script-size R, as the default \textregistered of older LaTeX releases had it.
	{
		codepoint: 0x00ae,
		command: 'textregistered',
		drawnAs: circled('\\ensuremath{\\scriptstyle\\mathrm{R}}'),
	}, // ®
	{ codepoint: 0x00b0, command: 'textdegree', drawnAs: '\\ensuremath{{}^{\\circ}}' }, // °
	{ codepoint: 0x00b1, command: 'textpm', drawnAs: '\\ensuremath{\\pm}' }, // ±
	{ codepoint: 0x00b2, command: 'texttwosuperior', drawnAs: '\\textsuperscript{2}' }, // ²
	{ codepoint: 0x00b3, command: 'textthreesuperior', drawnAs: '\\textsuperscript{3}' }, // ³
	{ codepoint: 0x00b5, command: 'textmu', drawnAs: '\\ensuremath{\\mu}' }, // µ
	{ codepoint: 0x00b6, command: 'textparagraph', drawnAs: '\\ensuremath{\\mathparagraph}' }, // ¶
	{ codepoint: 0x00b7, command: 'textperiodcentered', drawnAs: '\\ensuremath{\\cdot}' }, // ·
	{ codepoint: 0x00b9, command: 'textonesuperior', drawnAs: '\\textsuperscript{1}' }, // ¹
	{ codepoint: 0x00ba, command: 'textordmasculine', drawnAs: ordinal('o') }, // º
	{ codepoint: 0x00d7, command: 'texttimes', drawnAs: '\\ensuremath{\\times}' }, // ×
	{ codepoint: 0x00f7, command: 'textdiv', drawnAs: '\\ensuremath{\\div}' }, // ÷
	{ codepoint: 0x2020, command: 'textdagger', drawnAs: '\\ensuremath{\\dagger}' }, // †
	{ codepoint: 0x2021, command: 'textdaggerdbl', drawnAs: '\\ensuremath{\\ddagger}' }, // ‡
	{ codepoint: 0x2022, command: 'textbullet', drawnAs: '\\ensuremath{\\bullet}' }, // •
	// LaTeX's \tc@fake@euro, which it sets for a font whose TS1 has no euro: a C with a small =
	// across it, both from the current font. The command is its argument only to name it in the log.
	{
		codepoint: 0x20ac,
		command: 'texteuro',
		drawnAs: '\\leavevmode\\hbox{\\csname tc@fake@euro\\endcsname\\texteuro}',
	}, // €
	{ codepoint: 0x2103, command: 'textcelsius', drawnAs: '\\ensuremath{{}^{\\circ}}C' }, // ℃
	{ codepoint: 0x2122, command: 'texttrademark', drawnAs: '\\textsuperscript{TM}' }, // ™
	{ codepoint: 0x2126, command: 'textohm', drawnAs: '\\ensuremath{\\Omega}' }, // Ω, the ohm sign
	{ codepoint: 0x2190, command: 'textleftarrow', drawnAs: '\\ensuremath{\\leftarrow}' }, // ←
	{ codepoint: 0x2191, command: 'textuparrow', drawnAs: '\\ensuremath{\\uparrow}' }, // ↑
	{ codepoint: 0x2192, command: 'textrightarrow', drawnAs: '\\ensuremath{\\rightarrow}' }, // →
	{ codepoint: 0x2193, command: 'textdownarrow', drawnAs: '\\ensuremath{\\downarrow}' }, // ↓
	// The third level of an itemize list.
	{ command: 'textasteriskcentered', drawnAs: '\\ensuremath{\\ast}' },
	// What \$ sets outside math. The OT1 \textdollar of older LaTeX releases: slanted in leaning type.
	{ command: 'textdollar', drawnAs: char36('', 'n', 'sl') },
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
 * the LaTeX commands built on them (\S, \P, \dag, \ddag, \pounds, \copyright, and \$, which is
 * \textdollar outside math), and the packages and environments that use them without naming them:
 * siunitx's units, and itemize, whose labels are \textbullet and \textasteriskcentered.
 */
const BUILT_ON = ['S', 'P', 'dag', 'ddag', 'pounds', 'copyright'];
const TRIGGER = new RegExp(
	`[${[...CODEPOINTS].map((cp) => String.fromCharCode(cp)).join('')}]` +
		`|\\\\(?:${[...TS1_SYMBOLS.map((symbol) => symbol.command), ...BUILT_ON].join('|')})(?![A-Za-z])` +
		'|\\\\\\$' +
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
