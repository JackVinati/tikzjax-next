import type { Diagnostic, EngineCapabilities, TexErrorKind } from '../types';

/**
 * Turning a classified TeX failure into copy a human can act on.
 *
 * The engine (engine-src/worker.ts `readTranscript`/`diagnose`) decides *what kind* of failure it
 * was, structurally. This module decides *what to say about it*, and the whole point is that it
 * says it against the engine's actual inventory rather than against a guess: "siunitx is not
 * bundled" is a different sentence — and a different piece of advice — depending on whether the
 * engine has the expl3 primitives siunitx v3 needs. The old triage collapsed both into a flat
 * "unsupported", which is the answer that stops a user from ever filing the issue that would fix
 * it (docs/DESIGN.md §4.5, §7.6).
 *
 * Pure: no DOM, no clock, no `obsidian`. The error card is a rendering of what this returns.
 */

/** The failure as the worker reports it; matches `ErrorMessage` minus the transport fields. */
export interface TexFailure {
	kind: TexErrorKind;
	message: string;
	/** The first `! …` line, when there was one. */
	firstError?: string | undefined;
	/** The `l.NN` line TeX blamed. */
	line?: number | undefined;
	/**
	 * The captured transcript, when the caller has it.
	 *
	 * Not decoration: for `tex-error` the worker sets `message` to the bare `!` text, so the macro
	 * TeX choked on exists *only* in the log. Without this the undefined-control-sequence hint —
	 * the whole reason this module reads capabilities — can never fire on a real failure.
	 */
	log?: readonly string[] | undefined;
}

// --- transcript text ------------------------------------------------------------------------------

/**
 * TeX's `max_print_line`. Any stdout line reaching it is a *wrap*, not a line ending, and the
 * break lands wherever the 80th character happened to fall — including the middle of a control
 * sequence, which is how `\schemestart` arrives as `\schem` + `estart`. Rejoining before matching
 * is the only way `\ce`/`\schemestart` detection survives a long input line.
 */
const WRAP_COLUMNS = 79;

const unwrap = (text: string): string => {
	const out: string[] = [];
	// Continuation is decided by the length of the CHUNK JUST READ, never by the length of the line
	// assembled so far. A wrap chain is `79, 79, …, remainder`, so the remainder ends it — but the
	// assembled line is longer than 79 by definition, and testing that instead makes every
	// subsequent line a continuation too, collapsing the entire transcript into one string. The
	// visible symptom is a real `!` error hiding behind a long `Overfull \hbox` report: it stops
	// being a line that starts with `!`, the overfull guard below matches the glued headline, and
	// the user is told there is nothing to fix.
	let continues = false;
	for (const line of text.split('\n')) {
		const chunk = line.replace(/\r$/, '');
		const prev = out.length > 0 ? out[out.length - 1] : undefined;
		if (continues && prev !== undefined) out[out.length - 1] = prev + chunk;
		else out.push(chunk);
		continues = chunk.length >= WRAP_COLUMNS;
	}
	return out.join('\n');
};

/** TeX's own `! ` prefix, which some producers strip and some do not. */
const withoutBang = (s: string): string => s.replace(/^!\s*/, '').trim();

/** The one line worth putting at the top of the card. */
const headlineOf = (error: TexFailure): string => {
	// protocol.ts documents `firstError` as "the first `! ...` line". Our worker strips the bang;
	// a headline that keeps it would otherwise defeat every `^…`-anchored rule below.
	const explicit = withoutBang(error.firstError?.trim() ?? '');
	if (explicit) return explicit;

	const lines = unwrap(error.message).split('\n');
	const bang = lines.find((l) => /^!/.test(l.trim()));
	return withoutBang(bang ?? lines[0] ?? '');
};

const withoutTrailingStop = (s: string): string => s.replace(/\s*\.\s*$/, '');

// --- control sequences ----------------------------------------------------------------------------

/**
 * Control sequences common enough in the issue tracker to be worth naming a package for. Small and
 * hand-picked on purpose: a large guessed table would be confidently wrong more often than it is
 * right, and a wrong package name costs a user more time than no hint at all.
 */
const PROVIDERS: ReadonlyArray<readonly [string, string]> = [
	['\\si', 'siunitx'],
	['\\SI', 'siunitx'],
	['\\ce', 'mhchem'],
	['\\schemestart', 'chemfig'],
	['\\Forest', 'forest'],
	['\\tcbox', 'tcolorbox'],
	['\\mathscr', 'mathrsfs'],
	['\\qw', 'quantikz'],
];

/** Packages whose modern releases are built on expl3 and therefore need `\expanded`/`\pdfstrcmp`. */
const EXPL3_PACKAGES: ReadonlySet<string> = new Set([
	'siunitx',
	'expl3',
	'xparse',
	'l3keys2e',
	'fontspec',
	'unicode-math',
]);

