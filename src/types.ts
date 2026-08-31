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
	 *  import window open — see docs/DESIGN.md §8.3. */
	border: string | null;
	packages: Record<string, string>;
	libraries: string;
	preamble: string;
	/** Sorted "path:hash" for every vault file read into the preamble. */
	depHashes: string[];
	wrap: 'auto' | 'always' | 'never';
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
	/** Preset: no SVGO, no mount-time measurement, no pre-flight lint, one priority band up. */
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
	line?: number | undefined;
}

export class TexError extends Error {
	constructor(
		readonly kind: TexErrorKind,
		readonly log: string[],
		readonly firstError?: string | undefined,
		readonly line?: number | undefined,
		message?: string,
	) {
		super(message ?? firstError ?? kind);
		this.name = 'TexError';
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
	render(job: TexJob, signal: AbortSignal): Promise<TexResult>;
	dispose(): void;
}

// -------------------------------------------------------------------------------------------
// Diagnostics

export interface Diagnostic {
	kind: TexErrorKind | 'warning';
	message: string;
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
