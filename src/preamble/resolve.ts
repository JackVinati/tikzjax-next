import type { Diagnostic } from '../types';

/**
 * Preamble resolution: turns the paths a user wrote into one block of TeX. See internal/DESIGN.md §7.7.
 *
 * `preamble=<path>` and `%:input <path>` have been *parsed* since directives.ts, and then dropped on
 * the floor — this is the module that makes them mean something. Upstream #46, #76, #77, #83.
 *
 * Pure by construction: the vault arrives as `PreambleSource` and the digest as `hash`. No DOM, no
 * `obsidian`, no clock. That is not decoration — cycle detection, the depth cap and the dependency
 * set are exactly the things that are impossible to test against a real vault and trivial to test
 * against four strings in a Map.
 *
 * Three properties this module owes the rest of the plugin:
 *
 *   1. A missing file is a VISIBLE diagnostic. PR #77 spliced `""` for a file it could not find, and
 *      its author conceded the limitation openly; the user then gets a TeX error about an undefined
 *      control sequence, a hundred lines away from the include that actually failed. Not repeating
 *      that is most of the point of this file.
 *   2. It always resolves. A cycle, a depth blow-out or a vault read that throws all become
 *      diagnostics — never a hang, never a stack overflow, never a rejected promise. The render
 *      child's settle path has no branch for "the preamble threw".
 *   3. `deps`/`depHashes` are sorted and deduped, so a set of files produces one cache key however
 *      the includes were ordered. `depHashes` goes into `BakedOptions`, i.e. into the key; if it
 *      were order-dependent, reordering two `%:input` lines that define disjoint macros would
 *      recompile the diagram, and DESIGN.md §6.3's per-file invalidation would be keyed on noise.
 */

/**
 * How deep `%:input` may nest. Ten is far past any legitimate preamble (upstream's deepest is one
 * level) and far short of anything that troubles the stack; it exists so a pathological include
 * fan-out is bounded even when it contains no cycle at all.
 */
export const MAX_INCLUDE_DEPTH = 10;

const INPUT_PREFIX = '%:input';

export interface PreambleSource {
	/** Resolve a link/path as written, relative to the note that wrote it. null if absent. */
	resolve(path: string, fromNotePath: string): string | null;
	read(canonicalPath: string): Promise<string>;
}

export interface ResolvedPreamble {
	/** Fully expanded, ready for `RenderOptions.addToPreamble`. */
	text: string;
	/** Canonical paths read, sorted and deduped. */
	deps: string[];
	/** Sorted `"path:hash"`, for `BakedOptions.depHashes`. */
	depHashes: string[];
	/** Missing files, cycles, depth exceeded. */
	diagnostics: Diagnostic[];
}

/**
 * The paths, already discovered but not yet resolved.
 *
 * §7.7's precedence is global setting → walked-up `tikz-preamble.tex` → `preamble=` → `%:input`, and
 * that is the order these are composed in. Discovery stays with the caller: finding the walk-up file
 * means asking the vault what exists, which is precisely the knowledge this module refuses to have.
 *
 * `walkUpPath` is optional because a caller that has no walk-up setting has nothing to pass; it is
 * its own slot rather than being folded into `globalPath` so that a vault with both a global
 * preamble and a folder-level one gets both, in the documented order, rather than whichever the
 * caller decided to keep.
 */
export interface PreambleEntry {
	globalPath: string | null;
	walkUpPath?: string | null | undefined;
	blockPath: string | null;
	inputs: readonly string[];
}

/** Which knob named the path. Only ever used to word a diagnostic — the user has to know which. */
type Origin = 'global' | 'walk-up' | 'directive' | 'input';

interface Ctx {
	readonly source: PreambleSource;
	readonly hash: (text: string) => string;
	readonly diagnostics: Diagnostic[];
	/** canonical path -> digest of the bytes read. Doubles as the dedupe behind `deps`. */
	readonly hashes: Map<string, string>;
	/** canonical path -> the read itself, so one file is fetched once per resolution. */
	readonly reads: Map<string, Promise<string>>;
	/** Canonical paths already spliced into the output. See `expand` for why this is not `hashes`. */
	readonly emitted: Set<string>;
}