const CONTROL_SEQUENCE = /\\[a-zA-Z@]+/g;

/**
 * Pull the offending macro out of an `Undefined control sequence` report.
 *
 * TeX echoes the input up to and including the token it choked on, so the *last* control sequence
 * in the excerpt is the offender — except that the excerpt usually continues with the text TeX has
 * not read yet, which can contain later macros. So a name we actually have advice about wins over
 * positional guessing; positional guessing is only the fallback.
 */
const findControlSequence = (text: string): string | undefined => {
	const found = unwrap(text).match(CONTROL_SEQUENCE);
	if (!found) return undefined;

	for (let i = found.length - 1; i >= 0; i--) {
		const cs = found[i];
		if (cs !== undefined && PROVIDERS.some(([name]) => name === cs)) return cs;
	}
	return found[found.length - 1];
};

const providerOf = (cs: string): string | undefined => PROVIDERS.find(([name]) => name === cs)?.[1];

/** How far past the `!` line TeX's input echo can land; the worker uses the same window. */
const BLAME_WINDOW = 8;

/**
 * The first error report plus the input echo underneath it.
 *
 * Searching the whole transcript instead would be worse than searching nothing: banners, font
 * names (`[]\OT1/cmr/m/n/10`) and `Overfull \hbox` reports are full of control sequences that were
 * never the offender, and a *second* error's echo would outrank the first one's under the
 * last-wins fallback. Stopping at the next `!` keeps the excerpt to one error.
 */
const errorExcerpt = (log: readonly string[]): string | undefined => {
	const start = log.findIndex((l) => /^!/.test(l));
	if (start < 0) return undefined;

	const block: string[] = [];
	for (let i = start; i < log.length && block.length < BLAME_WINDOW; i++) {
		const line = log[i] ?? '';
		if (i > start && /^!/.test(line)) break;
		block.push(line);
	}
	return block.join('\n');
};

// --- inventory lookups ----------------------------------------------------------------------------

const baseName = (file: string): string => file.replace(/\.(sty|cls|tex|def|cfg|ldf|clo)$/, '');

/**
 * `files` is the authoritative answer, and the only one.
 *
 * It IS the tex_files list, i.e. exactly what the virtual filesystem can serve. The version table
 * is not a presence oracle: it now omits anything it could not resolve, so consulting it here
 * would report a bundled package as missing whenever its version could not be parsed. A reviewer
 * caught the previous form reading the old 'absent' sentinel as proof of presence — the worst
 * possible direction for an error message to be wrong in, since it tells the user to add a
 * \usepackage that cannot work.
 */
const isBundled = (pkg: string, caps: EngineCapabilities): boolean =>
	caps.files.has(`${pkg}.sty`) || caps.files.has(`${pkg}.cls`) || caps.files.has(`${pkg}.code.tex`);

/** Levenshtein, abandoned once it cannot beat `limit`. Only ever run against ~200 short names. */
const distance = (a: string, b: string, limit: number): number => {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;

	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			const deletion = (prev[j] ?? 0) + 1;
			const insertion = (row[j - 1] ?? 0) + 1;
			const cell = Math.min(substitution, deletion, insertion);
			row.push(cell);
			if (cell < best) best = cell;
		}
		if (best > limit) return limit + 1;
		prev = row;
	}
	return prev[b.length] ?? limit + 1;
};

/**
 * A bundled name close enough to the missing one to be a typo rather than a coincidence.
 *
 * Restricted to the same extension: `tikz.sty` and `tikz.code.tex` are two characters apart in the
 * wrong direction and suggesting one for the other would be actively misleading.
 */
const didYouMean = (name: string, caps: EngineCapabilities): string | undefined => {
	const ext = /\.[a-z.]+$/.exec(name)?.[0] ?? '';
	let best: string | undefined;
	let bestDistance = 3;
	for (const candidate of caps.files) {
		if (candidate === name || !candidate.endsWith(ext)) continue;
		const d = distance(name, candidate, bestDistance - 1);
		if (d < bestDistance) {
			bestDistance = d;
			best = candidate;
		}
	}
	return best;
};

/** The worker sends the bare file name; be tolerant of a caller that sends a sentence around it. */
const FILE_NAME = /[\w@\-./]+\.(?:sty|cls|tex|def|cfg|ldf|clo|tfm|enc|map)/;

const fileNameOf = (error: TexFailure): string => {
	const direct = error.message.trim();
	if (FILE_NAME.test(direct) === false) return direct || 'that file';
	return FILE_NAME.exec(direct)?.[0] ?? direct;
};

// --- per-kind copy --------------------------------------------------------------------------------

