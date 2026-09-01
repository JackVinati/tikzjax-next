import type { LazyMode, TexErrorKind } from '../types';

/**
 * The per-block lifecycle, as a pure reducer. See docs/DESIGN.md §3.3 for the transition table.
 *
 * Nothing here touches the DOM, awaits anything, or reads a clock. Effects are *descriptions*;
 * `block/render-child.ts` executes them. That split is the whole point: the lifecycle of a diagram
 * — viewport gating, debounce, queueing, timeout, unload mid-compile — is exhaustively testable in
 * Node, which is the only way the settle invariant below can be property-tested at all.
 *
 * THE INVARIANT: exactly one `settle` effect per block. The code-block processor returns the
 * child's promise to Obsidian; in reading mode `Promise.all(asyncSections)` has no `.catch` and no
 * timeout, so a promise that never settles strands the section list forever (upstream #18 #23 #27
 * #39 #51 #82 #85 #89), and one that settles twice is a bug that hides for months. The `settled`
 * flag on `State` is what makes it structural rather than a discipline.
 */

// -------------------------------------------------------------------------------------------
// Vocabulary

/** `0` export/print · `1` visible · `2` within rootMargin · `3` prefetch / manual / zero-record. */
export type Priority = 0 | 1 | 2 | 3;

/** L1 is checked synchronously in `KEYING`; only these two tiers cost a `LOOKUP`. */
export type CacheTier = 'l2' | 'l3';

/** An L3 hit is a *pre*-post-processing SVG, so it must run the pipeline before it can mount. */
export type TransformOrigin = 'l3' | 'render';

export type ManualReason = 'manual' | 'depthCap';

/**
 * `poisoned` is deliberately distinct from `timeout`: the first says "a previous run of this exact
 * key wedged a worker, reload to retry", the second is this render's own failure. Same kind of
 * card, different copy and different truth.
 */
export type FailureReason = TexErrorKind | 'empty-source' | 'preflight' | 'poisoned';

export type Phase =
	| 'INIT'
	| 'KEYING'
	| 'LOOKUP'
	| 'GATING'
	| 'DEBOUNCING'
	| 'SCHEDULING'
	| 'COMPILING'
	| 'TRANSFORMING'
	| 'MOUNTING'
	| 'MOUNTED'
	| 'MOUNTED_DEGRADED'
	| 'IDLE_MANUAL'
	| 'FAILED'
	| 'DISPOSED';

/** The phase-specific half of `State`. Split out so `reduce` can build a next state without
 *  restating the two flags every branch — see `go()`. */
type Draft =
	| { phase: 'INIT' }
	| { phase: 'KEYING' }
	| { phase: 'LOOKUP' }
	| { phase: 'GATING' }
	| { phase: 'DEBOUNCING' }
	| { phase: 'SCHEDULING'; priority: Priority }
	| { phase: 'COMPILING'; priority: Priority }
	| { phase: 'TRANSFORMING'; origin: TransformOrigin }
	| { phase: 'MOUNTING'; degraded: boolean }
	| { phase: 'MOUNTED' }
	| { phase: 'MOUNTED_DEGRADED' }
	| { phase: 'IDLE_MANUAL'; reason: ManualReason }
	| { phase: 'FAILED'; reason: FailureReason }
	| { phase: 'DISPOSED' };

interface Flags {
	/** Latches. Once true, no further `settle` is ever emitted, on any path. */
	readonly settled: boolean;
	/**
	 * The child was unloaded while a job was already running. The job is NOT cancelled (see the
	 * `COMPILING + unload` note in `reduce`), so its result still arrives — but it must reach the
	 * cache without ever reaching the DOM, because the DOM it belonged to is gone.
	 */
	readonly unloaded: boolean;
}

/** Intersecting a union with an object distributes, so `state.phase` still discriminates. */
export type State = Draft & Flags;

