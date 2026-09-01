import type { BlockOptions, ColorMode, LazyMode, SvgoMode } from '../types';

/**
 * `%!tikz` per-block option directives. See docs/DESIGN.md §7.7.
 *
 * Options live in the BODY of the block and nowhere else. The obvious alternative — a code-fence
 * info string, ```tikz width=420 — is unreachable for a *correctness* reason, not a stylistic one:
 * Obsidian keys the code-block registry on the first info-string token and hands the processor only
 * `(source, el, ctx)`. Reading the tail needs `ctx.getSectionInfo(el).text`, which returns `null`
 * in PDF export, embeds, hover previews and `MarkdownRenderer.render`. A key-affecting option
 * carried there would be visible in Live Preview and invisible in export, so the same block would
 * resolve to two different cache keys and the PDF would get a differently compiled diagram. A body
 * directive is in `source` on every render path and hashes naturally.
 *
 * This module is pure: it parses, it never resolves. `%:input` and `preamble=` yield paths that
 * `source/preamble.ts` resolves against the vault (with recursion, cycle detection and dependency
 * hashing); nothing here reads a file, touches the DOM or looks at a clock.
 */

// -------------------------------------------------------------------------------------------

export interface ParsedDirectives {
	options: BlockOptions;
	/** `source` with every directive line removed, so directives never reach TeX and are never
	 *  hashed twice — once as body text and again as the options they became. */
	body: string;
	/** `%:input` paths in source order, exactly as written. Unresolved, unvalidated, not deduped:
	 *  duplicate detection is the resolver's job, since it is the one that can see cycles. */
	inputs: string[];
	/**
	 * `preamble=<path>`, unresolved.
	 *
	 * Not folded into `baked.preamble`: that field is the fully expanded preamble TEXT (it is what
	 * `KeyInputs` hashes, and there is no separate `preambleText` beside it), and a parser that
	 * cannot read the vault must not put a path where TeX source is expected.
	 */
	preamblePath: string | null;
	/**
	 * `svgo=`, which has no slot in `BlockOptions` — it reaches the cache key through
	 * `artifactRevision`, not through `BakedOptions`, so it is returned beside the options rather
	 * than inside them. `null` means the directive did not set it and the global setting stands.
	 */
	svgo: SvgoMode | null;
}

interface Pair {
	key: string;
	/** `null` for a bare flag (`%!tikz fast`), which is distinct from `key=` (empty string). */
	value: string | null;
}

interface MutableExtras {
	preamblePath: string | null;
	svgo: SvgoMode | null;
}

const TIKZ_PREFIX = '%!tikz';
const INPUT_PREFIX = '%:input';

/** Everything `applyPair` handles. Drives the "did you mean" hint for a misspelling. */
const KNOWN_KEYS = [
	'width',
	'max-width',
	'scale',
	'align',
	'alt',
	'colors',
	'lazy',
	'timeout',
	'border',
	'packages',
	'libraries',
	'preamble',
	'wrap',
	'svgo',
	'fast',
	'raw',
	'nocache',
];

/**
 * Keys DESIGN.md §7.7's table lists that this build has no field for. They get a specific message
 * rather than "unknown option", because a user who typed one read the design and deserves to know
 * it was dropped rather than misspelled.
 */
const RETIRED_KEYS: Record<string, string> = {
	options: "'options' is not supported; put TikZ options on the picture itself",
	tikzoptions: "'tikzoptions' is not supported; put TikZ options on the picture itself",
	engine: "'engine' is a global setting, not a per-block option",
};

/**
 * A CSS length, or a bare number meaning px. Deliberately a whitelist: the value is written into an
 * inline `style`, so anything looser makes `width=1px;background:url(…)` a per-note style
 * injection. Same reason the TeX-side values below are whitelisted — those are spliced into a
 * `\usepackage{…}` / `\usetikzlibrary{…}` argument.
 */