export async function resolvePreamble(
	entry: PreambleEntry,
	fromNotePath: string,
	source: PreambleSource,
	hash: (text: string) => string,
): Promise<ResolvedPreamble> {
	const ctx: Ctx = {
		source,
		hash,
		diagnostics: [],
		hashes: new Map(),
		reads: new Map(),
		emitted: new Set(),
	};

	const parts: string[] = [];
	for (const slot of slots(entry)) {
		// Sequential rather than Promise.all: include-once, cycle detection and diagnostic order all
		// depend on a deterministic traversal, and a preamble is two or three small files that the
		// adapter reads through Obsidian's own `cachedRead`. Concurrency here would buy microseconds
		// and cost reproducibility of the cache key.
		const text = await expand(ctx, slot.path, slot.origin, fromNotePath, []);
		if (text !== '') parts.push(text);
	}

	// Each sorted independently, so `deps[i]` is NOT `depHashes[i]`: appending `:` re-orders any pair
	// where one path is a prefix of the other (`a` vs `a/b`, since ':' > '/'). Both are consumed as
	// sets — one keyed on files to watch, one hashed into the key — and neither is ever zipped.
	const deps = [...ctx.hashes.keys()].sort();
	const depHashes = deps.map((path) => `${path}:${ctx.hashes.get(path) ?? ''}`).sort();

	return {
		text: parts.join('\n'),
		deps,
		depHashes,
		// One problem, one chip: a duplicated `%:input`, or a `preamble=` that repeats the global
		// setting, would otherwise produce the same sentence twice. Deduping by message is enough
		// and is not over-eager, because every message names both the path and the file that
		// included it — two genuinely different failures never collide.
		diagnostics: dedupe(ctx.diagnostics),
	};
}

/**
 * Trimmed here rather than in `expand`, because this is the only place that knows the path came out
 * of a settings text box or a directive value, where surrounding whitespace is always a typo. A
 * quoted `%:input "a .tex "` reaches `expand` by a different route and keeps its spaces.
 */
function slots(entry: PreambleEntry): { path: string; origin: Origin }[] {
	const out: { path: string; origin: Origin }[] = [];
	if (entry.globalPath !== null) out.push({ path: entry.globalPath.trim(), origin: 'global' });
	const walkUp = entry.walkUpPath ?? null;
	if (walkUp !== null) out.push({ path: walkUp.trim(), origin: 'walk-up' });
	if (entry.blockPath !== null) out.push({ path: entry.blockPath.trim(), origin: 'directive' });
	for (const input of entry.inputs) out.push({ path: input.trim(), origin: 'input' });
	return out;
}

/**
 * Read one file, splice its own `%:input`s into it, return the text.
 *
 * `stack` is the chain of canonical ancestors, outermost first — the cycle detector and the thing
 * the cycle diagnostic prints. `fromPath` is what the path is resolved *against*: the note for a
 * top-level slot, and the INCLUDING FILE for a nested one, so `%:input macros.tex` inside
 * `latex/base.tex` finds `latex/macros.tex`. Three separate commenters on PR #77 hit exactly that:
 * they wrote a path relative to the file they wrote it in, and the plugin looked in the vault root.
 */