export type Event =
	| { type: 'load' }
	| { type: 'emptySource' }
	| { type: 'preflightError' }
	| { type: 'l1Hit' }
	| { type: 'l1Miss' }
	| { type: 'hit'; tier: CacheTier }
	| {
			type: 'miss';
			isExport?: boolean | undefined;
			poisoned?: boolean | undefined;
			lazy?: LazyMode | undefined;
			depthCapped?: boolean | undefined;
	  }
	| { type: 'intersect' }
	| { type: 'noRecordsAfter2s' }
	/** The debounce elapsed. Priority is decided by the child from visibility, not by the machine. */
	| { type: 'timer'; priority: Priority }
	| { type: 'slot' }
	/**
	 * The queue settled `submit` without ever starting the job.
	 *
	 * `RenderQueue` rejects with `depth-cap`, `poisoned` or `cancelled` before `run` is ever
	 * called (src/queue/queue.ts), which means no `slot` will arrive — and `slot` is SCHEDULING's
	 * only other exit. Without this row an over-cap note (17 blocks on mobile, where `depthCap`
	 * is 16) leaves every evicted block sitting in SCHEDULING with its processor promise
	 * unresolved forever, which is precisely the never-settling class of #18 #23 #27 #39 #51 #82
	 * #85 #89. `depthCap` is the "offer the button" branch — map the queue's `cancelled` here
	 * too — and every other reason is an error card.
	 *
	 * Strictly pre-start: once `slot` has fired the job is running and the queue's settlement
	 * arrives as `ok` / `err` / `timeout`, which is what carries `terminateWorker` + `poison`.
	 */
	| { type: 'rejected'; reason: 'depthCap' | FailureReason }
	| { type: 'ok' }
	| { type: 'err'; reason: TexErrorKind }
	| { type: 'timeout' }
	| { type: 'stageThrew' }
	| { type: 'mounted' }
	| { type: 'cssChange' }
	| { type: 'retry' }
	| { type: 'unload' };

export type Effect =
	| { kind: 'addClasses' }
	| { kind: 'paintPlaceholder' }
	/** One IndexedDB read, plus one legacy read while the L3 import window is open (§8.3). */
	| { kind: 'lookup' }
	/**
	 * Copy a tier's record into L1 as-is. `'l2'` and not `CacheTier`, structurally: only L2 holds
	 * a finished artifact. An L3 record has to go through the pipeline first, and its write is
	 * `persist` on the far side of it.
	 */
	| { kind: 'promote'; tier: 'l2' }
	| { kind: 'transform'; origin: TransformOrigin }
	| { kind: 'persist' }
	| { kind: 'observe' }
	| { kind: 'unobserve' }
	| { kind: 'startDebounce' }
	| { kind: 'clearTimers' }
	| { kind: 'submit'; priority: Priority }
	| { kind: 'release' }
	| { kind: 'startRender' }
	| { kind: 'abort' }
	| { kind: 'terminateWorker' }
	| { kind: 'poison' }
	| { kind: 'unpoison' }
	| { kind: 'mount'; degraded: boolean }
	/** `fonts.ready` + `getBBox()`, and only on the first mount of a key — the child decides. */
	| { kind: 'measure' }
	| { kind: 'mountErrorCard'; reason: FailureReason }
	| { kind: 'mountManualButton'; reason: ManualReason }
	| { kind: 'settle' };

// -------------------------------------------------------------------------------------------
// Settlement

/**
 * The phases whose *first* entry settles the processor promise.
 *
 * §3.3 names four: MOUNTED, MOUNTED_DEGRADED, FAILED, DISPOSED. IDLE_MANUAL is added here
 * deliberately, and it is a correction rather than an extension: it is a *resting* phase — the
 * block has painted its final DOM (a "Render diagram" button) and nothing further will happen
 * until the user clicks. Leaving it unsettled would mean every note containing one `lazy=manual`
 * block, or one block demoted past the depth cap, hangs `Promise.all(asyncSections)` forever —
 * which is precisely the failure class this invariant exists to prevent. The `settled` latch still
 * guarantees the later IDLE_MANUAL → SCHEDULING → MOUNTED path emits no second settle.
 */
const SETTLES_ON_ENTRY: ReadonlySet<Phase> = new Set<Phase>([
	'MOUNTED',
	'MOUNTED_DEGRADED',
	'IDLE_MANUAL',
	'FAILED',
	'DISPOSED',
]);

export function initialState(): State {
	return { phase: 'INIT', settled: false, unloaded: false };
}

