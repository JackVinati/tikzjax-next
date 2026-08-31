import type { BakedOptions, Diagnostic, EngineCapabilities } from '../types';

/**
 * Pre-flight source lint. See docs/DESIGN.md §7.6.
 *
 * Every rule here corresponds to a class of upstream bug report where the engine's own diagnostic
 * is absent, misleading, or arrives ten seconds late. Reading the source costs microseconds;
 * finding out from TeX costs a worker boot, a compile and — for #52 — a hang. The rules are chosen
 * on that basis, not on how easy they are to write: a lint that only restated what the TeX log
 * already says would be noise.
 *
 * Pure by construction: no DOM, no clock, no engine. Everything it knows about the engine arrives
 * in `caps`, which is generated from the built image (protocol.ts `EngineInventory`) rather than
 * hand-maintained, so the hints stay true across an engine bump instead of rotting into lies.
 *
 * Every Diagnostic is `kind: 'warning'`. Pre-flight NEVER blocks a render: the file list is an
 * inventory of what the virtual filesystem can serve, not a proof of what TeX will need — a
 * package can be satisfied from `addToPreamble`, and a heuristic that refused to compile would
 * turn a warning into exactly the blank diagram this plugin exists to eliminate.
 */
export function preflight(source: string, baked: BakedOptions, caps: EngineCapabilities): Diagnostic[] {
	const out: Diagnostic[] = [];

	// Every rule runs over the comment-masked text. `%!tikz` directives are comments and are
	// already parsed into `baked`; matching a `\usepackage` inside a commented-out experiment
	// would warn about code that never reaches TeX.
	const text = maskComments(source);

	checkDocumentClass(text, out);
	checkPackages(text, baked, caps, out);
	checkLibraries(text, baked, caps, out);
	checkPgfplotsLibraries(text, caps, out);
	checkPgfplotsCompat(text, caps, out);
	checkEncoding(text, caps, out);
	checkRedefinitions(text, out);

	// Sorted by position so the warning strip reads in source order regardless of rule order.
	// Array.prototype.sort is stable, so same-line diagnostics keep their rule order.
	return out.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
}

// -------------------------------------------------------------------------------------------
// Rule 3b — \usepgfplotslibrary{X}. Upstream #28 and #79.

const USEPGFPLOTSLIBRARY = /\\usepgfplotslibrary\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

/**
 * This one deserves its own rule rather than folding into Rule 3, because the failure is worse.
 *
 * pgfplots resolves the library like this (pgfplotslibrary.code.tex, read in the build image):
 *
 *     \pgfplots@iffileexists{tikzlibrarypgfplots.X.code.tex}
 *       {\input tikzlibrarypgfplots.X.code.tex}
 *       {\input pgflibrarypgfplots.X.code.tex}
 *
 * The fallback branch is a bare `\input` on a name that exists in NO TeX distribution — there is
 * no `pgflibrarypgfplots.fillbetween.code.tex` anywhere. So a missing library does not degrade:
 * TeX hits `! I can't find file`, reaches the file-name prompt, and the whole diagram dies. That
 * is upstream #28 and #79, and it is the failure this plugin's own smoke suite reproduced before
 * the file list was fixed.
 *
 * Rule 3's "either flavour is fine" reasoning does not transfer, for the same reason: here the
 * pgf-flavour name is the one that does not exist.
 */
function checkPgfplotsLibraries(text: string, caps: EngineCapabilities, out: Diagnostic[]): void {
	const seen = new Set<string>();

	for (const { name, line } of collectNames(text, USEPGFPLOTSLIBRARY, [])) {
		if (seen.has(name)) continue;
		seen.add(name);

		if (
			caps.files.has(`tikzlibrarypgfplots.${name}.code.tex`) ||
			caps.files.has(`pgflibrarypgfplots.${name}.code.tex`)
		) {
			continue;
		}

		out.push({
			kind: 'warning',
			message: `The pgfplots library ${name} is not bundled.`,
			...(line === undefined ? {} : { line }),
			hint:
				`Unlike \\usetikzlibrary, a missing \\usepgfplotslibrary is fatal: pgfplots falls back to ` +
				`\\input pgflibrarypgfplots.${name}.code.tex, a file that exists in no TeX distribution, so the ` +
				`whole diagram fails rather than the library being skipped. Remove the line, or open an issue ` +
				`asking for tikzlibrarypgfplots.${name}.code.tex to be added to the bundle.`,
		});
	}
}