async function expand(
	ctx: Ctx,
	path: string,
	origin: Origin,
	fromPath: string,
	stack: readonly string[],
): Promise<string> {
	// An unset setting is an empty string as often as it is null, and "" is not a missing file: it
	// is a user who has no global preamble. Diagnosing it would put a permanent error card under
	// every diagram in a default vault — and, worse, `text` would still be empty, so the L3
	// legacy-import gate (§8.3) would stay open while the UI claimed something was broken.
	//
	// Whitespace was already stripped by whoever produced the path — `slots` for a settings field,
	// `inputPath` for a directive — because only they can tell a stray space in a text box from one
	// the user deliberately quoted. Trimming again here would silently unquote `%:input "a .tex "`.
	if (path === '') return '';

	// `resolve` is as able to throw as `read` is, and for the same reason: it is the injected
	// Obsidian boundary (`metadataCache.getFirstLinkpathDest` + `vault.getAbstractFileByPath`), not
	// a pure function this module owns. Leaving it unguarded made a throw here an unhandled
	// rejection out of `resolvePreamble` — and the render child's settle path has no branch for
	// "the preamble threw", so the block would spin forever instead of showing a card. Found in
	// review; the guarantee at the top of this file says *never* a rejected promise, and half a
	// guarantee is worse than none because nothing downstream is written to expect the other half.
	let canonical: string | null;
	try {
		canonical = ctx.source.resolve(path, fromPath);
	} catch (error) {
		ctx.diagnostics.push(unresolvable(path, origin, stack, error));
		return '';
	}
	if (canonical === null) {
		ctx.diagnostics.push(notFound(path, origin, stack));
		return '';
	}

	const at = stack.indexOf(canonical);
	if (at !== -1) {
		ctx.diagnostics.push(cycle([...stack.slice(at), canonical]));
		return '';
	}

	// Include-once, not include-always. A preamble file is a pile of `\newcommand`s, and TeX greets
	// a second copy with `! LaTeX Error: Command \foo already defined` — so a diamond (two files that
	// both include one shared macro file) would turn a perfectly legal include graph into a compile
	// failure. Splicing the first occurrence and skipping the rest is what `\usepackage` does, and
	// it is what a user who wrote the graph expects. Silent by design: the content is already there.
	if (ctx.emitted.has(canonical)) return '';

	if (stack.length >= MAX_INCLUDE_DEPTH) {
		ctx.diagnostics.push(tooDeep(canonical, stack));
		return '';
	}

	// Marked before the read, so a file that fails to read is diagnosed once rather than once per
	// reference to it.
	ctx.emitted.add(canonical);

	let text: string;
	try {
		text = await read(ctx, canonical);
	} catch (error) {
		ctx.diagnostics.push(unreadable(canonical, error));
		return '';
	}

	// The digest is over the bytes as read, never over the expansion: `depHashes` answers "has this
	// FILE changed", and an expansion-level digest would make every file in a chain appear to change
	// whenever any file below it did.
	ctx.hashes.set(canonical, ctx.hash(text));

	const childStack = [...stack, canonical];
	const out: string[] = [];
	for (const line of text.split('\n')) {
		const included = inputPath(line);
		if (included === null) {
			out.push(line);
			continue;
		}
		// The directive line itself never reaches TeX. It is a comment, so leaving it would be
		// harmless to the compile, but it would be hashed into `baked.preamble` — and then editing
		// a comment in a shared preamble would recompile every diagram in the vault.
		if (included === '') {
			ctx.diagnostics.push({
				kind: 'warning',
				message: `%:input with no path in ${canonical}; ignored.`,
			});
			continue;
		}
		const child = await expand(ctx, included, 'input', canonical, childStack);
		if (child !== '') out.push(child);
	}

	return out.join('\n');
}

/**
 * One read per file per resolution.
 *
 * Include-once already means no file is expanded twice, so this memo looks redundant — it is not.
 * Read-once and include-once are two different guarantees (a global preamble and a `preamble=`
 * directive naming the same file, an include policy someone loosens later), and a resolution that
 * read a file twice could see two different versions of it mid-edit and hash one while emitting the
 * other. Cheap insurance against a cache key that does not match its own text.
 */
function read(ctx: Ctx, canonical: string): Promise<string> {
	const pending = ctx.reads.get(canonical);
	if (pending !== undefined) return pending;
	// `ctx.source.read` may throw synchronously; wrapping keeps that on the promise, where the one
	// try/catch in `expand` already handles it.
	const started = (async () => ctx.source.read(canonical))();
	ctx.reads.set(canonical, started);
	return started;
}

/**
 * `%:input <path>` inside a preamble FILE, mirroring directives.ts line for line: case-folded, the
 * prefix must be followed by whitespace or end the line (so `%:inputs` stays a plain TeX comment),
 * and a quoted path keeps its trailing spaces.
 *
 * Deliberately re-implemented rather than shared with directives.ts, and not by accident of module
 * boundaries: what a preamble file may contain is a narrower language than what a block may. Only
 * `%:input` is honoured here. A `%!tikz width=…` line in an included file is left exactly as
 * written, because it is a TeX comment — a block option in a shared file would otherwise silently
 * re-scale every diagram that includes it.
 *
 * Returns null when the line is not a directive, and '' when it is one with no path.
 */
