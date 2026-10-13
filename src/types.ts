/**
 * Shared contracts.
 *
 * Everything here is plain data or a pure interface. Nothing in this file imports `obsidian`, and
 * neither does anything that only depends on it — which is what lets the bulk of the plugin be
 * unit-tested in Node with no DOM. The Obsidian-facing adapters live in src/platform/.
 */

import type { RenderOptions, TexErrorKind } from '../engine-src/protocol';

export type { RenderOptions, TexErrorKind };

// -------------------------------------------------------------------------------------------
// Per-block options

export type ColorMode = 'adapt' | 'preserve' | 'paper' | 'invert';
export type LazyMode = 'on' | 'off' | 'manual';
export type SvgoMode = 'preset' | 'targeted' | 'off';

/**
 * Options that change the STORED BYTES. Anything here participates in the cache key; anything in
 * `Presentation` deliberately does not, so switching theme or resizing a diagram costs zero
 * recompiles.
 */
export interface BakedOptions {
	/** TeX-side margin. `null` means "inject nothing", which is what keeps the legacy-cache
	 *  import window open — see internal/DESIGN.md §8.3. */
	border: string | null;
	packages: Record<string, string>;
	libraries: string;
	preamble: string;
	/** Sorted "path:hash" for every vault file read into the preamble. */
	depHashes: string[];
	wrap: 'auto' | 'always' | 'never';
	/**
	 * Run TeX twice, so cross-references resolve. Baked, not presentation: the second pass changes
	 * the bytes, so a block toggled between the two must not serve the other's artifact.
	 *
	 * It does NOT fix \chemmove or \polymerdelim (upstream #9, #70), measured rather than assumed:
	 * this build's driver reports "does not support marking the current position", so the .aux comes
	 * back holding 32 bytes and a second pass is handed nothing new.
	 */
	twoPass: boolean;
}

/** Options applied at mount time. Never in the cache key. */
export interface Presentation {
	width?: string | undefined;
	maxWidth?: string | undefined;
	scale?: number | undefined;
	align?: 'left' | 'center' | 'right' | undefined;
	alt?: string | undefined;
	colors?: ColorMode | undefined;
	lazy?: LazyMode | undefined;
	timeoutMs?: number | undefined;
}

export interface BlockOptions {
	baked: BakedOptions;
	presentation: Presentation;
	/** Escape hatch: run only the mandatory pipeline stages. */
	raw: boolean;
	/** Skip the cache entirely, in both directions. */
	nocache: boolean;
	/**
	 * Preset: no SVG optimisation, no pre-flight lint, one priority band up.
	 *
	 * NOT "no mount-time measurement", which §7.11 also lists. The engine's frame is an inch short
	 * of the drawing (svg/geometry.ts), so a fast diagram mounted without it would lose its right
	 * and bottom edges, for the price of one layout per new diagram.
	 */
	fast: boolean;
	/** Directives that parsed but were not recognised, surfaced as a warning rather than ignored. */
	warnings: string[];
}

// -------------------------------------------------------------------------------------------
// Cache

/**
 * A rendered diagram as stored.
 *
 * `template` is theme-neutral and carries `__TZ__n` id placeholders; a mount stamps a per-instance
 * nonce over them. Storing the post-processed artifact rather than the raw SVG is what makes a
 * cache hit a Map.get plus one string replace, and it is what today's plugin gets wrong — it
 * caches the pre-post-process SVG and re-pays SVGO on every hit.
 */
export interface Artifact {
	v: number;
	template: string;
	w: number;
	h: number;
	/** Ink-bounds-corrected viewBox. `null` until a mount has measured it with fonts loaded. */
	viewBox: string | null;
	fonts: string[];
	bytes: number;
	engineId: string;
	origin: 'render' | 'legacy-import';
	createdAt: number;
	lastUsed: number;
	/** Set when the pipeline degraded, or when TeX recovered from an error. */
	warn?: string | undefined;
}