// -------------------------------------------------------------------------------------------
// Rule 1 — a second \documentclass. Upstream #52.

function checkDocumentClass(text: string, out: Diagnostic[]): void {
	// The format dump was produced with `\documentclass[margin=0pt]{standalone}` already executed,
	// so a second one re-enters the class loader against a format that is past \begin{document}
	// and never returns — the user sees a spinner, not an error. Position is not part of the test:
	// wherever it appears, unless commented out, it hangs. #52 is the single most common user
	// error in the tracker.
	const m = /\\documentclass\b/.exec(text);
	if (!m) return;

	out.push({
		kind: 'warning',
		message: '\\documentclass is already loaded by the engine; a second one will hang this render.',
		line: lineOf(text, m.index),
		hint:
			'Delete the \\documentclass line. The engine starts from \\documentclass[margin=0pt]{standalone}, ' +
			'so a block begins at \\begin{document} — or straight at \\begin{tikzpicture}. ' +
			'Use the border= directive in place of standalone class options.',
	});
}

// -------------------------------------------------------------------------------------------
// Rule 2 — \usepackage{X} with no X.sty. Upstream #17, #34, #40, #56, #88, #92, #99.

const USEPACKAGE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

function checkPackages(
	text: string,
	baked: BakedOptions,
	caps: EngineCapabilities,
	out: Diagnostic[],
): void {
	const seen = new Set<string>();

	for (const { name, line } of collectNames(text, USEPACKAGE, Object.keys(baked.packages))) {
		if (seen.has(name)) continue;
		seen.add(name);

		// Two authorities, deliberately. `files` is what the VFS can serve; `packages` is the
		// generated version table. A name in the table whose .sty ships under a bundle filename
		// would otherwise produce a warning about something that demonstrably works.
		if (caps.files.has(`${name}.sty`) || recordedVersion(name, caps) !== undefined) continue;

		out.push({
			kind: 'warning',
			message: `${name}.sty is not bundled with this engine, so \\usepackage{${name}} will fail.`,
			...(line === undefined ? {} : { line }),
			hint: packageHint(name, caps),
		});
	}
}

function packageHint(name: string, caps: EngineCapabilities): string {
	// A very common shape of #40/#88: a TikZ library loaded as if it were a package. If the
	// library file is bundled we know exactly what the author meant, so say it rather than
	// reporting "not bundled" about something that is right there.
	if (caps.files.has(`tikzlibrary${name}.code.tex`) || caps.files.has(`pgflibrary${name}.code.tex`)) {
		return `${name} is a TikZ library, not a package — it is bundled, but it loads with \\usetikzlibrary{${name}}.`;
	}

	const base = 'Remove the line and inline the few macros you need, or switch to an engine that bundles it.';

	// D8 in docs/DECISIONS.md: this engine's web2js build applies expanded.ch and strcmp.ch, so
	// expl3 runs. The old "LaTeX3 packages are permanently impossible here" advice is stale and
	// must not be repeated in a hint — what stops the package is the file list, not the primitives.
	return caps.expl3
		? `${base} This engine does provide expl3, so an expl3-based package (siunitx v3, modern chemfig) works as soon as its files are bundled — being LaTeX3 is not what is stopping it.`
		: `${base} This engine has no expl3 either, so LaTeX3-based packages cannot run on it at all.`;
}

// -------------------------------------------------------------------------------------------
// Rule 3 — \usetikzlibrary{Y} with neither flavour of the library file.

const USETIKZLIBRARY = /\\usetikzlibrary\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

function checkLibraries(
	text: string,
	baked: BakedOptions,
	caps: EngineCapabilities,
	out: Diagnostic[],
): void {
	const seen = new Set<string>();

	for (const { name, line } of collectNames(text, USETIKZLIBRARY, splitList(baked.libraries))) {
		if (seen.has(name)) continue;
		seen.add(name);

		// \usetikzlibrary{Y} tries tikzlibraryY.code.tex and FALLS BACK to pgflibraryY.code.tex.
		// A missing tikz-flavour file is therefore normal — most pgf libraries ship only the pgf
		// flavour, and several ship only the tikz one — so warning on either alone would fire on
		// half of every real diagram. Only the absence of BOTH is a failure.
		if (caps.files.has(`tikzlibrary${name}.code.tex`) || caps.files.has(`pgflibrary${name}.code.tex`)) {
			continue;
		}

		out.push({
			kind: 'warning',
			message: `The TikZ library ${name} is not bundled (neither tikzlibrary${name}.code.tex nor pgflibrary${name}.code.tex).`,
			...(line === undefined ? {} : { line }),
			hint: libraryHint(name, caps),
		});
	}
}