function inputPath(line: string): string | null {
	const trimmed = line.trimStart();
	if (trimmed.slice(0, INPUT_PREFIX.length).toLowerCase() !== INPUT_PREFIX) return null;
	const next = trimmed[INPUT_PREFIX.length];
	if (next !== undefined && next !== ' ' && next !== '\t' && next !== '\r') return null;
	const path = unquote(trimmed.slice(INPUT_PREFIX.length).trim());
	// `%:input ""` and `%:input "   "` are the no-path case, not a request for a file whose name is
	// three spaces. Everything else is returned exactly as quoted — that is the whole point of the
	// quotes, and `expand` will not trim it again.
	return path.trim() === '' ? '' : path;
}

function unquote(value: string): string {
	const first = value[0];
	if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
		return value.slice(1, -1);
	}
	return value;
}

// -------------------------------------------------------------------------------------------
// Diagnostics
//
// `line` is never set on any of these. Diagnostic.line is rendered by error-card.ts as an offset
// into the BLOCK's source, and every line number this module could produce is an offset into some
// other file — pointing the caret at an unrelated line of TikZ is worse than pointing at nothing.

const WHERE: Record<Origin, string> = {
	global: 'the global preamble setting',
	'walk-up': 'the auto-discovered preamble file',
	directive: 'a %!tikz preamble= directive',
	input: 'a %:input directive',
};

function notFound(path: string, origin: Origin, stack: readonly string[]): Diagnostic {
	const parent = stack[stack.length - 1];
	const from = parent === undefined ? '' : `, included from ${parent}`;
	return {
		kind: 'missing-file',
		message: `Preamble file not found: '${path}'${from}.`,
		hint: `${capitalize(WHERE[origin])} names a file this vault does not have. Paths are resolved the way a [[link]] is — relative to the file that wrote them, then by name — so check the spelling, or use the file's name if it is unique. Nothing was substituted for it: the macros it defines are missing, and TeX will report them as undefined control sequences.`,
	};
}

/**
 * The vault refused to say whether the path exists. Worded and classified as a missing file rather
 * than as an internal error, because that is what it is from where the user sits — the macros are
 * not there, and the next thing they see is an undefined control sequence. The thrown detail is
 * carried in the hint so a bug report has something in it.
 */
function unresolvable(path: string, origin: Origin, stack: readonly string[], error: unknown): Diagnostic {
	const detail = error instanceof Error ? error.message : String(error);
	const parent = stack[stack.length - 1];
	const from = parent === undefined ? '' : `, included from ${parent}`;
	return {
		kind: 'missing-file',
		message: `Preamble file could not be looked up: '${path}'${from}.`,
		hint: `${capitalize(WHERE[origin])} names a path the vault could not resolve (${detail}). Nothing was substituted for it. If the vault was still indexing, reopening the note is usually enough.`,
	};
}

function cycle(ring: readonly string[]): Diagnostic {
	return {
		kind: 'warning',
		message: `Circular %:input: ${ring.join(' → ')}. The repeat was skipped.`,
		hint: 'Each file is included once, so the preamble is complete — but the loop is almost certainly not what was intended. Break it by moving the shared definitions into a third file that both include.',
	};
}

function tooDeep(canonical: string, stack: readonly string[]): Diagnostic {
	return {
		kind: 'warning',
		message: `%:input nesting is deeper than ${MAX_INCLUDE_DEPTH} files; ${canonical} was not expanded.`,
		hint: `Included from ${stack.join(' → ')}. Anything that file defines is missing from the preamble. Flatten the chain: a preamble that is ${MAX_INCLUDE_DEPTH} includes deep is almost always a loop that this cap caught before the cycle detector could.`,
	};
}

function unreadable(canonical: string, error: unknown): Diagnostic {
	const detail = error instanceof Error ? error.message : String(error);
	return {
		kind: 'missing-file',
		message: `Preamble file could not be read: ${canonical}.`,
		hint: `The vault resolved the path but the read failed (${detail}). If the file was just renamed or deleted, reopen the note; otherwise check that it is a file rather than a folder.`,
	};
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const out: Diagnostic[] = [];
	for (const diagnostic of diagnostics) {
		if (seen.has(diagnostic.message)) continue;
		seen.add(diagnostic.message);
		out.push(diagnostic);
	}
	return out;
}