export interface KeyInputs {
	normalizedSource: string;
	baked: BakedOptions;
	engineId: string;
	/** Enumerated in settings/schema.ts. Excludes theme, scale, alignment, timeouts. */
	artifactRevision: string;
	/**
	 * Per-block flags that change the STORED artifact rather than how it is displayed.
	 *
	 * `artifactRevision` covers the same ground for the GLOBAL settings, but `raw` and `fast` can
	 * also be set per block via `%!tikz`, and neither reaches the key through `baked` — they change
	 * the pipeline, not the TeX. Without them here, a block toggled to `fast` collides with its own
	 * full-quality artifact and serves whichever was stored first. Found in review.
	 *
	 * Intended: a fast artifact and a full artifact are different keys and coexist, so switching
	 * back and forth costs no recompile in either direction.
	 */
	pipeline: { raw: boolean; fast: boolean; svgo: SvgoMode };
}

// -------------------------------------------------------------------------------------------
// Engine

export interface TexJob {
	key: string;
	source: string;
	options: RenderOptions;
	timeoutMs: number;
}

export interface TexResult {
	svg: string;
	log: string[];
	durationMs: number;
	/** TeX recovered but complained. The diagram mounts with a warning rather than an error. */
	firstError?: string | undefined;
	/**
	 * The line TeX blamed, as a line of the BLOCK, from 1, the way pre-flight numbers them. Lines
	 * above the block are 0, -1, … and are in the preamble; see engine/worker-host.ts `blockLine`.
	 */
	line?: number | undefined;
}

export class TexError extends Error {
	// Explicit fields rather than constructor parameter properties: `erasableSyntaxOnly` forbids
	// those, being the one piece of TypeScript class syntax that emits runtime code instead of
	// being erased.
	readonly kind: TexErrorKind;
	readonly log: string[];
	readonly firstError: string | undefined;
	/** A line of the block, as `TexResult.line` is. */
	readonly line: number | undefined;

	constructor(kind: TexErrorKind, log: string[], firstError?: string, line?: number, message?: string) {
		super(message ?? firstError ?? kind);
		this.name = 'TexError';
		this.kind = kind;
		this.log = log;
		this.firstError = firstError;
		this.line = line;
	}
}

/**
 * The engine was stopped while this job was in it, for a reason that is not the job's: the app was
 * backgrounded, the engine was restarted, or the plugin is unloading.
 *
 * Deliberately not a TexError. Every TexError ends on an error card, and this must not: the
 * diagram did nothing wrong, so its block goes back to be scheduled again (`interrupted` in
 * block/machine.ts). It used to arrive as TexError('timeout'), and switching apps on iOS while a
 * diagram compiled left a card saying it took longer than its time budget.
 */
export class InterruptedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'InterruptedError';
	}
}

export interface EngineCapabilities {
	expl3: boolean;
	twoPass: boolean;
	packages: Record<string, string>;
	files: ReadonlySet<string>;
}

/**
 * The seam that makes swapping engines a swap rather than a rewrite. `id` flows into the cache
 * key, so two engines can coexist and switching invalidates exactly the affected diagrams.
 */
export interface TexHost {
	readonly id: string;
	readonly capabilities: EngineCapabilities;
	ready(): Promise<void>;
	/**
	 * `onRunning` is called when the engine actually starts this job — after any boot, and after
	 * any job ahead of it — which is when the job's own time budget should start. Aborting
	 * `signal` abandons the job; a job abandoned mid-run takes its engine with it, because a TeX
	 * run cannot be interrupted and nothing else could run behind it.
	 */
	render(job: TexJob, signal: AbortSignal, onRunning?: () => void): Promise<TexResult>;
	dispose(): void;
}

// -------------------------------------------------------------------------------------------
// Diagnostics

export interface Diagnostic {
	kind: TexErrorKind | 'warning';
	message: string;
	/** A line of the block, from 1; below 1, a line of the preamble before it (block/error-card.ts). */
	line?: number | undefined;
	/** Actionable next step, derived from the engine inventory rather than guessed. */
	hint?: string | undefined;
}

// -------------------------------------------------------------------------------------------
// Budgets

export interface Budgets {
	concurrency: number;
	timeoutMs: number;
	firstJobGraceMs: number;
	exportBlockTimeoutMs: number;
	exportTotalBudgetMs: number;
	queueDepthCap: number;
	rootMarginPx: number;
	zeroRecordEscapeMs: number;
	debounceMs: number;
	l1Entries: number;
	l1Bytes: number;
	l2Bytes: number;
	idleTeardownMs: number;
}