function libraryHint(name: string, caps: EngineCapabilities): string {
	// `arrows.meta` against a bundle that has only `arrows` is the concrete case (see the engine
	// comparison in docs/DECISIONS.md D3), and the older library is a real substitute rather than
	// a guess.
	const dot = name.indexOf('.');
	if (dot > 0) {
		const base = name.slice(0, dot);
		if (caps.files.has(`tikzlibrary${base}.code.tex`) || caps.files.has(`pgflibrary${base}.code.tex`)) {
			return `\\usetikzlibrary{${base}} is bundled and is the older equivalent; its arrow and style names differ, so the picture will need small edits.`;
		}
	}
	return 'TikZ stops with "I did not find the tikz library file". Drop the entry, or switch to an engine that bundles it.';
}

// -------------------------------------------------------------------------------------------
// Rule 4 — \pgfplotsset{compat=N} above the bundled pgfplots. Upstream #110.

// Deliberately not anchored to \pgfplotsset: the same key arrives as a package option
// (\usepackage[compat=1.18]{pgfplots}) and inside nested braces that a {[^}]*} match cannot span.
// `compat=` has no other meaning in a TikZ source, so the looser match costs nothing.
const COMPAT = /\bcompat\s*=\s*([0-9]+(?:\.[0-9]+)*)/g;

function checkPgfplotsCompat(text: string, caps: EngineCapabilities, out: Diagnostic[]): void {
	const have = numericVersion(recordedVersion('pgfplots', caps));
	// No pgfplots, or a table that records something we cannot compare against (`unknown` is what
	// this build actually reports for it): stay quiet. Rule 2 has already said the more useful
	// thing when the package is missing entirely, and a comparison against a non-version would be
	// a warning made of nothing.
	if (have === undefined) return;

	for (const m of text.matchAll(COMPAT)) {
		const want = m[1];
		if (want === undefined || compareVersions(want, have) <= 0) continue;

		out.push({
			kind: 'warning',
			message: `compat=${want} is newer than the bundled pgfplots ${have}.`,
			line: lineOf(text, m.index ?? 0),
			hint:
				'pgfplots refuses a compat level it does not implement, and the failure surfaces far from this line. ' +
				`Use compat=${have}, or compat=newest — which always means "whatever this engine has".`,
		});
	}
}

/**
 * What the engine's generated table records for a package, or `undefined` when it records nothing
 * that counts as evidence the package is there.
 *
 * The generator's contract has since been fixed (scripts/engine-assets.mjs): keys are bare package
 * names, values are versions and nothing else, and a package it could not resolve is simply absent
 * from the table. The tolerance below — reading the `.sty` key too, and rejecting the old `absent`
 * sentinel — is kept deliberately: it costs one comparison, and it is what stops this rule from
 * going silently dead again if the generator ever regresses. It was dead for exactly that reason
 * once, and nothing failed to say so.
 *
 * `Object.hasOwn` rather than `!== undefined`: `packages` is a plain object, so `constructor`,
 * `toString` and friends would otherwise be answered by `Object.prototype`.
 */
function recordedVersion(name: string, caps: EngineCapabilities): string | undefined {
	for (const key of [name, `${name}.sty`]) {
		if (!Object.hasOwn(caps.packages, key)) continue;
		const recorded = caps.packages[key];
		if (recorded === undefined || recorded === 'absent') return undefined;
		return recorded;
	}
	return undefined;
}

/**
 * A comparable version out of whatever the table happens to hold.
 *
 * The recorded string is either a bare number, `unknown`/`absent`, or the raw `\ProvidesPackage`
 * argument — `2021/05/04 v1.16 Data Visualization`. The leading date must never be mistaken for
 * the version: read as `2021`, every compat level a user could write would look older, and the
 * rule would go permanently silent instead of firing.
 */
function numericVersion(recorded: string | undefined): string | undefined {
	if (recorded === undefined) return undefined;
	return /^\s*([0-9]+(?:\.[0-9]+)*)\s*$/.exec(recorded)?.[1] ?? /\bv([0-9]+(?:\.[0-9]+)+)/.exec(recorded)?.[1];
}

