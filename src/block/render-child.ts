import { MarkdownRenderChild } from 'obsidian';
import type { Artifact, BlockOptions, Diagnostic, TexHost, TexResult } from '../types';
import { TexError } from '../types';
import { initialState, reduce, type Effect, type Event, type Priority, type State } from './machine';
import { renderPlaceholder, renderManualTrigger } from './placeholder';
import { renderErrorCard, renderWarningChip } from './error-card';
import { measureInk, mountArtifact, withMeasuredBounds } from './mount';
import type { DiagramCache } from '../cache';
import type { RenderQueue } from '../queue/queue';
import { isQueueError } from '../queue/queue';
import { parseSvg, serializeSvg } from '../svg/serialize';
import { runPipeline } from '../svg/pipeline';
import { buildStages } from '../svg/stages';
import { optimizeString, type SvgoLike } from '../svg/optimize';
import { explain } from '../engine/hints';
import { STRINGS } from '../ui/strings';

/**
 * One block, from fence to pixels. See docs/DESIGN.md §3.3.
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
	/**
	 * The block exactly as written, directives and all.
	 *
	 * The commands find a diagram by scanning the note's markdown, which gives them this — not the
	 * normalized, directive-stripped source. Carrying it means "which cache key is this block?" is
	 * a lookup rather than a second, drifting copy of the key derivation.
	 */
	rawSource: string;
	options: BlockOptions;
	texOptions: {
		texPackages?: Record<string, string>;
		tikzLibraries?: string;
		addToPreamble?: string;
		wrap?: 'auto' | 'always' | 'never';
		captureLog?: boolean;
	};
	/** The source as the OLD plugin would have hashed it, for the L3 read-through. Null disables it. */
	legacySource: string | null;
	timeoutMs: number;
	isExport: boolean;
	preflight: Diagnostic[];
	/**
	 * Called by the queue's runner the moment this job actually starts.
	 *
	 * The machine needs `slot` to leave SCHEDULING, and it must NOT be emitted at submit time:
	 * the queue settles three of its four ways before `run` is ever called (depth-cap, poisoned,
	 * cancelled), and those arrive as `rejected`, which SCHEDULING handles and COMPILING does not.
	 * Guessing the start would send a pre-start rejection to a state with no route out of it —
	 * the never-settling class again.
	 */
	onStart?: (() => void) | undefined;
}

export interface BlockDeps {
	cache: DiagramCache;
	queue: RenderQueue<TexJobSpec, TexResult>;
	host: TexHost;
	svgo: SvgoLike | null;
	observe: (el: HTMLElement, onChange: (visible: boolean) => void) => void;
	unobserve: (el: HTMLElement) => void;
	ensureFonts: (doc: Document) => void;
	debounceMs: number;
	now: () => number;
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
				const [state, effects] = reduce(this.state, next);
				this.state = state;
				for (const effect of effects) this.run(effect);
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
				this.deps.observe(this.body, (visible) => {
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
				void this.submit(effect.priority);
				return;

			case 'release':
				this.deps.queue.release(this.spec.key, this);
				return;

			case 'startRender':
			case 'abort':
			case 'terminateWorker':
			case 'poison':
			case 'unpoison':
				// Owned by the queue: it holds the AbortController, the poison set and the host.
				// Listed explicitly so a new effect cannot be silently ignored by a default branch.
				return;

			case 'mount':
				this.mount(effect.degraded);
				return;

			case 'measure':
				void this.measure();
				return;

			case 'mountErrorCard':
				this.mountError();
				return;

			case 'mountManualButton':
				this.placeholder?.remove();
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
		this.spec.onStart = () => this.dispatch({ type: 'slot' });
		try {
			const result = await this.deps.queue.submit(
				this.spec.key,
				this.spec,
				priority,
				this.spec.timeoutMs,
				{ owner: this, ...(this.spec.isExport ? { ignorePoison: true } : {}) },
			);

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
			this.dispatch({ type: 'ok' });
		} catch (error) {
			if (this.state.phase === 'DISPOSED') return;

			// The queue settles submit() four ways and only `timeout` happens after the job has
			// started. The other three are PRE-START, which the machine has a distinct event for —
			// without it an over-cap note leaves every evicted block in SCHEDULING forever.
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

			this.failure = error instanceof TexError ? error : new TexError('tex-error', [], String(error));

			// `err` is a COMPILING event. If the job never started — the runner threw before
			// calling onStart, or the queue failed for a reason of its own — we are still in
			// SCHEDULING, where `err` is a no-op and the block would sit unsettled forever.
			// Route it through `rejected`, which SCHEDULING does handle. Found by a test that
			// stubbed a queue rejecting without ever starting the job.
			if (this.state.phase === 'SCHEDULING') {
				this.dispatch({ type: 'rejected', reason: this.failure.kind });
				return;
			}
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
			this.dispatch({ type: 'stageThrew' });
			return;
		}

		try {
			let markup = raw;

			// SVGO works on a string, not a document, so it wraps the DOM stages rather than being
			// one of them.
			const mode = this.spec.options.fast ? 'off' : 'preset';
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
			const result = runPipeline(doc, buildStages({
				colors: this.spec.options.presentation.colors ?? 'adapt',
				optimize: this.spec.options.fast ? 'off' : 'targeted',
			}), { raw: this.spec.options.raw });

			const template = serializeSvg(result.doc);
			const previous = this.artifact;
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
				...(result.warnings.length ? { warn: result.warnings.join('; ') } : {}),
			};

			this.dispatch({ type: 'ok' });
		} catch (error) {
			this.failure = error instanceof TexError ? error : new TexError('empty-output', [], String(error));
			this.dispatch({ type: 'stageThrew' });
		}
	}

	private mount(degraded: boolean): void {
		if (this.state.unloaded || !this.artifact) return;

		this.deps.ensureFonts(this.body.doc);
		this.placeholder?.remove();
		this.placeholder = null;

		const mounted = mountArtifact(this.body, this.artifact, this.spec.options.presentation);
		if (!mounted) {
			this.failure = new TexError('empty-output', []);
			this.dispatch({ type: 'err', reason: 'empty-output' });
			return;
		}

		if (degraded && this.artifact.warn) renderWarningChip(this.body, this.artifact.warn);
		for (const warning of this.spec.preflight) {
			if (warning.kind === 'warning') renderWarningChip(this.body, warning.message);
		}

		this.dispatch({ type: 'mounted' });
	}

	private async measure(): Promise<void> {
		const svg = this.body.querySelector('svg');
		if (!svg || !this.artifact || this.artifact.viewBox !== null) return;

		const bounds = await measureInk(svg as SVGSVGElement, this.body.doc);
		if (!bounds || this.state.phase === 'DISPOSED' || !this.artifact) return;

		this.artifact = withMeasuredBounds(this.artifact, bounds);
		svg.setAttribute('viewBox', this.artifact.viewBox ?? '');
		if (!this.spec.options.nocache) this.deps.cache.put(this.spec.key, this.artifact);
	}

	private mountError(): void {
		this.placeholder?.remove();
		this.placeholder = null;

		const failure = this.failure ?? new TexError('empty-output', []);
		renderErrorCard(this.body, {
			diagnostic: explain(
				{
					kind: failure.kind,
					message: failure.message,
					firstError: failure.firstError,
					line: failure.line,
				},
				this.deps.host.capabilities,
			),
			source: this.spec.source,
			log: failure.log,
			onRetry: () => this.dispatch({ type: 'retry' }),
		});
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
