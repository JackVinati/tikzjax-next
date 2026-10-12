import { MarkdownRenderChild } from 'obsidian';
import type { Artifact, BlockOptions, Diagnostic, SvgoMode, TexHost, TexResult } from '../types';
import { InterruptedError, TexError } from '../types';
import {
	initialState,
	reduce,
	type Effect,
	type Event,
	type FailureReason,
	type Priority,
	type State,
} from './machine';
import { renderPlaceholder, renderManualTrigger } from './placeholder';
import { renderErrorCard, renderWarningChip } from './error-card';
import { applyBounds, applyScale, measureInk, mountArtifact, withMeasuredBounds } from './mount';
import type { DiagramCache } from '../cache';
import type { RenderQueue } from '../queue/queue';
import { isQueueError } from '../queue/queue';
import { parseSvg, serializeSvg } from '../svg/serialize';
import { runPipeline } from '../svg/pipeline';
import { buildStages } from '../svg/stages';
import { optimizeString, type SvgoLike } from '../svg/optimize';
import { explain } from '../engine/hints';
import type { PreambleLine } from '../preamble/resolve';
import { STRINGS } from '../ui/strings';

/** How many of the sanitizer's removals a chip names before it only counts the rest. */
const SANITIZED_NAMED = 3;

/**
 * One block, from fence to pixels. See internal/DESIGN.md §3.3.
 *
 * The machine in `./machine.ts` decides WHAT happens; this class does it. Keeping the decision
 * pure is what makes the lifecycle exhaustively testable in Node, and it is why the single most
 * important guarantee in the plugin — exactly one `settle` per block — is a property test rather
 * than a hope. A processor promise that never settles strands the reading view's section list
 * forever; one that settles twice is a bug that hides for months.
 */

export interface TexJobSpec {
	key: string;
	source: string;
	options: BlockOptions;
	/** The optimisation the block asked for: its `%!tikz svgo=`, else the setting. In the key too. */
	svgo: SvgoMode;
	texOptions: {
		texPackages?: Record<string, string>;
		tikzLibraries?: string;
		addToPreamble?: string;
		wrap?: 'auto' | 'always' | 'never';
		captureLog?: boolean;
	};
	/**
	 * Where each line of the preamble files in `texOptions.addToPreamble` was written, so an error
	 * TeX meets there is shown from the file it is in (block/error-card.ts). Empty without one.
	 */
	preambleLines: readonly PreambleLine[];
	/** The source as the OLD plugin would have hashed it, for the L3 read-through. Null disables it. */
	legacySource: string | null;
	timeoutMs: number;
	isExport: boolean;
	/**
	 * Not subject to the queue's depth cap: a block of a PDF export, or of "Render all diagrams in
	 * this note". Past the cap a block rests on a "Render diagram" button, which is what the PDF
	 * printed and what the command left behind. Narrower than `isExport`, which fails open and so
	 * also takes in a pop-out window's blocks — and those only the cap bounds.
	 */
	uncapped: boolean;
	preflight: Diagnostic[];
}

/**
 * How a block came to rest, for the diagnostics view and for "Render all diagrams in this note".
 *
 * Reported each time the block comes to rest, so a Retry that mounts is reported again. Both used
 * to read the one record written when the block was processed, before anything had happened to it:
 * the view showed every block as "rendering" for good, and the command counted no failures.
 */
export interface BlockOutcome {
	/**
	 * `ok` compiled and mounted · `cached` mounted from a cache tier · `error` an error card ·
	 * `manual` a "Render diagram" button · `cancelled` unloaded before it came to rest at all.
	 */
	state: 'ok' | 'cached' | 'error' | 'manual' | 'cancelled';
	tier?: 'l1' | 'l2' | 'l3' | undefined;
	/** How long TeX ran, for a diagram compiled this time. */
	durationMs?: number | undefined;
	/** What the error card says. */
	message?: string | undefined;
	log?: string[] | undefined;
}