const missingFile = (error: TexFailure, caps: EngineCapabilities): Diagnostic => {
	const file = fileNameOf(error);
	const pkg = baseName(file);

	// A name that IS in the inventory is a different failure wearing the same error text: the file
	// exists, so the fix is never "install it". Saying "not bundled" here would send the user off
	// to look for something they already have.
	if (caps.files.has(file)) {
		return {
			kind: 'missing-file',
			message: `${file} is bundled, but TeX could not open it.`,
			line: error.line,
			hint: `${file} is in this engine's file list, so this is not a missing package. Check the \\usepackage or \\input just above the error for a typo in a *different* name, and read the full log — a bundled package can itself ask for a file that is not bundled.`,
		};
	}

	const message = `${file} is not bundled with this TeX engine.`;

	if (EXPL3_PACKAGES.has(pkg)) {
		// The distinction the old flat "unsupported" threw away: with expl3 present, this is a
		// missing file (an inventory decision, fixable); without it, a missing language feature.
		const hint = caps.expl3
			? `This engine does provide the expl3 primitives ${pkg} needs, so ${pkg} is a candidate for being added to the bundle — please open an issue asking for it. Until then, write the markup by hand.`
			: `${pkg} is built on expl3, and this engine does not provide the primitives expl3 needs (\\expanded, \\pdfstrcmp). Adding the .sty alone would not make it work. Write the markup by hand for now — e.g. \\Omega instead of \\si{\\ohm}.`;
		return { kind: 'missing-file', message, line: error.line, hint };
	}

	const near = didYouMean(file, caps);
	const hint = near
		? `The engine can only open files it ships with, and ${file} is not one of them. ${near} is — did you mean that?`
		: `The engine can only open files it ships with: there is no network access and no vault access from inside it, so \\usepackage{${pkg}} cannot be satisfied by installing anything. Use a bundled package, or open an issue asking for this one.`;

	return { kind: 'missing-file', message, line: error.line, hint };
};

/** `! TeX capacity exceeded, sorry [main memory size=5000000]` — the pool name is the whole story. */
const POOL = /\[([^\]=]+)=(\d+)\]/;

// Keyed without TeX's trailing " size", so `main memory size` and `save size` look up the same way.
// The pool name is the only part of a capacity error that says anything actionable.
//
// A Map, not an object literal: the key is parsed out of a string, and an object literal answers
// `constructor` or `toString` from Object.prototype — which is typed `string` here and would put
// `function Object() { [native code] }` in front of the user.
const POOL_ADVICE: ReadonlyMap<string, string> = new Map([
	['main memory', 'Usually a plot with too many points: lower samples=, drop unused \\addplot rows, or split one picture into several.'],
	['pool', 'Usually a plot with too many points: lower samples=, drop unused \\addplot rows, or split one picture into several.'],
	['save', 'Usually deeply nested scopes or groups — flatten the picture, or move repeated settings into a single \\tikzset.'],
	['input stack', 'Usually a macro that expands into itself. Check any \\def or \\newcommand that mentions its own name.'],
	['parameter stack', 'Usually a macro that expands into itself. Check any \\def or \\newcommand that mentions its own name.'],
	['buffer', 'Usually one enormous input line. Break long coordinate lists or long \\addplot table data across several lines.'],
	['grouping levels', 'Usually deeply nested scopes or groups — flatten the picture.'],
	['text input levels', 'Too many nested \\input files.'],
	['hash', 'Too many distinct macro names — this engine has a fixed hash and cannot be grown at runtime.'],
	['number of strings', 'Too many distinct macro and file names — split the diagram across several blocks.'],
	['pattern memory', 'Too many hyphenation patterns — this is a bundled-format limit, not something the diagram can fix.'],
]);

const capacity = (error: TexFailure): Diagnostic => {
	const headline = headlineOf(error);
	const match = POOL.exec(`${headline}\n${error.message}`);
	const pool = match?.[1]?.trim();
	const size = match?.[2];

	const message = pool
		? `TeX ran out of ${pool}${size ? ` (limit ${size})` : ''}.`
		: 'TeX ran out of memory.';

	const specific = pool ? POOL_ADVICE.get(pool.replace(/\s+size$/, '')) : undefined;
	const hint = `${specific ?? 'Simplify the diagram: fewer points, fewer paths, less nesting.'} This engine's pools are fixed at build time, so the diagram has to fit them.`;

	return { kind: 'capacity', message, line: error.line, hint };
};

const UNDEFINED_CS = /undefined control sequence/i;