/** Same state object, no effects. Identity is meaningful: the child can skip work on a no-op. */
function noop(state: State): [State, Effect[]] {
	return [state, []];
}

/**
 * Enter `draft`, appending `settle` last when this is the first entry to a settling phase.
 *
 * Last, not first: the promise resolving is Obsidian's signal that the section's DOM is final, so
 * the mount or the error card must already be in the list ahead of it.
 */
function go(
	prev: State,
	draft: Draft,
	effects: Effect[],
	unloaded: boolean = prev.unloaded,
): [State, Effect[]] {
	const settles = !prev.settled && SETTLES_ON_ENTRY.has(draft.phase);
	const next = { ...draft, settled: prev.settled || settles, unloaded } as State;
	return [next, settles ? [...effects, { kind: 'settle' }] : effects];
}

/**
 * `any → unload → DISPOSED`, with the one exception in the table.
 *
 * `abort()` is emitted from every phase but COMPILING. A started TeX run cannot be cancelled: the
 * only way to stop an asyncify'd `texify` is `Worker.terminate()`, which costs a respawn and
 * throws away work already paid for. Mid-flight termination is reserved for timeout, plugin unload
 * and backpressure — never for one block scrolling out of view.
 */
function unload(state: State): [State, Effect[]] {
	if (state.phase === 'COMPILING') {
		if (state.unloaded) return noop(state);
		// Stays COMPILING, and deliberately does NOT settle: the running job always ends in ok,
		// err or timeout — the timeout is the backstop — and the settle happens at DISPOSED then.
		// `release` is still safe here: the queue drops an *unstarted* job at refs 0 and leaves a
		// started one to finish and cache. Timers are NOT cleared, because the timeout timer is
		// what terminates a wedged worker whether or not this block still cares.
		return [{ ...state, unloaded: true }, [{ kind: 'release' }]];
	}

	const effects: Effect[] = [{ kind: 'abort' }];
	if (state.phase === 'GATING') effects.push({ kind: 'unobserve' });
	// GATING holds the 2 s zero-record timer; DEBOUNCING holds the debounce. Clearing the latter
	// is the whole of the fix for #24: in Live Preview a keystroke destroys the widget, so the old
	// child unloads before its timer fires and nothing is ever submitted.
	if (state.phase === 'GATING' || state.phase === 'DEBOUNCING') effects.push({ kind: 'clearTimers' });
	if (state.phase === 'SCHEDULING') effects.push({ kind: 'release' });

	return go(state, { phase: 'DISPOSED' }, effects, true);
}

// -------------------------------------------------------------------------------------------
// The reducer