export interface BlockDeps {
	cache: DiagramCache;
	queue: RenderQueue<TexJobSpec, TexResult>;
	host: TexHost;
	svgo: SvgoLike | null;
	/** `escaped`: no record ever came and the gate gave up waiting (block/viewport.ts). */
	observe: (el: HTMLElement, onChange: (visible: boolean, escaped?: boolean) => void) => void;
	unobserve: (el: HTMLElement) => void;
	ensureFonts: (doc: Document) => void;
	debounceMs: number;
	now: () => number;
	report?: ((outcome: BlockOutcome) => void) | undefined;
}

export class TikzBlock extends MarkdownRenderChild {
	private state: State = initialState();
	private readonly spec: TexJobSpec;
	private readonly deps: BlockDeps;

	private readonly settledPromise: Promise<void>;
	private resolveSettled!: () => void;

	private artifact: Artifact | null = null;
	private failure: TexError | null = null;
	private visible = false;
	private debounceTimer: number | null = null;
	private placeholder: HTMLElement | null = null;
	private body: HTMLElement;

	/** Where the artifact on screen came from: a cache tier, or a compile and how long TeX took. */
	private origin: { tier: 'l1' | 'l2' | 'l3' } | { durationMs: number } | null = null;
	/** What the error card on screen says, for the report. */
	private cardMessage = '';
	/** Has come to rest at least once, so an unload afterwards is not a cancellation. */
	private rested = false;

	constructor(containerEl: HTMLElement, spec: TexJobSpec, deps: BlockDeps) {
		super(containerEl);
		this.spec = spec;
		this.deps = deps;
		this.body = containerEl;
		this.settledPromise = new Promise<void>((resolve) => {
			this.resolveSettled = resolve;
		});
	}

	/**
	 * What the code-block processor returns to Obsidian.
	 *
	 * It must NEVER reject. In reading mode `Promise.all(asyncSections)` has no `.catch`, so a
	 * rejection strands the section and it is never re-measured; in export it throws out of
	 * `printToPdf`. Every failure path here resolves — the error goes into the DOM, not the promise.
	 */
	get settled(): Promise<void> {
		return this.settledPromise;
	}

	override onload(): void {
		this.dispatch({ type: 'load' });
	}

	override onunload(): void {
		this.dispatch({ type: 'unload' });
	}