const CSS_LENGTH = /^\d*\.?\d+(?:px|em|rem|ex|ch|%|vw|vh|vmin|vmax|pt|cm|mm|in|pc)$/;
/** `.5` as well as `0.5`: a leading dot is how people write a half, and CSS accepts it. */
const BARE_NUMBER = /^\d*\.?\d+$/;
const TEX_DIMEN = /^\d*\.?\d+(?:pt|mm|cm|in|bp|pc|dd|cc|sp|ex|em)$/;
const PACKAGE_NAME = /^[A-Za-z0-9@._-]+$/;
/**
 * The other half of what is spliced: worker.ts writes `\usepackage[${opts}]{${name}}`, so an
 * unchecked payload closes the option list with `]` and runs whatever follows as TeX. Whitelisting
 * the name alone guards nothing. A package option list is `key=value` pairs, which needs letters,
 * digits, `=`, `,`, separators and spaces — and no brace, backslash, bracket or `%`.
 */
const PACKAGE_OPTIONS = /^[A-Za-z0-9@_,.=:+*/ -]*$/;
const LIBRARY_NAME = /^[A-Za-z0-9._-]+$/;

// -------------------------------------------------------------------------------------------

export function parseDirectives(source: string, defaults: BlockOptions): ParsedDirectives {
	const options = cloneOptions(defaults);
	const warnings = options.warnings;
	const inputs: string[] = [];
	const extras: MutableExtras = { preamblePath: null, svgo: null };

	const lines = source.split('\n');
	const kept: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const lineNo = i + 1;
		const trimmed = line.trimStart();

		// A `%!tikz` that happens to sit inside a verbatim-looking environment is still parsed.
		// TeX has no verbatim worth special-casing inside a tikzpicture — `\verb` cannot span a
		// newline, and a real `verbatim` body in a diagram is vanishingly rare next to the cost of
		// a directive that silently does nothing because of where in the block it was written.
		if (hasDirective(trimmed, TIKZ_PREFIX)) {
			for (const pair of tokenize(trimmed.slice(TIKZ_PREFIX.length), lineNo, warnings)) {
				applyPair(pair, options, extras, lineNo, warnings);
			}
			continue;
		}

		if (hasDirective(trimmed, INPUT_PREFIX)) {
			const path = unquote(trimmed.slice(INPUT_PREFIX.length).trim());
			if (path === '') warnings.push(`line ${lineNo}: %:input needs a path`);
			else inputs.push(path);
			continue;
		}

		kept.push(line);
	}

	return {
		options,
		body: kept.join('\n'),
		inputs,
		preamblePath: extras.preamblePath,
		svgo: extras.svgo,
	};
}

/**
 * `%!tikzfoo` is a plain TeX comment, not a malformed directive: the prefix must be followed by
 * whitespace or end the line. `\r` counts, so a stray CR from an un-normalized source does not turn
 * the last option on the line into garbage.
 */
function hasDirective(trimmed: string, prefix: string): boolean {
	// Case-folded like every key and value. A `%!TikZ` line that stayed a comment would be the one
	// failure this module refuses to produce anywhere else: the option is not applied and nothing
	// warns, because a comment is a perfectly legal thing to write.
	if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return false;
	const next = trimmed[prefix.length];
	return next === undefined || next === ' ' || next === '\t' || next === '\r';
}

function isSpace(c: string | undefined): boolean {
	return c === ' ' || c === '\t' || c === '\r';
}

/**
 * Space-separated `key=value` pairs. A value may be bare, "double quoted" or 'single quoted'; a
 * quoted value may contain spaces and `=`.
 *
 * There is deliberately no backslash escape. Directive values are TeX (`alt="the set \(A\)"`) and
 * vault paths, both of which are full of backslashes; treating `\` as an escape would mangle every
 * one of them. To put a `"` inside a value, quote it with `'`.
 */
function tokenize(rest: string, lineNo: number, warnings: string[]): Pair[] {
	const pairs: Pair[] = [];
	let i = 0;

	while (i < rest.length) {
		if (isSpace(rest[i])) {
			i++;
			continue;
		}

		let key = '';
		while (i < rest.length && rest[i] !== '=' && !isSpace(rest[i])) {
			key += rest[i];
			i++;
		}

		if (rest[i] !== '=') {
			pairs.push({ key, value: null });
			continue;
		}
		i++;

		const quote = rest[i];
		if (quote === '"' || quote === "'") {
			i++;
			const end = rest.indexOf(quote, i);
			if (end === -1) {
				warnings.push(`line ${lineNo}: unterminated quote in '${key}='`);
				pairs.push({ key, value: rest.slice(i) });
				i = rest.length;
			} else {
				pairs.push({ key, value: rest.slice(i, end) });
				i = end + 1;
			}
			continue;
		}

		let value = '';
		while (i < rest.length && !isSpace(rest[i])) {
			value += rest[i];
			i++;
		}
		pairs.push({ key, value });
	}

	return pairs;
}