export function reduce(state: State, event: Event): [State, Effect[]] {
	// DISPOSED is absorbing. A late reply from an abandoned job, a second unload from a double
	// teardown, or an IntersectionObserver record for a detached element all land here.
	if (state.phase === 'DISPOSED') return noop(state);

	if (event.type === 'unload') return unload(state);

	switch (state.phase) {
		case 'INIT':
			if (event.type === 'load') {
				return go(state, { phase: 'KEYING' }, [{ kind: 'addClasses' }, { kind: 'paintPlaceholder' }]);
			}
			return noop(state);

		case 'KEYING':
			switch (event.type) {
				case 'emptySource':
					// Never enqueued. This is upstream's `childNodes[0].nodeValue` throw, killed at
					// the door rather than after a worker has been booted for it.
					return go(state, { phase: 'FAILED', reason: 'empty-source' }, [
						{ kind: 'mountErrorCard', reason: 'empty-source' },
					]);
				case 'preflightError':
					return go(state, { phase: 'FAILED', reason: 'preflight' }, [
						{ kind: 'mountErrorCard', reason: 'preflight' },
					]);
				case 'l1Hit':
					// Straight to MOUNTED, skipping MOUNTING: an L1 hit is a Map.get plus one string
					// replace, so the child mounts synchronously and the section is never flagged async.
					return go(state, { phase: 'MOUNTED' }, [
						{ kind: 'mount', degraded: false },
						{ kind: 'measure' },
					]);
				case 'l1Miss':
					return go(state, { phase: 'LOOKUP' }, [{ kind: 'lookup' }]);
				default:
					return noop(state);
			}

		case 'LOOKUP':
			switch (event.type) {
				case 'hit':
					if (event.tier === 'l3') {
						// No `promote` here, and the table's combined "promote to L1" row is wrong
						// for this tier. L1 and L2 hold the FINAL post-processed artifact (§6.2);
						// a legacy record is the raw, pre-SVGO, pgf-id-baked SVG the old bundle
						// stored before it dispatched its event (§8.3). Writing it to L1 now would
						// make the next block with this key take `l1Hit` straight to MOUNTED and
						// paint that raw SVG — #15 and #12 at once, and past the mandatory
						// sanitize stage. The import is `persist`, after the pipeline.
						return go(state, { phase: 'TRANSFORMING', origin: 'l3' }, [
							{ kind: 'transform', origin: 'l3' },
						]);
					}
					return go(state, { phase: 'MOUNTING', degraded: false }, [
						{ kind: 'promote', tier: 'l2' },
						{ kind: 'mount', degraded: false },
					]);
				case 'miss':
					return miss(state, event);
				default:
					return noop(state);
			}

		case 'GATING':
			switch (event.type) {
				case 'intersect':
					return go(state, { phase: 'DEBOUNCING' }, [
						{ kind: 'unobserve' },
						{ kind: 'clearTimers' },
						{ kind: 'startDebounce' },
					]);
				case 'noRecordsAfter2s':
					// A block inside a collapsed callout, a hidden tab, a `display:none` ancestor or a
					// detached reading-view section never receives an IntersectionObserver record at
					// all, and would sit here behind a permanent placeholder — a blank-diagram bug
					// introduced by lazy rendering itself. Lowest band, so it yields to visible work.
					return go(state, { phase: 'SCHEDULING', priority: 3 }, [
						{ kind: 'unobserve' },
						{ kind: 'submit', priority: 3 },
					]);
				default:
					return noop(state);
			}

		case 'DEBOUNCING':
			if (event.type === 'timer') {
				return go(state, { phase: 'SCHEDULING', priority: event.priority }, [
					{ kind: 'submit', priority: event.priority },
				]);
			}
			return noop(state);

		case 'SCHEDULING':
			if (event.type === 'slot') {
				return go(state, { phase: 'COMPILING', priority: state.priority }, [{ kind: 'startRender' }]);
			}
			if (event.type === 'rejected') {
				// `depthCap` is not a failure: the block is renderable, the queue just declined to
				// commit to it now. The other reasons — `poisoned` above all, which `miss` cannot
				// see because the key may have been poisoned by another copy of the same diagram
				// *after* this block's lookup — are cards.
				return event.reason === 'depthCap'
					? go(state, { phase: 'IDLE_MANUAL', reason: 'depthCap' }, [
							{ kind: 'mountManualButton', reason: 'depthCap' },
						])
					: go(state, { phase: 'FAILED', reason: event.reason }, [
							{ kind: 'mountErrorCard', reason: event.reason },
						]);
			}
			return noop(state);

		case 'COMPILING':
			switch (event.type) {
				case 'ok':
					// Transform even when unloaded: we already paid for the compile, and the artifact
					// is worth caching for the next mount of this key.
					return go(state, { phase: 'TRANSFORMING', origin: 'render' }, [
						{ kind: 'transform', origin: 'render' },
					]);
				case 'err':
					if (state.unloaded) return go(state, { phase: 'DISPOSED' }, []);
					return go(state, { phase: 'FAILED', reason: event.reason }, [
						{ kind: 'mountErrorCard', reason: event.reason },
					]);
				case 'timeout': {
					// The worker is wedged inside an asyncify unwind and is never reused; the key is
					// poisoned for the session so one bad diagram cannot starve the vault. Both happen
					// even if this block is gone — they are engine hygiene, not presentation.
					const cleanup: Effect[] = [{ kind: 'terminateWorker' }, { kind: 'poison' }];
					if (state.unloaded) return go(state, { phase: 'DISPOSED' }, cleanup);
					return go(state, { phase: 'FAILED', reason: 'timeout' }, [
						...cleanup,
						{ kind: 'mountErrorCard', reason: 'timeout' },
					]);
				}
				default:
					return noop(state);
			}

		case 'TRANSFORMING':
			switch (event.type) {
				case 'ok':
					if (state.unloaded) return go(state, { phase: 'DISPOSED' }, [{ kind: 'persist' }]);
					return go(state, { phase: 'MOUNTING', degraded: false }, [
						{ kind: 'persist' },
						{ kind: 'mount', degraded: false },
					]);
				case 'stageThrew':
					// Fall back to the previous stage's output and mount it with a warning chip —
					// never a silent raw-SVG fallthrough (#15, #48). Not persisted: a degraded
					// artifact must not become the cached answer for this key. The `ids` stage is
					// exempt from degradation upstream of here, so this can never reintroduce #12.
					if (state.unloaded) return go(state, { phase: 'DISPOSED' }, []);
					return go(state, { phase: 'MOUNTING', degraded: true }, [
						{ kind: 'mount', degraded: true },
					]);
				default:
					return noop(state);
			}

		case 'MOUNTING':
			if (event.type === 'mounted') {
				const measure: Effect[] = [{ kind: 'measure' }];
				return state.degraded
					? go(state, { phase: 'MOUNTED_DEGRADED' }, measure)
					: go(state, { phase: 'MOUNTED' }, measure);
			}
			return noop(state);

		case 'MOUNTED':
		case 'MOUNTED_DEGRADED':
			// `cssChange` is listed in the table only to be explicit that it is a no-op: colour is
			// CSS, and a theme switch must never invalidate an artifact or trigger a re-render.
			return noop(state);

		case 'IDLE_MANUAL':
			// The "Render diagram" button. Priority 1: the user is looking straight at it.
			if (event.type === 'retry') {
				return go(state, { phase: 'SCHEDULING', priority: 1 }, [{ kind: 'submit', priority: 1 }]);
			}
			return noop(state);

		case 'FAILED':
			// `empty-source` is the one failure a retry cannot change: the source is a cache-key
			// input, so a block whose source changed is a different child. Re-submitting would
			// boot a worker for an empty document, which is the whole thing §3.3's bolded "never
			// enqueue" exists to prevent — and a Retry wired generically to every error card is
			// the obvious way for that to happen.
			if (event.type === 'retry' && state.reason !== 'empty-source') {
				return go(state, { phase: 'SCHEDULING', priority: 1 }, [
					{ kind: 'unpoison' },
					{ kind: 'submit', priority: 1 },
				]);
			}
			return noop(state);
	}
}