	/**
	 * The PDF export this block is part of has spent its total budget: stop waiting, and rest on a
	 * card. Does nothing to a block that is already at rest. Called by the processor, which is
	 * what knows which blocks make up one export.
	 */
	expire(): void {
		this.dispatch({ type: 'expired' });
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * Events are queued, never interleaved.
	 *
	 * An effect handler is allowed to dispatch — `addClasses` decides the block is empty, or probes
	 * L1 and finds it — but the events it raises MUST NOT run before the rest of the batch that
	 * produced them. Running them inline reorders the DOM against the machine's intent: `load`
	 * emits `[addClasses, paintPlaceholder]`, so an L1 hit dispatched from inside `addClasses`
	 * mounted the diagram and then the loop carried on and painted a spinner underneath it, which
	 * nothing would ever remove. Every reopened note with a cached diagram grew a spinner.
	 *
	 * The machine cannot prevent this — it is pure and correct — so the invariant belongs here:
	 * one batch of effects runs to completion before the next event is reduced.
	 */
	private dispatching = false;
	private readonly queued: Event[] = [];

	private dispatch(event: Event): void {
		this.queued.push(event);
		if (this.dispatching) return;

		this.dispatching = true;
		try {
			for (let next = this.queued.shift(); next !== undefined; next = this.queued.shift()) {
				const before = this.state.phase;
				const [state, effects] = reduce(this.state, next);
				this.state = state;
				for (const effect of effects) this.run(effect);
				// After the effects, so what is reported is what the batch put on screen.
				if (state.phase !== before) this.reportRest();
			}
		} finally {
			this.dispatching = false;
			this.queued.length = 0;
		}
	}

	private run(effect: Effect): void {
		switch (effect.kind) {
			case 'addClasses':
				this.body.addClass('tikzjax-figure');
				this.body = this.body.createDiv({ cls: 'tikzjax-figure-wrapper' });
				this.beginKeying();
				return;

			case 'paintPlaceholder':
				// Defence in depth against the reordering the dispatch queue now prevents: a
				// placeholder painted after the diagram is already up is a spinner nobody removes.
				if (this.body.querySelector('svg') || this.placeholder) return;
				// The wrapper shows one thing at a time. On a Retry or a "Render diagram" press it
				// still holds the card or the button, and those give way to the spinner.
				this.body.empty();
				this.placeholder = renderPlaceholder(this.body, this.deps.cache.peekSize(this.spec.key));
				return;

			case 'lookup':
				void this.lookup();
				return;

			case 'promote':
				// The lookup already wrote it to L1; nothing further to do here.
				return;

			case 'transform':
				this.transform(effect.origin);
				return;

			case 'persist':
				if (this.artifact && !this.spec.options.nocache) {
					this.deps.cache.put(this.spec.key, this.artifact);
				}
				return;

			case 'observe':
				this.deps.observe(this.body, (visible, escaped) => {
					// The gate gave up waiting for a record: the lowest band, no debounce. Taken for
					// plain visibility, it went in with the diagrams the reader was looking at.
					if (escaped) {
						this.dispatch({ type: 'noRecordsAfter2s' });
						return;
					}
					this.visible = visible;
					if (visible) this.dispatch({ type: 'intersect' });
				});
				return;

			case 'unobserve':
				this.deps.unobserve(this.body);
				return;

			case 'startDebounce':
				this.clearDebounce();
				this.debounceTimer = window.setTimeout(() => {
					this.debounceTimer = null;
					this.dispatch({ type: 'timer', priority: this.priority() });
				}, this.deps.debounceMs);
				return;

			case 'clearTimers':
				this.clearDebounce();
				return;

			case 'submit':
				// A new attempt: whatever failed last time is not what this one will say.
				this.failure = null;
				this.origin = null;
				void this.submit(effect.priority);
				return;

			case 'release':
				this.deps.queue.release(this.spec.key, this);
				return;

			case 'unpoison':
				// The user pressed Retry. A timeout poisons the key for the session; this was listed
				// below as "owned by the queue" and did nothing, so the queue refused the key again
				// at the door and Retry never re-ran anything.
				this.deps.queue.clearPoison(this.spec.key);
				return;

			case 'startRender':
			case 'abort':
			case 'terminateWorker':
			case 'poison':
				// Owned by the queue and the host: they hold the AbortController, the poison set and
				// the worker. Listed explicitly so a new effect cannot be silently ignored by a
				// default branch.
				return;

			case 'mount':
				// Degraded or not, the artifact has passed sanitize and ids, and its warning — the
				// only difference on screen — travels with it.
				this.mount();
				return;

			case 'measure':
				void this.measure(effect.persist);
				return;

			case 'mountErrorCard':
				this.mountError(effect.reason);
				return;

			case 'mountManualButton':
				this.placeholder = null;
				this.body.empty();
				renderManualTrigger(this.body, () => this.dispatch({ type: 'retry' }), STRINGS.renderDiagram);
				return;

			case 'settle':
				this.resolveSettled();
				return;
		}
	}

	// -------------------------------------------------------------------------------------------

	private beginKeying(): void {
		if (!this.spec.source.trim()) {
			this.dispatch({ type: 'emptySource' });
			return;
		}
		// A pre-flight ERROR blocks; pre-flight warnings never do — the file list is an inventory of
		// what the VFS can serve, not a proof of what TeX will need, and a lint that refused to
		// compile would turn a warning into the blank diagram this plugin exists to eliminate.
		const blocking = this.spec.preflight.find((d) => d.kind !== 'warning');
		if (blocking) {
			this.failure = new TexError('tex-error', [], blocking.message, blocking.line, blocking.message);
			this.dispatch({ type: 'preflightError' });
			return;
		}

		const hot = this.spec.options.nocache ? undefined : this.deps.cache.peek(this.spec.key);
		if (hot) {
			this.artifact = hot;
			this.origin = { tier: 'l1' };
			this.dispatch({ type: 'l1Hit' });
			return;
		}
		this.dispatch({ type: 'l1Miss' });
	}

	private async lookup(): Promise<void> {
		let found: Awaited<ReturnType<DiagramCache['lookup']>>;
		try {
			found = this.spec.options.nocache
				? undefined
				: await this.deps.cache.lookup(this.spec.key, this.spec.legacySource);
		} catch {
			found = undefined;
		}
		if (this.state.phase === 'DISPOSED') return;

		if (found) {
			this.artifact = found.artifact;
			this.origin = { tier: found.tier };
			this.dispatch({ type: 'hit', tier: found.tier === 'l1' ? 'l2' : found.tier });
			return;
		}

		this.dispatch({
			type: 'miss',
			isExport: this.spec.isExport,
			lazy: this.spec.options.presentation.lazy ?? 'on',
		});
	}

	private async submit(priority: Priority): Promise<void> {
		// Fast mode is a preset, and one band up is part of it (internal/DESIGN.md §7.11): a fast
		// diagram is the cheapest work in the queue, so it goes ahead of the full renders around it.
		// Here rather than in the machine, which decides the band from where the block is and
		// would otherwise have to know about fast mode at every one of its submits.
		const band = this.spec.options.fast && priority > 0 ? ((priority - 1) as Priority) : priority;
		try {
			const result = await this.deps.queue.submit(this.spec.key, this.spec, band, this.spec.timeoutMs, {
				owner: this,
				// `slot` is what leaves SCHEDULING, and it must NOT be guessed at submit time: the
				// queue settles three of its four ways before the job starts (depth-cap, poisoned,
				// cancelled), and those arrive as `rejected`, which SCHEDULING handles and
				// COMPILING does not. So the queue says when — to this block, not to whichever
				// block submitted the key first.
				onStart: () => this.dispatch({ type: 'slot' }),
				...(this.spec.isExport ? { ignorePoison: true } : {}),
				...(this.spec.uncapped ? { uncapped: true } : {}),
			});

			// The RAW engine output, not a finished artifact: the pipeline is a separate phase, and
			// running it here would put the sanitize stage inside the queue's slot.
			this.artifact = {
				v: 1,
				template: result.svg,
				w: 0,
				h: 0,
				viewBox: null,
				fonts: [],
				bytes: result.svg.length,
				engineId: this.deps.host.id,
				origin: 'render',
				createdAt: this.deps.now(),
				lastUsed: this.deps.now(),
				// TeX recovered but complained. Only possible because the worker injects
				// nonstopmode, and exactly the case a user cannot diagnose alone: a diagram that
				// renders with a piece quietly missing.
				...(result.firstError ? { warn: STRINGS.warnRecovered(result.firstError) } : {}),
			};
			this.origin = { durationMs: result.durationMs };
			this.dispatch({ type: 'ok' });
		} catch (error) {
			if (this.state.phase === 'DISPOSED') return;

			// Not this diagram's doing: the engine was stopped under it. Back in line, no card.
			if (error instanceof InterruptedError) {
				this.dispatch({ type: 'interrupted' });
				return;
			}

			// Of the queue's own refusals, `timeout` and `stalled` happen after the job has started.
			// The other three are PRE-START, which the machine has a distinct event for — without it
			// an over-cap note leaves every evicted block in SCHEDULING forever.
			if (isQueueError(error, 'depth-cap') || isQueueError(error, 'cancelled')) {
				this.dispatch({ type: 'rejected', reason: 'depthCap' });
				return;
			}
			if (isQueueError(error, 'poisoned')) {
				this.dispatch({ type: 'rejected', reason: 'poisoned' });
				return;
			}
			if (isQueueError(error, 'timeout')) {
				this.failure = new TexError('timeout', []);
				this.dispatch({ type: 'timeout' });
				return;
			}
			if (isQueueError(error, 'stalled')) {
				// The engine never came up to take the job. That is what the card says; it is not a
				// timeout, and the diagram is not poisoned for it.
				this.failure = new TexError('engine-unavailable', [], undefined, undefined, error.message);
				this.dispatch({ type: 'err', reason: 'engine-unavailable' });
				return;
			}

			this.failure = error instanceof TexError ? error : new TexError('tex-error', [], String(error));
			// Valid in SCHEDULING too: a job can fail without this block ever hearing that it
			// started — the queue failed for a reason of its own — and the machine takes any
			// settlement as the end of the wait.
			this.dispatch({ type: 'err', reason: this.failure.kind });
		}
	}

	/**
	 * The pipeline. Runs OFF-DOCUMENT, before anything is inserted.
	 *
	 * That ordering is what makes the whole "post-processing did not run" family (#15 #87 #93 #102)
	 * structurally impossible rather than merely fixed: there is no bubbling completion event to
	 * miss and no detached-node race to lose, because the artifact is finished before it exists in
	 * the page.
	 */
	private transform(origin: 'l3' | 'render'): void {
		const raw = this.artifact?.template;
		if (raw === undefined) {
			this.failure = new TexError(
				'empty-output',
				[],
				undefined,
				undefined,
				'there was no output to prepare',
			);
			this.dispatch({ type: 'stageThrew' });
			return;
		}

		try {
			let markup = raw;

			// What the block asked for, and fast mode switches all of it off. The setting and the
			// directive used to reach the cache key and nothing else — this asked only whether the
			// block was fast — so `%!tikz svgo=off` recompiled a diagram and changed nothing in it.
			//
			// `preset` is SVGO's preset and then the targeted transform. SVGO is not bundled (see
			// main.ts), so today `preset` is the targeted transform alone, as it always has been.
			const mode: SvgoMode = this.spec.options.fast ? 'off' : this.spec.svgo;

			// SVGO works on a string, not a document, so it wraps the DOM stages rather than being
			// one of them.
			if (mode === 'preset' && this.deps.svgo) {
				try {
					markup = optimizeString(this.deps.svgo, markup);
				} catch {
					// A failed optimisation is not a failed render. The shipped plugin reads `.data`
					// off SVGO's error shape behind a @ts-ignore and writes the string "undefined"
					// into the note.
				}
			}

			const doc = parseSvg(markup);
			// No colour mode: every mode mounts the same stored artifact (svg/colors.ts), and a mode
			// handed in here would be one block's, stored and served to every other.
			const result = runPipeline(doc, buildStages({ optimize: mode === 'off' ? 'off' : 'targeted' }), {
				raw: this.spec.options.raw,
			});

			const template = serializeSvg(result.doc);
			const previous = this.artifact;
			// What TeX said when it recovered from an error, what the sanitizer took out, then what
			// the pipeline skipped. The first used to be dropped right here, so a diagram with a
			// piece quietly missing showed nothing at all about it, and the second was never shown.
			const warnings = previous?.warn ? [previous.warn] : [];
			if (result.notes.length > 0) {
				const named = result.notes.slice(0, SANITIZED_NAMED);
				warnings.push(STRINGS.warnSanitized(named.join(', '), result.notes.length - named.length));
			}
			warnings.push(...result.warnings);
			this.artifact = {
				v: 1,
				template,
				w: previous?.w ?? 0,
				h: previous?.h ?? 0,
				viewBox: origin === 'l3' ? null : (previous?.viewBox ?? null),
				fonts: previous?.fonts ?? [],
				bytes: template.length,
				engineId: this.deps.host.id,
				origin: origin === 'l3' ? 'legacy-import' : 'render',
				createdAt: previous?.createdAt ?? this.deps.now(),
				lastUsed: this.deps.now(),
				...(warnings.length ? { warn: warnings.join('; ') } : {}),
			};

			this.dispatch({ type: result.degraded ? 'degraded' : 'ok' });
		} catch (error) {
			// Nothing came out that passed sanitize and ids. The raw engine output is dropped here
			// rather than left lying in `artifact`, where a mount or a measurement could reach it:
			// that is how it used to be shown, and cached, past the sanitizer.
			this.artifact = null;
			this.failure =
				error instanceof TexError
					? error
					: new TexError('empty-output', [], undefined, undefined, String(error));
			this.dispatch({ type: 'stageThrew' });
		}
	}

	private mount(): void {
		if (this.state.unloaded || !this.artifact) return;

		this.deps.ensureFonts(this.body.doc);
		// Replaces whatever the wrapper held — the spinner, and before this, on a Retry or a
		// "Render diagram" press, the card or the button, which stayed up under the diagram.
		this.placeholder = null;
		this.body.empty();

		const mounted = mountArtifact(this.body, this.artifact, this.spec.options.presentation);
		if (!mounted) {
			this.failure = new TexError('empty-output', []);
			this.dispatch({ type: 'err', reason: 'empty-output' });
			return;
		}

		// Whenever there is one, and not only for a degraded mount: what TeX reported while it
		// recovered is stored with the artifact, and is just as true on a cache hit.
		if (this.artifact.warn) renderWarningChip(this.body, this.artifact.warn);
		for (const warning of this.spec.preflight) {
			if (warning.kind === 'warning') renderWarningChip(this.body, warning.message);
		}

		this.dispatch({ type: 'mounted' });
	}

	/** `persist` is the machine's call: false for a degraded mount, which must never be cached. */
	private async measure(persist: boolean): Promise<void> {
		const svg = this.body.querySelector('svg');
		if (!svg || !this.artifact || this.artifact.viewBox !== null) return;

		const bounds = await measureInk(svg, this.body.doc);
		if (!bounds || this.state.phase === 'DISPOSED' || !this.artifact) return;

		this.artifact = withMeasuredBounds(this.artifact, bounds);
		// Exactly what every later mount of this artifact will do, so the first one matches them —
		// and the scale, which had no width to work from until now, is applied from the real one.
		applyBounds(svg, this.artifact.viewBox);
		applyScale(this.body, svg, this.spec.options.presentation, this.artifact);
		if (persist && !this.spec.options.nocache) this.deps.cache.put(this.spec.key, this.artifact);
	}

	private mountError(reason: FailureReason): void {
		this.placeholder?.remove();
		this.placeholder = null;

		const failure = this.failure ?? new TexError('empty-output', []);
		const diagnostic = explain(
			{
				// The failures the plugin finds itself have no TexError kind of their own, and
				// falling back to `empty-output` told the user TeX had run and drawn nothing.
				kind:
					reason === 'poisoned' ||
					reason === 'empty-source' ||
					reason === 'pipeline' ||
					reason === 'export-budget'
						? reason
						: failure.kind,
				message: failure.message,
				firstError: failure.firstError,
				line: failure.line,
				// The worker's message for a TeX error is the bare `!` line: the macro it choked
				// on is only in the log, and without it the card said TeX had not echoed one.
				log: failure.log,
			},
			this.deps.host.capabilities,
		);
		this.cardMessage = diagnostic.message;
		renderErrorCard(this.body, {
			diagnostic,
			source: this.spec.source,
			preamble: { text: this.spec.options.baked.preamble, lines: this.spec.preambleLines },
			log: failure.log,
			onRetry: () => this.dispatch({ type: 'retry' }),
		});
	}

	/** Tell whoever is listening how the block came to rest, now that it has. */
	private reportRest(): void {
		const report = this.deps.report;
		const phase = this.state.phase;
		let outcome: BlockOutcome | null = null;

		if (phase === 'MOUNTED' || phase === 'MOUNTED_DEGRADED') {
			const origin = this.origin;
			outcome =
				origin && 'tier' in origin
					? { state: 'cached', tier: origin.tier }
					: { state: 'ok', ...(origin ? { durationMs: origin.durationMs } : {}) };
		} else if (phase === 'FAILED') {
			const log = this.failure?.log ?? [];
			outcome = { state: 'error', message: this.cardMessage, ...(log.length ? { log } : {}) };
		} else if (phase === 'IDLE_MANUAL') {
			outcome = { state: 'manual' };
		} else if (phase === 'DISPOSED' && !this.rested) {
			outcome = { state: 'cancelled' };
		}

		if (outcome === null) return;
		this.rested = true;
		report?.(outcome);
	}

	// -------------------------------------------------------------------------------------------

	private priority(): Priority {
		if (this.spec.isExport) return 0;
		return this.visible ? 1 : 2;
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}