function applyPair(
	pair: Pair,
	options: BlockOptions,
	extras: MutableExtras,
	lineNo: number,
	warnings: string[],
): void {
	// `max-width`, `max_width` and `maxWidth` are one key; a user should not have to remember which
	// spelling this parser happens to prefer.
	const lowered = pair.key.toLowerCase().replace(/_/g, '-');
	const key = lowered === 'maxwidth' ? 'max-width' : lowered;
	const value = pair.value;

	const bad = (what: string): void => {
		warnings.push(`line ${lineNo}: ${what}; keeping the default`);
	};
	// Returns the value only when there is one, so every branch below can trust it.
	const required = (): string | null => {
		if (value === null || value === '') {
			bad(`'${key}' needs a value`);
			return null;
		}
		return value;
	};

	switch (key) {
		// --- presentation: never in the cache key, so changing one costs no recompile ---------
		case 'width':
		case 'max-width': {
			const v = required();
			if (v === null) return;
			const length = asCssLength(v, key === 'width' ? 'auto' : 'none');
			if (length === null) {
				bad(`'${key}=${v}' is not a CSS length`);
				return;
			}
			if (key === 'width') options.presentation.width = length;
			else options.presentation.maxWidth = length;
			return;
		}
		case 'scale': {
			const v = required();
			if (v === null) return;
			// Whitelisted rather than handed to `Number`, which reads '0x10' as 16, '1e3' as 1000 and
			// ' 2 ' as 2 — three ways for a typo to become a silently enormous diagram.
			const n = BARE_NUMBER.test(v.trim()) ? Number(v) : NaN;
			if (!Number.isFinite(n) || n <= 0) {
				bad(`'scale=${v}' is not a positive number`);
				return;
			}
			options.presentation.scale = n;
			return;
		}
		case 'align': {
			const v = required();
			if (v === null) return;
			const align = v.toLowerCase();
			if (align !== 'left' && align !== 'center' && align !== 'right') {
				bad(`'align=${v}' is not left, center or right`);
				return;
			}
			options.presentation.align = align;
			return;
		}
		case 'alt': {
			if (value === null) {
				bad("'alt' needs a value");
				return;
			}
			// `alt=""` is meaningful, not an error: it is §7.11's "the author says this diagram is
			// decorative", which mounts `aria-hidden` instead of inventing a name for it.
			options.presentation.alt = value;
			return;
		}
		case 'colors': {
			const v = required();
			if (v === null) return;
			const mode = v.toLowerCase();
			if (mode !== 'adapt' && mode !== 'preserve' && mode !== 'paper' && mode !== 'invert') {
				bad(`'colors=${v}' is not adapt, preserve, paper or invert`);
				return;
			}
			options.presentation.colors = mode satisfies ColorMode;
			return;
		}
		case 'lazy': {
			const v = required();
			if (v === null) return;
			const mode = v.toLowerCase();
			if (mode !== 'on' && mode !== 'off' && mode !== 'manual') {
				bad(`'lazy=${v}' is not on, off or manual`);
				return;
			}
			options.presentation.lazy = mode satisfies LazyMode;
			return;
		}
		case 'timeout': {
			const v = required();
			if (v === null) return;
			const ms = asMilliseconds(v);
			if (ms === null) {
				bad(`'timeout=${v}' is not a positive duration`);
				return;
			}
			options.presentation.timeoutMs = ms;
			return;
		}

		// --- baked: changes the bytes TeX produces, so every one of these is in the cache key --
		case 'border': {
			const v = required();
			if (v === null) return;
			// An explicit "no border" has to be expressible, because `null` is not merely the
			// default — it is what keeps the legacy-cache import window open (§8.3), so a user
			// undoing a global border setting must be able to get back to injecting nothing.
			if (/^(?:none|off|false)$/i.test(v.trim())) {
				options.baked.border = null;
				return;
			}
			const dimen = asTexDimen(v);
			if (dimen === null) {
				bad(`'border=${v}' is not a TeX length`);
				return;
			}
			options.baked.border = dimen;
			return;
		}
		case 'packages': {
			const v = required();
			if (v === null) return;
			for (const item of splitList(v)) {
				// `circuitikz[siunitx,european]` -> \usepackage[siunitx,european]{circuitikz}
				const m = /^([^[\]]+)(?:\[(.*)\])?$/.exec(item);
				const name = m?.[1]?.trim() ?? '';
				if (m === null || !PACKAGE_NAME.test(name)) {
					warnings.push(`line ${lineNo}: '${item}' is not a package name; skipped`);
					continue;
				}
				const opts = m[2]?.trim() ?? '';
				if (!PACKAGE_OPTIONS.test(opts)) {
					warnings.push(
						`line ${lineNo}: '${item}' has package options that are not a key=value list; skipped`,
					);
					continue;
				}
				options.baked.packages[name] = opts;
			}
			return;
		}
		case 'libraries': {
			const v = required();
			if (v === null) return;
			const merged = options.baked.libraries
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s !== '');
			for (const item of splitList(v)) {
				if (!LIBRARY_NAME.test(item)) {
					warnings.push(`line ${lineNo}: '${item}' is not a TikZ library name; skipped`);
					continue;
				}
				// \usetikzlibrary is idempotent but not free: each repeated name is a file probe.
				if (!merged.includes(item)) merged.push(item);
			}
			options.baked.libraries = merged.join(',');
			return;
		}
		case 'preamble': {
			const v = required();
			if (v === null) return;
			extras.preamblePath = v;
			return;
		}
		case 'twopass':
		case 'two-pass': {
			// Baked, because the second pass changes the stored bytes. It roughly doubles the
			// compile, so it is never global — and it is free on a block that cannot benefit,
			// since the worker only runs the second pass when the first left something readable
			// behind. It resolves \label/\ref; it does NOT fix \chemmove or \polymerdelim
			// (upstream #9, #70), which are blocked on the driver, not the pass count.
			const v = value === undefined || value === null ? 'on' : value.toLowerCase();
			if (v === 'on' || v === 'true' || v === 'yes') options.baked.twoPass = true;
			else if (v === 'off' || v === 'false' || v === 'no') options.baked.twoPass = false;
			else bad(`'twopass=${value ?? ''}' is not on or off`);
			return;
		}
		case 'wrap': {
			const v = required();
			if (v === null) return;
			// DECISIONS D10 names this override `on|off|auto`; `BakedOptions` names it
			// `always|never|auto`. Both spellings are accepted rather than making a user find out
			// by experiment which of the two documents the implementation followed.
			const mode = v.toLowerCase();
			const wrap =
				mode === 'on' || mode === 'always' || mode === 'true'
					? 'always'
					: mode === 'off' || mode === 'never' || mode === 'false'
						? 'never'
						: mode === 'auto'
							? 'auto'
							: null;
			if (wrap === null) {
				bad(`'wrap=${v}' is not auto, always or never`);
				return;
			}
			options.baked.wrap = wrap;
			return;
		}

		// --- flags -----------------------------------------------------------------------------
		case 'svgo': {
			const v = required();
			if (v === null) return;
			const mode = v.toLowerCase();
			if (mode !== 'preset' && mode !== 'targeted' && mode !== 'off') {
				bad(`'svgo=${v}' is not preset, targeted or off`);
				return;
			}
			extras.svgo = mode satisfies SvgoMode;
			return;
		}
		case 'fast':
		case 'raw':
		case 'nocache': {
			const flag = asBoolean(value);
			if (flag === null) {
				bad(`'${key}=${value ?? ''}' is not a boolean`);
				return;
			}
			options[key] = flag;
			return;
		}

		default: {
			const retired = RETIRED_KEYS[key];
			if (retired !== undefined) {
				warnings.push(`line ${lineNo}: ${retired}`);
				return;
			}
			if (key === '') {
				// `%!tikz =3` and friends: a value with no key at all.
				warnings.push(`line ${lineNo}: option with no name; ignored`);
				return;
			}
			const hint = suggest(key);
			warnings.push(
				`line ${lineNo}: unknown option '${pair.key}'${hint === null ? '' : `; did you mean '${hint}'?`}`,
			);
			return;
		}
	}
}