const texError = (error: TexFailure, caps: EngineCapabilities): Diagnostic => {
	const headline = withoutTrailingStop(headlineOf(error));

	if (UNDEFINED_CS.test(headline)) {
		// The log first: it is the only place the offending macro survives when `message` is just
		// the `!` line, which is exactly what the worker sends.
		const echo = error.log ? errorExcerpt(error.log) : undefined;
		const cs = findControlSequence(echo ?? `${error.message}\n${error.firstError ?? ''}`);
		if (cs === undefined) {
			return {
				kind: 'tex-error',
				message: 'Undefined control sequence.',
				line: error.line,
				hint: 'TeX did not echo the macro it choked on. The full log below shows the input line it was reading.',
			};
		}

		const provider = providerOf(cs);
		let hint: string;
		if (provider === undefined) {
			hint = `${cs} is not defined by anything this document loads. Check the spelling, or add the \\usepackage that provides it.`;
		} else if (isBundled(provider, caps)) {
			hint = `${cs} comes from the ${provider} package, which this engine does bundle — add \\usepackage{${provider}} to the preamble.`;
		} else if (EXPL3_PACKAGES.has(provider) && caps.expl3) {
			hint = `${cs} comes from the ${provider} package, which is not bundled. This engine does provide the expl3 primitives ${provider} needs, so it could be added — please open an issue asking for it.`;
		} else {
			hint = `${cs} comes from the ${provider} package, which is not bundled, so \\usepackage{${provider}} will not help either. Write it by hand, or open an issue asking for the package.`;
		}

		return { kind: 'tex-error', message: `Undefined control sequence ${cs}`, line: error.line, hint };
	}

	// A few error texts that are common enough to name a cause for; everything else gets the log.
	let hint: string | undefined;
	if (/^missing \$ inserted/i.test(headline)) {
		hint = 'A maths-mode character (_, ^, \\alpha …) appeared in text. Wrap it in $…$, or use a node with a maths label.';
	} else if (/pgfkeys.*(?:key|choice)/i.test(headline)) {
		hint = 'An option this version of the package does not have. The engine bundles older releases than CTAN, so a documented key may simply not exist here yet.';
	} else if (/environment .* undefined/i.test(headline)) {
		hint = 'The environment needs a package that is not loaded. Add the \\usepackage for it, or check the spelling.';
	}

	return {
		kind: 'tex-error',
		message: headline ? `${headline}.` : 'TeX reported an error.',
		line: error.line,
		hint,
	};
};

const OVERFULL = /(?:Over|Under)full\s+\\[hv]box/i;

// --- entry point ----------------------------------------------------------------------------------

export function explain(error: TexFailure, caps: EngineCapabilities): Diagnostic {
	const headline = headlineOf(error);

	// `Overfull \hbox` is routine with node text and TeX still produced a perfectly good diagram,
	// so it must never become a red card — that is strictly worse than the broken image it would
	// replace (docs/DESIGN.md §7.6). The engine already filters it; this is the second wall, and it
	// tests the *headline* rather than the whole transcript so that a genuine error whose log
	// happens to contain an overfull box further down is not silently downgraded.
	if (OVERFULL.test(headline)) {
		return {
			kind: 'warning',
			message: 'TeX reported an overfull box.',
			line: error.line,
			hint: 'Routine with node text: a label is slightly wider than the box TeX reserved for it. The diagram rendered — nothing to fix unless something visibly overlaps.',
		};
	}

	switch (error.kind) {
		case 'missing-file':
			return missingFile(error, caps);

		case 'capacity':
			return capacity(error);

		case 'tex-error':
			return texError(error, caps);

		case 'empty-output':
			return {
				kind: 'empty-output',
				message: 'TeX ran successfully but produced no diagram.',
				line: error.line,
				hint: 'Nothing was drawn, so the block is most likely empty or entirely commented out. Check that a \\begin{tikzpicture} exists and that no % comments it out.',
			};

		case 'timeout':
			return {
				kind: 'timeout',
				message: 'The diagram took longer than its time budget.',
				line: error.line,
				hint: 'The engine was terminated and restarted, so nothing is stuck. Simplify the diagram — fewer samples, fewer plots, less \\foreach nesting — or raise the timeout in settings if you know it just needs longer.',
			};

		case 'engine-unavailable':
			return {
				kind: 'engine-unavailable',
				message: 'The TeX engine could not start.',
				line: error.line,
				hint: 'No diagram on this page will render until it does. Reload Obsidian; on mobile this is usually memory pressure, so close other apps first.',
			};

		default:
			// An engine newer than this build, or a kind added on the worker side first. Say what we
			// were told rather than throwing away the only information we have.
			return {
				kind: error.kind,
				message: withoutTrailingStop(headline) ? `${withoutTrailingStop(headline)}.` : 'TeX failed.',
				line: error.line,
				hint: 'The plugin has no specific advice for this failure. The full log below is the best next step.',
			};
	}
}