/** Numeric, component-wise. `1.9` < `1.16`, which a string compare gets backwards. */
function compareVersions(a: string, b: string): number {
	const as = a.split('.');
	const bs = b.split('.');
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const x = Number(as[i] ?? '0');
		const y = Number(bs[i] ?? '0');
		// A version we cannot parse is not evidence of anything; stay quiet rather than guess.
		if (Number.isNaN(x) || Number.isNaN(y)) return 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

// -------------------------------------------------------------------------------------------
// Rule 5 — codepoints outside Latin-1. Upstream #19, #36, #53.

/** Enough to identify the characters without turning the warning strip into a hex dump. */
const MAX_REPORTED_CHARS = 5;

function checkEncoding(text: string, caps: EngineCapabilities, out: Diagnostic[]): void {
	const offenders = new Map<string, number>();

	let i = 0;
	for (const ch of text) {
		// `for..of` iterates codepoints, so an astral character is one entry rather than two
		// surrogate halves — otherwise the report would name characters that do not exist.
		const cp = ch.codePointAt(0) ?? 0;
		if (cp > 0xff && !offenders.has(ch)) offenders.set(ch, i);
		i += ch.length;
	}
	if (offenders.size === 0) return;

	const listed = [...offenders.keys()].slice(0, MAX_REPORTED_CHARS).map((ch) => `'${ch}' (${codepoint(ch)})`);
	const rest = offenders.size - listed.length;
	const first = [...offenders.values()][0] ?? 0;

	out.push({
		kind: 'warning',
		message:
			`Characters outside Latin-1: ${listed.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}. ` +
			'This TeX engine is 8-bit.',
		line: lineOf(text, first),
		hint: encodingHint(caps),
	});
}

function encodingHint(caps: EngineCapabilities): string {
	// The source reaches TeX as UTF-8 bytes (engine-src/worker.ts writes input.tex through
	// TextEncoder), so a multi-byte character arrives as two or three separate 8-bit characters.
	// Plain TeX renders that as mojibake; a LaTeX with inputenc reassembles it — which is why the
	// second sentence is gated on the .sty actually being bundled rather than offered blind.
	const base =
		'Each of these reaches TeX as two or three separate 8-bit characters, so it prints as garbage or errors outright. ' +
		'Write them as TeX commands instead — $\\alpha$, \\"o, \\textdegree.';
	return caps.files.has('inputenc.sty')
		? `${base} Alternatively \\usepackage[utf8]{inputenc}, which is bundled, teaches LaTeX to reassemble them.`
		: base;
}

function codepoint(ch: string): string {
	return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

// -------------------------------------------------------------------------------------------
// Rule 6 — redefining a TeX or TikZ built-in. Upstream #96.

function named(reason: string, ...names: string[]): [string, string][] {
	return names.map((n) => [n, reason]);
}

/**
 * Names TeX or TikZ already owns, and what each one is.
 *
 * Curated, not exhaustive, and erring towards silence: `\x`, `\y` and the other one-letter macros
 * are the idiomatic \foreach variables, so including them would make the rule unusable. What is
 * here is the set an author reaches for when naming a coordinate or a parameter — \epsilon for a
 * small offset, \time for an animation step, \pi for a constant.
 */
const BUILTIN_MACROS: ReadonlyMap<string, string> = new Map<string, string>([
	// #96 is exactly this: \pgfmathsetmacro{\time}{...} \edef's over a TeX integer parameter, and
	// TeX then reads the assignment as a number where a control sequence belongs — silently, with
	// no `!` line and no `l.NN`, so no amount of log parsing can ever surface it. A lint is the
	// only mechanism that can catch this class at all.
	...named('a TeX integer parameter (the clock TeX starts with)', 'time', 'day', 'month', 'year'),
	...named(
		'a TeX primitive',
		'input', 'output', 'end', 'par', 'relax', 'the', 'box', 'hbox', 'vbox', 'count', 'dimen',
		'skip', 'char', 'span',
	),
	...named(
		'a plain-TeX math symbol',
		'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
		'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho',
		'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
		'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
	),
	...named(
		'a LaTeX math operator',
		'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'exp',
		'min', 'max', 'det', 'dim', 'deg', 'arg', 'gcd',
	),
	...named(
		'a TikZ command',
		'draw', 'fill', 'filldraw', 'shade', 'path', 'node', 'coordinate', 'clip', 'foreach',
		'tikz', 'pgfmathresult', 'pgfmathparse',
	),
]);

const DEFINITIONS: ReadonlyArray<{ re: RegExp; how: string }> = [
	{ re: /\\[gxe]?def\s*\\([a-zA-Z@]+)/g, how: '\\def' },
	{ re: /\\(?:re)?newcommand\s*\*?\s*\{?\s*\\([a-zA-Z@]+)/g, how: '\\newcommand' },
	{ re: /\\pgfmathsetmacro\s*\{?\s*\\([a-zA-Z@]+)/g, how: '\\pgfmathsetmacro' },
	{ re: /\\pgfmathsetlengthmacro\s*\{?\s*\\([a-zA-Z@]+)/g, how: '\\pgfmathsetlengthmacro' },
	{ re: /\\let\s*\\([a-zA-Z@]+)/g, how: '\\let' },
	// \providecommand is absent on purpose: it does not overwrite an existing definition, so it is
	// the safe way to write exactly the code the five forms above break on.
];

function checkRedefinitions(text: string, out: Diagnostic[]): void {
	const seen = new Set<string>();

	for (const { re, how } of DEFINITIONS) {
		for (const m of text.matchAll(re)) {
			const name = m[1];
			if (name === undefined || seen.has(name)) continue;
			const reason = BUILTIN_MACROS.get(name);
			if (reason === undefined) continue;
			seen.add(name);

			out.push({
				kind: 'warning',
				message: `${how}\\${name} redefines \\${name}, which is ${reason}.`,
				line: lineOf(text, m.index ?? 0),
				hint:
					'TeX usually reports nothing at all for this — the diagram renders with a piece missing, ' +
					`or a wrong number, and the log stays clean. Rename it: \\my${name}.`,
			});
		}
	}
}

// -------------------------------------------------------------------------------------------
// Shared helpers

/**
 * Blank out TeX comments, preserving length so every match index still maps to the right line.
 *
 * `\%` is a literal percent sign and must not start a comment; `\\%` does start one, because the
 * backslash is itself escaped. One pass with an escape flag gets both right, which a regex over
 * lines does not.
 */
function maskComments(source: string): string {
	const out = source.split('');
	let inComment = false;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === '\n' || ch === '\r') {
			inComment = false;
			continue;
		}
		if (inComment) {
			out[i] = ' ';
			continue;
		}
		if (ch === '\\') {
			i++; // the escaped character, whatever it is, is not syntax
			continue;
		}
		if (ch === '%') {
			inComment = true;
			out[i] = ' ';
		}
	}

	return out.join('');
}

/** 1-based, to match the `l.NN` numbers TeX reports and the editor's own gutter. */
function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === '\n') line++;
	}
	return line;
}