// -------------------------------------------------------------------------------------------
// Value parsing

/**
 * `keyword` is the one non-length value the target property accepts — `auto` for `width`, `none`
 * for `max-width`. They are not interchangeable: `width: none` and `max-width: auto` are invalid
 * CSS, so the browser drops the whole declaration and the directive silently does nothing.
 */
function asCssLength(value: string, keyword: string): string | null {
	const v = value.trim();
	if (v === keyword) return v;
	if (BARE_NUMBER.test(v)) return `${v}px`;
	return CSS_LENGTH.test(v) ? v : null;
}

/** Bare numbers are seconds, matching how the setting is worded; `s` and `ms` are also accepted. */
function asMilliseconds(value: string): number | null {
	const m = /^(\d*\.?\d+)(ms|s)?$/.exec(value.trim());
	if (m === null) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const ms = m[2] === 'ms' ? Math.round(n) : Math.round(n * 1000);
	// `timeout=0.0001` rounds to 0, and a 0 ms budget is not "no timeout": queue.ts arms a timer
	// that fires before the job starts, so the block fails instantly and its key is poisoned for
	// the session. Refused for the same reason `timeout=0` is.
	return ms > 0 ? ms : null;
}

/** Up to four space-separated dimensions, as `\standaloneconfig{border=…}` accepts. */
function asTexDimen(value: string): string | null {
	const parts = value.split(/\s+/).filter((p) => p !== '');
	if (parts.length === 0 || parts.length > 4) return null;
	const out: string[] = [];
	for (const part of parts) {
		if (BARE_NUMBER.test(part)) out.push(`${part}pt`);
		else if (TEX_DIMEN.test(part)) out.push(part);
		else return null;
	}
	return out.join(' ');
}