/**
 * The `LOOKUP + miss` fan-out. Order is the table's order and it is load-bearing.
 *
 * Export wins over poison: `printToPdf` awaits every block, and an error card in the PDF is a
 * better outcome than an unrendered one. Poison then wins over manual, because a key that already
 * wedged a worker must not be re-offered behind a button that will wedge another.
 */
function miss(state: State, event: Extract<Event, { type: 'miss' }>): [State, Effect[]] {
	if (event.isExport === true) {
		// Bypasses the gate AND the debounce: an off-screen block in a PDF still has to render.
		return go(state, { phase: 'SCHEDULING', priority: 0 }, [{ kind: 'submit', priority: 0 }]);
	}
	if (event.poisoned === true) {
		return go(state, { phase: 'FAILED', reason: 'poisoned' }, [
			{ kind: 'mountErrorCard', reason: 'poisoned' },
		]);
	}
	if (event.lazy === 'manual') {
		return go(state, { phase: 'IDLE_MANUAL', reason: 'manual' }, [
			{ kind: 'mountManualButton', reason: 'manual' },
		]);
	}
	if (event.depthCapped === true) {
		return go(state, { phase: 'IDLE_MANUAL', reason: 'depthCap' }, [
			{ kind: 'mountManualButton', reason: 'depthCap' },
		]);
	}
	if (event.lazy === 'off') {
		// `lazy=off` opts out of the viewport gate only. It still debounces, because the debounce
		// is what makes typing in Live Preview free (#24) and has nothing to do with laziness.
		return go(state, { phase: 'DEBOUNCING' }, [{ kind: 'startDebounce' }]);
	}
	return go(state, { phase: 'GATING' }, [{ kind: 'observe' }]);
}