function splitList(list: string): string[] {
	return list
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * What a TeX file base name can be made of.
 *
 * `\{([^}]*)\}` cannot see a nested or an unbalanced brace, so one typo — `\usepackage{tikz` with
 * no closing brace — captures the rest of the diagram and used to be reported as a missing package
 * called `tikz\n\draw (0`. A name we cannot believe in is not evidence of anything, and a warning
 * assembled out of the user's own picture is the unreadable diagnostic this module exists to
 * replace, so an implausible name is dropped rather than reported.
 */
const PLAUSIBLE_NAME = /^[A-Za-z0-9@_.+-]+$/;

/**
 * Names from a `\usepackage{a,b}`-shaped command, followed by names that arrived through a
 * `%!tikz` directive instead.
 *
 * Directive-sourced names carry no line: the directive is a comment and has been masked out by
 * the time a rule runs, so any number we invented would point at unrelated TeX.
 */
function collectNames(
	text: string,
	re: RegExp,
	fromDirective: readonly string[],
): Array<{ name: string; line: number | undefined }> {
	const found: Array<{ name: string; line: number | undefined }> = [];

	for (const m of text.matchAll(re)) {
		const group = m[1];
		if (group === undefined) continue;
		const line = lineOf(text, m.index ?? 0);
		for (const name of splitList(group)) {
			if (PLAUSIBLE_NAME.test(name)) found.push({ name, line });
		}
	}

	// Directive names are NOT filtered: they come from one bounded `%!tikz packages=` line, so an
	// odd one is what the user actually asked to load and is worth saying out loud. Only the
	// brace-matched names can run away into the diagram.
	for (const name of fromDirective) found.push({ name, line: undefined });

	return found;
}