function asBoolean(value: string | null): boolean | null {
	if (value === null) return true; // a bare `%!tikz fast` is the documented spelling
	const v = value.toLowerCase();
	if (v === 'true' || v === 'on' || v === 'yes' || v === '1') return true;
	if (v === 'false' || v === 'off' || v === 'no' || v === '0') return false;
	return null;
}

/** Comma list, ignoring commas inside `[…]` so `circuitikz[siunitx,european]` survives. */
function splitList(value: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of value) {
		if (ch === '[') depth++;
		else if (ch === ']') depth = Math.max(0, depth - 1);
		if (ch === ',' && depth === 0) {
			items.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	items.push(current.trim());
	return items.filter((item) => item !== '');
}

/** `%:input "my notes/macros.tex"` — quoting a path is the only way to keep a trailing space, and
 *  costs nothing to accept. */
function unquote(value: string): string {
	const first = value[0];
	if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
		return value.slice(1, -1);
	}
	return value;
}

/** Nearest known key, so `wdith` gets a hint and `frobnicate` does not. */
function suggest(key: string): string | null {
	// Two edits is most of a three-letter key, so a flat radius makes `w` "did you mean 'raw'?" —
	// pointing a user who meant `width` at a flag that changes what the pipeline does.
	let best: string | null = null;
	let bestDistance = Math.min(2, Math.floor(key.length / 2)) + 1;
	for (const candidate of KNOWN_KEYS) {
		const d = editDistance(key, candidate);
		if (d < bestDistance) {
			bestDistance = d;
			best = candidate;
		}
	}
	return best;
}

function editDistance(a: string, b: string): number {
	let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row: number[] = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row.push(Math.min((row[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
		}
		previous = row;
	}
	return previous[b.length] ?? Math.max(a.length, b.length);
}

/** A parse never writes through to the caller's defaults: one defaults object is shared by every
 *  block in the vault, so a mutation here would leak one note's options into the next. */
function cloneOptions(defaults: BlockOptions): BlockOptions {
	return {
		baked: {
			...defaults.baked,
			packages: { ...defaults.baked.packages },
			depHashes: [...defaults.baked.depHashes],
		},
		presentation: { ...defaults.presentation },
		raw: defaults.raw,
		nocache: defaults.nocache,
		fast: defaults.fast,
		warnings: [...defaults.warnings],
	};
}
