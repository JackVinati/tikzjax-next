import { describe, expect, it } from 'vitest';
import {
	initialState,
	reduce,
	type Effect,
	type Event,
	type FailureReason,
	type Phase,
	type Priority,
	type State,
} from '../src/block/machine';

// -------------------------------------------------------------------------------------------
// Helpers

/** Feed a sequence, returning the final state and every effect in order. */
function drive(start: State, events: Event[]): { state: State; effects: Effect[] } {
	let state = start;
	const effects: Effect[] = [];
	for (const event of events) {
		const [next, fx] = reduce(state, event);
		state = next;
		effects.push(...fx);
	}
	return { state, effects };
}

function kinds(effects: Effect[]): string[] {
	return effects.map((e) => e.kind);
}

function countSettles(effects: Effect[]): number {
	return effects.filter((e) => e.kind === 'settle').length;
}

const LOAD: Event[] = [{ type: 'load' }];
const TO_LOOKUP: Event[] = [...LOAD, { type: 'l1Miss' }];
const TO_GATING: Event[] = [...TO_LOOKUP, { type: 'miss' }];
/** A block of a note being typed in: the only kind that debounces (DECISIONS.md D22). */
const TO_GATING_EDITED: Event[] = [...TO_LOOKUP, { type: 'miss', editing: true }];
const TO_DEBOUNCING: Event[] = [...TO_GATING_EDITED, { type: 'intersect' }];
const TO_SCHEDULING: Event[] = [...TO_DEBOUNCING, { type: 'timer', priority: 1 }];
const TO_COMPILING: Event[] = [...TO_SCHEDULING, { type: 'slot' }];
const TO_TRANSFORMING: Event[] = [...TO_COMPILING, { type: 'ok' }];
const TO_MOUNTING: Event[] = [...TO_TRANSFORMING, { type: 'ok' }];

/** One representative, genuinely reachable state per phase. */
const REACHABLE: ReadonlyArray<readonly [Phase, Event[]]> = [
	['INIT', []],
	['KEYING', LOAD],
	['LOOKUP', TO_LOOKUP],
	['GATING', TO_GATING],
	['DEBOUNCING', TO_DEBOUNCING],
	['SCHEDULING', TO_SCHEDULING],
	['COMPILING', TO_COMPILING],
	['TRANSFORMING', TO_TRANSFORMING],
	['MOUNTING', TO_MOUNTING],
	['MOUNTED', [...TO_MOUNTING, { type: 'mounted' }]],
	['MOUNTED_DEGRADED', [...TO_TRANSFORMING, { type: 'degraded' }, { type: 'mounted' }]],
	['IDLE_MANUAL', [...TO_LOOKUP, { type: 'miss', lazy: 'manual' }]],
	['FAILED', [...LOAD, { type: 'emptySource' }]],
	['DISPOSED', [...LOAD, { type: 'unload' }]],
];

function stateFor(phase: Phase): State {
	const entry = REACHABLE.find(([p]) => p === phase);
	if (!entry) throw new Error(`no path to ${phase}`);
	const { state } = drive(initialState(), entry[1].slice());
	expect(state.phase).toBe(phase);
	return state;
}

// -------------------------------------------------------------------------------------------
// The transition table, row by row (internal/DESIGN.md §3.3)

describe('transition table', () => {
	it('— + load -> KEYING, painting a placeholder before anything async', () => {
		const [state, fx] = reduce(initialState(), { type: 'load' });
		expect(state.phase).toBe('KEYING');
		expect(kinds(fx)).toEqual(['addClasses', 'paintPlaceholder']);
	});

	it('KEYING + emptySource -> FAILED, and never enqueues', () => {
		const [state, fx] = reduce(stateFor('KEYING'), { type: 'emptySource' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'empty-source' });
		expect(kinds(fx)).toEqual(['mountErrorCard', 'settle']);
		expect(kinds(fx)).not.toContain('submit');
	});

	it('KEYING + preflightError -> FAILED(preflight)', () => {
		const [state, fx] = reduce(stateFor('KEYING'), { type: 'preflightError' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'preflight' });
		expect(fx).toContainEqual({ kind: 'mountErrorCard', reason: 'preflight' });
	});

	it('KEYING + l1Hit -> MOUNTED directly, skipping MOUNTING', () => {
		const [state, fx] = reduce(stateFor('KEYING'), { type: 'l1Hit' });
		expect(state.phase).toBe('MOUNTED');
		expect(kinds(fx)).toEqual(['mount', 'measure', 'settle']);
	});

	it('KEYING + l1Miss -> LOOKUP', () => {
		const [state, fx] = reduce(stateFor('KEYING'), { type: 'l1Miss' });
		expect(state.phase).toBe('LOOKUP');
		expect(kinds(fx)).toEqual(['lookup']);
	});

	it('LOOKUP + hit(l2) -> MOUNTING; hit(l3) -> TRANSFORMING', () => {
		const [l2, l2fx] = reduce(stateFor('LOOKUP'), { type: 'hit', tier: 'l2' });
		expect(l2).toMatchObject({ phase: 'MOUNTING', degraded: false });
		expect(kinds(l2fx)).toEqual(['promote', 'mount']);

		// An L3 record is a pre-post-processing SVG, so it must run the pipeline before it mounts
		// — and before it may be written to any tier. See the L3 import block below.
		const [l3, l3fx] = reduce(stateFor('LOOKUP'), { type: 'hit', tier: 'l3' });
		expect(l3).toMatchObject({ phase: 'TRANSFORMING', origin: 'l3' });
		expect(kinds(l3fx)).toEqual(['transform']);
		expect(kinds(l3fx)).not.toContain('mount');
	});

	it('LOOKUP + miss ^ isExport -> SCHEDULING at priority 0, bypassing gate and debounce', () => {
		const [state, fx] = reduce(stateFor('LOOKUP'), { type: 'miss', isExport: true });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 0 });
		expect(fx).toEqual([{ kind: 'submit', priority: 0 }]);
	});

	it('LOOKUP + miss ^ poisoned -> FAILED(poisoned)', () => {
		const [state, fx] = reduce(stateFor('LOOKUP'), { type: 'miss', poisoned: true });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'poisoned' });
		expect(kinds(fx)).toEqual(['mountErrorCard', 'settle']);
	});

	it('LOOKUP + miss ^ manual|depthCap -> IDLE_MANUAL with the reason that got it there', () => {
		const [manual] = reduce(stateFor('LOOKUP'), { type: 'miss', lazy: 'manual' });
		expect(manual).toMatchObject({ phase: 'IDLE_MANUAL', reason: 'manual' });

		const [capped, fx] = reduce(stateFor('LOOKUP'), { type: 'miss', depthCapped: true });
		expect(capped).toMatchObject({ phase: 'IDLE_MANUAL', reason: 'depthCap' });
		expect(fx).toContainEqual({ kind: 'mountManualButton', reason: 'depthCap' });
	});

	it('LOOKUP + miss -> GATING, remembering whether the block is being typed in', () => {
		const [state, fx] = reduce(stateFor('LOOKUP'), { type: 'miss' });
		expect(state).toMatchObject({ phase: 'GATING', debounce: false });
		expect(fx).toEqual([{ kind: 'observe' }]);

		const [edited] = reduce(stateFor('LOOKUP'), { type: 'miss', editing: true });
		expect(edited).toMatchObject({ phase: 'GATING', debounce: true });
	});

	it('GATING + intersect -> SCHEDULING at once, in band 1, for a block not being typed in', () => {
		// A block shown for the first time, or shown again as it was: there is no typing to wait
		// out, and the debounce was 300 ms on the desktop and 500 on a phone before anything queued.
		const [state, fx] = reduce(stateFor('GATING'), { type: 'intersect' });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 1 });
		expect(fx).toEqual([{ kind: 'unobserve' }, { kind: 'clearTimers' }, { kind: 'submit', priority: 1 }]);
	});

	it('GATING + intersect -> DEBOUNCING for a block being typed in, dropping the observer and the zero-record timer', () => {
		const gating = drive(initialState(), TO_GATING_EDITED).state;
		const [state, fx] = reduce(gating, { type: 'intersect' });
		expect(state.phase).toBe('DEBOUNCING');
		expect(kinds(fx)).toEqual(['unobserve', 'clearTimers', 'startDebounce']);
	});

	it('LOOKUP + miss ^ lazy=off -> SCHEDULING in band 2, or DEBOUNCING when being typed in', () => {
		// No gate to pass, so never seen: band 2, as the child would say of a block it does not know
		// to be in view. Typing still debounces: that is what #24 needs, and it is not laziness.
		const [fresh, fx] = reduce(stateFor('LOOKUP'), { type: 'miss', lazy: 'off' });
		expect(fresh).toMatchObject({ phase: 'SCHEDULING', priority: 2 });
		expect(fx).toEqual([{ kind: 'submit', priority: 2 }]);

		const [edited, efx] = reduce(stateFor('LOOKUP'), { type: 'miss', lazy: 'off', editing: true });
		expect(edited.phase).toBe('DEBOUNCING');
		expect(efx).toEqual([{ kind: 'startDebounce' }]);
	});

	it('a block of a note being typed in submits nothing until its debounce runs out, and nothing at all if the next keystroke unloads it', () => {
		const typed = drive(initialState(), [...TO_DEBOUNCING, { type: 'unload' }]);
		expect(kinds(typed.effects)).not.toContain('submit');
		expect(countSettles(typed.effects)).toBe(1);
	});

	it('GATING + noRecordsAfter2s -> SCHEDULING at the lowest band (the escape hatch)', () => {
		const [state, fx] = reduce(stateFor('GATING'), { type: 'noRecordsAfter2s' });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 3 });
		expect(kinds(fx)).toEqual(['unobserve', 'submit']);
	});

	it('DEBOUNCING + timer -> SCHEDULING, carrying the priority the child computed', () => {
		for (const priority of [0, 1, 2, 3] as Priority[]) {
			const [state, fx] = reduce(stateFor('DEBOUNCING'), { type: 'timer', priority });
			expect(state).toMatchObject({ phase: 'SCHEDULING', priority });
			expect(fx).toEqual([{ kind: 'submit', priority }]);
		}
	});

	it('DEBOUNCING + unload -> DISPOSED with nothing ever submitted (#24)', () => {
		const [state, fx] = reduce(stateFor('DEBOUNCING'), { type: 'unload' });
		expect(state.phase).toBe('DISPOSED');
		expect(kinds(fx)).toEqual(['abort', 'clearTimers', 'settle']);
		expect(kinds(fx)).not.toContain('submit');
	});

	it('SCHEDULING + slot -> COMPILING, keeping the band it was queued at', () => {
		const scheduled = drive(initialState(), [...TO_DEBOUNCING, { type: 'timer', priority: 2 }]).state;
		const [state, fx] = reduce(scheduled, { type: 'slot' });
		expect(state).toMatchObject({ phase: 'COMPILING', priority: 2 });
		expect(fx).toEqual([{ kind: 'startRender' }]);
	});

	it('COMPILING + ok -> TRANSFORMING(render)', () => {
		const [state, fx] = reduce(stateFor('COMPILING'), { type: 'ok' });
		expect(state).toMatchObject({ phase: 'TRANSFORMING', origin: 'render' });
		expect(fx).toEqual([{ kind: 'transform', origin: 'render' }]);
	});

	it('COMPILING + err -> FAILED, carrying the engine error kind through to the card', () => {
		const [state, fx] = reduce(stateFor('COMPILING'), { type: 'err', reason: 'missing-file' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'missing-file' });
		expect(fx).toEqual([{ kind: 'mountErrorCard', reason: 'missing-file' }, { kind: 'settle' }]);
		// An ordinary TeX error does not cost a worker.
		expect(kinds(fx)).not.toContain('terminateWorker');
		expect(kinds(fx)).not.toContain('poison');
	});

	it('COMPILING + timeout -> FAILED, terminating the worker and poisoning the key', () => {
		const [state, fx] = reduce(stateFor('COMPILING'), { type: 'timeout' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'timeout' });
		expect(kinds(fx)).toEqual(['terminateWorker', 'poison', 'mountErrorCard', 'settle']);
	});

	it('TRANSFORMING + ok -> MOUNTING, persisting first', () => {
		const [state, fx] = reduce(stateFor('TRANSFORMING'), { type: 'ok' });
		expect(state).toMatchObject({ phase: 'MOUNTING', degraded: false });
		expect(kinds(fx)).toEqual(['persist', 'mount']);
	});

	it('TRANSFORMING + degraded -> MOUNTING(degraded) and does NOT persist', () => {
		// An optional stage was skipped. What is left has passed sanitize and ids, so it may be
		// shown — with its warning — but it must never become the cached answer for this key.
		const [state, fx] = reduce(stateFor('TRANSFORMING'), { type: 'degraded' });
		expect(state).toMatchObject({ phase: 'MOUNTING', degraded: true });
		expect(fx).toEqual([{ kind: 'mount', degraded: true }]);
		expect(kinds(fx)).not.toContain('persist');
	});

	it('TRANSFORMING + stageThrew -> FAILED: no document passed sanitize and ids, so nothing mounts', () => {
		// It used to mount the RAW engine output "degraded", past the sanitizer, and measure()
		// then persisted it. The engine passes \special{dvisvgm:raw} through verbatim.
		const [state, fx] = reduce(stateFor('TRANSFORMING'), { type: 'stageThrew' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'pipeline' });
		expect(fx).toEqual([{ kind: 'mountErrorCard', reason: 'pipeline' }, { kind: 'settle' }]);
		expect(kinds(fx)).not.toContain('mount');
		expect(kinds(fx)).not.toContain('persist');
	});

	it('MOUNTING + mounted -> MOUNTED or MOUNTED_DEGRADED, per the degraded flag it carried', () => {
		const [ok, okFx] = reduce(stateFor('MOUNTING'), { type: 'mounted' });
		expect(ok.phase).toBe('MOUNTED');
		expect(okFx).toContainEqual({ kind: 'measure', persist: true });

		const degraded = drive(initialState(), [...TO_TRANSFORMING, { type: 'degraded' }]).state;
		const [mounted, fx] = reduce(degraded, { type: 'mounted' });
		expect(mounted.phase).toBe('MOUNTED_DEGRADED');
		expect(kinds(fx)).toEqual(['measure', 'settle']);
		// The measurement may correct what is on screen, but a degraded artifact is never stored.
		expect(fx).toContainEqual({ kind: 'measure', persist: false });
	});

	it('MOUNTING + err -> FAILED, rather than a block that never settles', () => {
		// A mount that finds no <svg> in the artifact reports `err`; MOUNTING used to ignore it.
		const [state, fx] = reduce(stateFor('MOUNTING'), { type: 'err', reason: 'empty-output' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'empty-output' });
		expect(kinds(fx)).toEqual(['mountErrorCard', 'settle']);
	});

	it('MOUNTED + css-change is a no-op: colour is CSS', () => {
		const mounted = stateFor('MOUNTED');
		const [state, fx] = reduce(mounted, { type: 'cssChange' });
		expect(state).toBe(mounted);
		expect(fx).toEqual([]);
	});

	it('FAILED + retry -> SCHEDULING, clearing the poison entry for this key', () => {
		const failed = drive(initialState(), [...TO_COMPILING, { type: 'timeout' }]).state;
		const [state, fx] = reduce(failed, { type: 'retry' });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 1 });
		// The card gives way to a spinner first: it used to stay up, under the diagram that replaced it.
		expect(kinds(fx)).toEqual(['paintPlaceholder', 'unpoison', 'submit']);
	});

	it('FAILED(empty-source) + retry never enqueues', () => {
		// §3.3's emptySource row is bolded "never enqueue": the point of killing it at the door is
		// that no worker is ever booted for it. A generic Retry wired to every error card would
		// undo exactly that, and the outcome cannot differ — the source is part of the key, so a
		// block whose source changed is a different child.
		const failed = drive(initialState(), [...LOAD, { type: 'emptySource' }]).state;
		const [state, fx] = reduce(failed, { type: 'retry' });
		expect(state).toBe(failed);
		expect(fx).toEqual([]);
	});

	it('IDLE_MANUAL + retry -> SCHEDULING (the "Render diagram" button)', () => {
		const [state, fx] = reduce(stateFor('IDLE_MANUAL'), { type: 'retry' });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 1 });
		expect(fx).toEqual([{ kind: 'paintPlaceholder' }, { kind: 'submit', priority: 1 }]);
	});

	it('any + unload -> DISPOSED, with teardown scoped to what that phase actually holds', () => {
		const gating = reduce(stateFor('GATING'), { type: 'unload' });
		expect(kinds(gating[1])).toEqual(['abort', 'unobserve', 'clearTimers', 'settle']);

		const scheduling = reduce(stateFor('SCHEDULING'), { type: 'unload' });
		expect(kinds(scheduling[1])).toEqual(['abort', 'release', 'settle']);

		// Nothing is observing or queued yet in KEYING, so there is nothing to unobserve or release.
		const keying = reduce(stateFor('KEYING'), { type: 'unload' });
		expect(kinds(keying[1])).toEqual(['abort', 'settle']);
	});
});

// -------------------------------------------------------------------------------------------
// The COMPILING/unload exception

describe('COMPILING + unload does not cancel a started job', () => {
	it('stays COMPILING, never aborts, and does not settle yet', () => {
		const [state, fx] = reduce(stateFor('COMPILING'), { type: 'unload' });
		expect(state.phase).toBe('COMPILING');
		expect(state.unloaded).toBe(true);
		expect(state.settled).toBe(false);
		// `release` only decrements the refcount; the queue leaves a started job to finish.
		expect(fx).toEqual([{ kind: 'release' }]);
		expect(kinds(fx)).not.toContain('abort');
		// The timeout timer must survive: it is what terminates a worker that wedges.
		expect(kinds(fx)).not.toContain('clearTimers');
	});

	it('a second unload while already unloaded is idempotent', () => {
		const once = reduce(stateFor('COMPILING'), { type: 'unload' })[0];
		const [twice, fx] = reduce(once, { type: 'unload' });
		expect(twice).toBe(once);
		expect(fx).toEqual([]);
	});

	it('the late result is transformed and cached but never mounted', () => {
		const start = stateFor('COMPILING');
		const { state, effects } = drive(start, [{ type: 'unload' }, { type: 'ok' }, { type: 'ok' }]);
		expect(state.phase).toBe('DISPOSED');
		// We already paid for the compile; the artifact is worth having for the next mount.
		expect(kinds(effects)).toEqual(['release', 'transform', 'persist', 'settle']);
		expect(kinds(effects)).not.toContain('mount');
		expect(countSettles(effects)).toBe(1);
	});

	it('a late stage failure after unload disposes without persisting a degraded artifact', () => {
		for (const late of ['stageThrew', 'degraded'] as const) {
			const start = stateFor('COMPILING');
			const { state, effects } = drive(start, [{ type: 'unload' }, { type: 'ok' }, { type: late }]);
			expect(state.phase).toBe('DISPOSED');
			expect(kinds(effects)).toEqual(['release', 'transform', 'settle']);
		}
	});

	it('a late error after unload disposes quietly — no card into a dead DOM', () => {
		const { state, effects } = drive(stateFor('COMPILING'), [
			{ type: 'unload' },
			{ type: 'err', reason: 'tex-error' },
		]);
		expect(state.phase).toBe('DISPOSED');
		expect(kinds(effects)).toEqual(['release', 'settle']);
	});

	it('a late timeout after unload still terminates the worker and poisons the key', () => {
		const { state, effects } = drive(stateFor('COMPILING'), [{ type: 'unload' }, { type: 'timeout' }]);
		expect(state.phase).toBe('DISPOSED');
		expect(kinds(effects)).toEqual(['release', 'terminateWorker', 'poison', 'settle']);
	});
});

// -------------------------------------------------------------------------------------------
// Interruption

describe('a job interrupted through no fault of its own', () => {
	/**
	 * The engine was killed under it — the app was backgrounded, the engine restarted — so the
	 * diagram did nothing wrong and nothing is known against it. It used to arrive as a timeout:
	 * an error card telling the user to simplify a diagram that never got to run.
	 *
	 * It goes back `resumed`: the queue had let it in once, so it neither counts against the cap
	 * nor can be turned away by it, which it was when it came back into a full queue.
	 */
	it('COMPILING + interrupted -> SCHEDULING again, at the band it had, with no card', () => {
		const compiling = drive(initialState(), [
			...TO_DEBOUNCING,
			{ type: 'timer', priority: 2 },
			{ type: 'slot' },
		]).state;
		const [state, fx] = reduce(compiling, { type: 'interrupted' });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 2 });
		expect(fx).toEqual([{ kind: 'submit', priority: 2, resumed: true }]);
		expect(state.settled).toBe(false);
	});

	it('an interrupted block that was unloaded just goes away', () => {
		const { state, effects } = drive(stateFor('COMPILING'), [
			{ type: 'unload' },
			{ type: 'interrupted' },
		]);
		expect(state.phase).toBe('DISPOSED');
		expect(kinds(effects)).toEqual(['release', 'settle']);
	});

	it('a block still waiting for its slot is re-submitted, not stranded', () => {
		const [state, fx] = reduce(stateFor('SCHEDULING'), { type: 'interrupted' });
		expect(state.phase).toBe('SCHEDULING');
		expect(fx).toEqual([{ kind: 'submit', priority: 1, resumed: true }]);
	});

	it('is a no-op everywhere a job is not in flight', () => {
		for (const phase of ['MOUNTED', 'FAILED', 'IDLE_MANUAL', 'TRANSFORMING'] as Phase[]) {
			const before = stateFor(phase);
			expect(reduce(before, { type: 'interrupted' })[0]).toBe(before);
		}
	});
});

// -------------------------------------------------------------------------------------------
// Unknown events

describe('unknown events', () => {
	const ALL_EVENTS: Event[] = [
		{ type: 'load' },
		{ type: 'emptySource' },
		{ type: 'preflightError' },
		{ type: 'l1Hit' },
		{ type: 'l1Miss' },
		{ type: 'hit', tier: 'l2' },
		{ type: 'hit', tier: 'l3' },
		{ type: 'miss' },
		{ type: 'intersect' },
		{ type: 'noRecordsAfter2s' },
		{ type: 'timer', priority: 1 },
		{ type: 'slot' },
		{ type: 'rejected', reason: 'depthCap' },
		{ type: 'rejected', reason: 'tex-error' },
		{ type: 'ok' },
		{ type: 'err', reason: 'tex-error' },
		{ type: 'timeout' },
		{ type: 'interrupted' },
		{ type: 'stageThrew' },
		{ type: 'degraded' },
		{ type: 'mounted' },
		{ type: 'cssChange' },
		{ type: 'retry' },
	];

	it('never throw, and a no-op returns the identical state object', () => {
		for (const [phase] of REACHABLE) {
			const before = stateFor(phase);
			for (const event of ALL_EVENTS) {
				const [after, fx] = reduce(before, event);
				if (after === before) {
					expect(fx).toEqual([]);
				} else if (fx.length === 0) {
					// A real transition must have changed something observable: the state, or — an
					// interrupted block put back in line at the band it had — what it does next.
					expect(after).not.toEqual(before);
				}
			}
		}
	});

	it('DISPOSED absorbs everything, including a second unload', () => {
		const disposed = stateFor('DISPOSED');
		for (const event of [...ALL_EVENTS, { type: 'unload' } as Event]) {
			const [after, fx] = reduce(disposed, event);
			expect(after).toBe(disposed);
			expect(fx).toEqual([]);
		}
	});

	it('an event with a payload that does not apply is still inert', () => {
		// `hit` belongs to LOOKUP only; arriving late in MOUNTED must not re-enter the pipeline.
		const mounted = stateFor('MOUNTED');
		expect(reduce(mounted, { type: 'hit', tier: 'l3' })[0]).toBe(mounted);
		expect(reduce(mounted, { type: 'ok' })[0]).toBe(mounted);
	});
});

// -------------------------------------------------------------------------------------------
// The settle invariant

describe('the settle invariant', () => {
	it('settle is always the last effect of its batch', () => {
		// The promise resolving tells Obsidian the section DOM is final, so whatever paints it has
		// to be ahead of it in the list.
		const batches: Effect[][] = [
			reduce(stateFor('KEYING'), { type: 'l1Hit' })[1],
			reduce(stateFor('COMPILING'), { type: 'timeout' })[1],
			reduce(stateFor('MOUNTING'), { type: 'mounted' })[1],
			reduce(stateFor('GATING'), { type: 'unload' })[1],
			reduce(stateFor('LOOKUP'), { type: 'miss', lazy: 'manual' })[1],
		];
		for (const fx of batches) {
			expect(countSettles(fx)).toBe(1);
			expect(fx[fx.length - 1]).toEqual({ kind: 'settle' });
		}
	});

	it('a resting IDLE_MANUAL settles, so a manual block never strands Promise.all', () => {
		const [state, fx] = reduce(stateFor('LOOKUP'), { type: 'miss', lazy: 'manual' });
		expect(state.settled).toBe(true);
		expect(countSettles(fx)).toBe(1);
	});

	it('a retried failure that finally mounts settles exactly once, at the failure', () => {
		const { state, effects } = drive(initialState(), [
			...TO_COMPILING,
			{ type: 'timeout' },
			{ type: 'retry' },
			{ type: 'slot' },
			{ type: 'ok' },
			{ type: 'ok' },
			{ type: 'mounted' },
		]);
		expect(state.phase).toBe('MOUNTED');
		expect(countSettles(effects)).toBe(1);
		expect(kinds(effects).indexOf('settle')).toBeLessThan(kinds(effects).indexOf('unpoison'));
	});

	it('unloading an already-mounted block does not settle a second time', () => {
		const { state, effects } = drive(initialState(), [
			...TO_MOUNTING,
			{ type: 'mounted' },
			{ type: 'unload' },
		]);
		expect(state.phase).toBe('DISPOSED');
		expect(countSettles(effects)).toBe(1);
	});

	it('re-entering a terminal phase emits none', () => {
		const failed = drive(initialState(), [...LOAD, { type: 'emptySource' }]);
		expect(countSettles(failed.effects)).toBe(1);
		// FAILED -> retry -> ... -> FAILED again.
		const again = drive(failed.state, [
			{ type: 'retry' },
			{ type: 'slot' },
			{ type: 'err', reason: 'capacity' },
		]);
		expect(again.state.phase).toBe('FAILED');
		expect(countSettles(again.effects)).toBe(0);
	});
});

// -------------------------------------------------------------------------------------------
// Property test
//
// Math.random is banned: a failing seed has to be reproducible, and a state machine whose
// invariant only holds "usually" is worthless.

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PRIORITIES: Priority[] = [0, 1, 2, 3];
const ERROR_KINDS = ['tex-error', 'missing-file', 'capacity', 'empty-output', 'engine-unavailable'] as const;
const LAZY = ['on', 'off', 'manual'] as const;

/** Every event, including the ones that make no sense where they land. That is the point. */
function randomEvent(rnd: () => number): Event {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
	const n = Math.floor(rnd() * 24);
	switch (n) {
		case 0:
			return { type: 'load' };
		case 1:
			return { type: 'emptySource' };
		case 2:
			return { type: 'preflightError' };
		case 3:
			return { type: 'l1Hit' };
		case 4:
			return { type: 'l1Miss' };
		case 5:
			return { type: 'hit', tier: rnd() < 0.5 ? 'l2' : 'l3' };
		case 6:
			return {
				type: 'miss',
				isExport: rnd() < 0.2,
				poisoned: rnd() < 0.2,
				lazy: pick(LAZY),
				depthCapped: rnd() < 0.2,
				editing: rnd() < 0.5,
			};
		case 7:
			return { type: 'intersect' };
		case 8:
			return { type: 'noRecordsAfter2s' };
		case 9:
			return { type: 'timer', priority: pick(PRIORITIES) };
		case 10:
			return { type: 'slot' };
		case 11:
		case 12:
			return { type: 'ok' };
		case 13:
			return { type: 'err', reason: pick(ERROR_KINDS) };
		case 14:
			return { type: 'timeout' };
		case 20:
			return { type: 'interrupted' };
		case 15:
			return { type: 'stageThrew' };
		case 21:
			return { type: 'degraded' };
		case 16:
			return { type: 'mounted' };
		case 17:
			return { type: 'cssChange' };
		case 18:
			return { type: 'retry' };
		case 19:
			return { type: 'rejected', reason: rnd() < 0.5 ? 'depthCap' : pick(ERROR_KINDS) };
		case 22:
			return { type: 'expired' };
		default:
			// Weighted up: unload at every point, and duplicated, is the interesting axis.
			return { type: 'unload' };
	}
}

describe('property: exactly one settle, over randomised event sequences', () => {
	it('holds for 2000 seeded sequences, each drained to a terminal state', () => {
		const visited = new Set<Phase>();

		for (let seed = 1; seed <= 2000; seed++) {
			const rnd = mulberry32(seed);
			const length = 3 + Math.floor(rnd() * 25);

			// Start from a real prefix of a real path, then go random. Pure random walks reach
			// KEYING and LOOKUP easily and the deep phases almost never, which would make the
			// invariant look proven while most of the machine was never entered.
			const path = REACHABLE[Math.floor(rnd() * REACHABLE.length)]?.[1] ?? [];
			const events: Event[] = path.slice(0, Math.ceil(rnd() * path.length));

			for (let i = 0; i < length; i++) {
				// 25% unload, so abort/late-event interleavings are common rather than rare.
				events.push(rnd() < 0.25 ? { type: 'unload' } : randomEvent(rnd));
			}
			// Drain: `timeout` is the backstop that always ends a started compile, `unload` ends
			// everything else. After these two, no reachable phase is still pending.
			events.push({ type: 'timeout' }, { type: 'unload' });

			let state = initialState();
			const effects: Effect[] = [];
			let settles = 0;
			let unloadedAt = -1;

			events.forEach((event, i) => {
				const before = state;
				const [next, fx] = reduce(before, event);

				if (before.phase === 'DISPOSED') {
					expect(fx, `seed ${seed}: effects emitted after DISPOSED`).toEqual([]);
					expect(next).toBe(before);
				}
				// The one documented exception: a started job is never aborted out from under us.
				if (before.phase === 'COMPILING') {
					expect(kinds(fx), `seed ${seed}: aborted a running compile`).not.toContain('abort');
				}

				for (const effect of fx) {
					if (effect.kind === 'settle') {
						settles++;
						expect(effect, `seed ${seed}: settle was not last in its batch`).toBe(
							fx[fx.length - 1],
						);
						expect(
							SETTLING.has(next.phase),
							`seed ${seed}: settled on entry to ${next.phase}`,
						).toBe(true);
					}
					// Nothing may paint into a DOM the child no longer owns.
					if (unloadedAt >= 0 && i > unloadedAt) {
						expect(
							['mount', 'mountErrorCard', 'mountManualButton', 'paintPlaceholder', 'measure'],
							`seed ${seed}: ${effect.kind} after unload`,
						).not.toContain(effect.kind);
					}
				}

				if (event.type === 'unload' && unloadedAt < 0 && before.phase !== 'DISPOSED') unloadedAt = i;
				effects.push(...fx);
				state = next;
				visited.add(state.phase);
			});

			expect(settles, `seed ${seed}: settle count`).toBe(1);
			expect(countSettles(effects)).toBe(1);
			expect(state.phase, `seed ${seed}: not drained`).toBe('DISPOSED');
			expect(state.settled).toBe(true);
		}

		// A property test that never reaches most of the machine proves nothing about it.
		for (const phase of ALL_PHASES) {
			expect(visited, `random walk never reached ${phase}`).toContain(phase);
		}
	});

	it('debounces only a block being typed in, over 2000 seeded sequences', () => {
		// The same random walks as above, with every cache miss said to be of a note nobody is typing
		// in, or of one being typed in. In the first, no path may start the debounce, however the
		// events land; in the second, a block passing the gate always waits for it.
		const passed = { fresh: 0, typed: 0 };
		for (let seed = 1; seed <= 2000; seed++) {
			const rnd = mulberry32(seed);
			const editing = seed % 2 === 0;
			// A real prefix first, as above, so that the gate is actually reached.
			const path = REACHABLE[Math.floor(rnd() * REACHABLE.length)]?.[1] ?? [];
			const events: Event[] = path.slice(0, Math.ceil(rnd() * path.length));
			const length = 3 + Math.floor(rnd() * 25);
			for (let i = 0; i < length; i++)
				events.push(rnd() < 0.25 ? { type: 'unload' } : randomEvent(rnd));

			let state = initialState();
			for (const raw of events) {
				const event: Event = raw.type === 'miss' ? { ...raw, editing } : raw;
				const [next, fx] = reduce(state, event);
				if (!editing) {
					expect(kinds(fx), `seed ${seed}: debounced a block nobody is typing in`).not.toContain(
						'startDebounce',
					);
				}
				if (state.phase === 'GATING' && event.type === 'intersect') {
					passed[editing ? 'typed' : 'fresh']++;
					expect(kinds(fx), `seed ${seed}`).toContain(editing ? 'startDebounce' : 'submit');
				}
				state = next;
			}
		}
		expect(passed.fresh, 'blocks nobody is typing in that passed the gate').toBeGreaterThan(50);
		expect(passed.typed, 'blocks being typed in that passed the gate').toBeGreaterThan(50);
	});

	it('never settles twice even when the same event is delivered repeatedly', () => {
		for (const [phase, path] of REACHABLE) {
			for (const event of [
				{ type: 'unload' } as Event,
				{ type: 'ok' } as Event,
				{ type: 'timeout' } as Event,
				{ type: 'interrupted' } as Event,
				{ type: 'expired' } as Event,
				{ type: 'mounted' } as Event,
				{ type: 'retry' } as Event,
			]) {
				const repeated = Array.from({ length: 8 }, () => event);
				const { effects } = drive(initialState(), [
					...path,
					...repeated,
					{ type: 'timeout' },
					{ type: 'unload' },
				]);
				expect(countSettles(effects), `${phase} + repeated ${event.type}`).toBe(1);
			}
		}
	});
});

const SETTLING: ReadonlySet<Phase> = new Set<Phase>([
	'MOUNTED',
	'MOUNTED_DEGRADED',
	'IDLE_MANUAL',
	'FAILED',
	'DISPOSED',
]);

const ALL_PHASES: Phase[] = [
	'INIT',
	'KEYING',
	'LOOKUP',
	'GATING',
	'DEBOUNCING',
	'SCHEDULING',
	'COMPILING',
	'TRANSFORMING',
	'MOUNTING',
	'MOUNTED',
	'MOUNTED_DEGRADED',
	'IDLE_MANUAL',
	'FAILED',
	'DISPOSED',
];

// -------------------------------------------------------------------------------------------
// Queue rejections
//
// `RenderQueue` (src/queue/queue.ts) settles `submit` four ways: `timeout`, `poisoned`,
// `depth-cap`, `cancelled`. Only `timeout` happens after the job started, so only `timeout`
// reaches a COMPILING block. The other three settle the submit promise WITHOUT ever calling
// `run`, i.e. while the block is still in SCHEDULING — and neither `slot` nor a job result will
// ever come. That is a stranded processor promise, which is the whole failure class this module
// exists to close.

describe('a queue rejection before the job starts', () => {
	it('SCHEDULING + rejected(depthCap) -> IDLE_MANUAL, the button the queue promises', () => {
		const [state, fx] = reduce(stateFor('SCHEDULING'), { type: 'rejected', reason: 'depthCap' });
		expect(state).toMatchObject({ phase: 'IDLE_MANUAL', reason: 'depthCap' });
		expect(kinds(fx)).toEqual(['mountManualButton', 'settle']);
	});

	it('SCHEDULING + rejected(poisoned) -> FAILED, not a silent stall', () => {
		// Two copies of one diagram: the first times out and poisons the key, the second's
		// debounce fires afterwards and `submit` is refused at the door. Nothing about that is
		// visible at LOOKUP time, so `miss.poisoned` cannot cover it.
		const [state, fx] = reduce(stateFor('SCHEDULING'), { type: 'rejected', reason: 'poisoned' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'poisoned' });
		expect(kinds(fx)).toEqual(['mountErrorCard', 'settle']);
	});

	it('every pre-start rejection settles the block WITHOUT an unload', () => {
		// The property test drains with `unload`, which settles everything — so it cannot see a
		// phase that strands on its own. This is the requirement stated without that crutch.
		const reasons: Array<'depthCap' | FailureReason> = [
			'depthCap',
			'poisoned',
			'timeout',
			'engine-unavailable',
		];
		for (const reason of reasons) {
			const { state, effects } = drive(initialState(), [
				...TO_SCHEDULING,
				{ type: 'rejected', reason },
			]);
			expect(state.settled, `rejected(${reason}) never settled`).toBe(true);
			expect(countSettles(effects), `rejected(${reason}) settle count`).toBe(1);
			expect(state.phase).not.toBe('SCHEDULING');
		}
	});

	it('the depth-capped block can be retried from its button', () => {
		const capped = reduce(stateFor('SCHEDULING'), { type: 'rejected', reason: 'depthCap' })[0];
		const [state, fx] = reduce(capped, { type: 'retry' });
		expect(state).toMatchObject({ phase: 'SCHEDULING', priority: 1 });
		expect(fx).toEqual([{ kind: 'paintPlaceholder' }, { kind: 'submit', priority: 1 }]);
	});

	it('a settlement that arrives without a `slot` still leaves SCHEDULING', () => {
		// The queue tells every owner when a shared job starts, but SCHEDULING used to wait for
		// that word and nothing else: a block that missed it ignored its own result and sat in
		// SCHEDULING forever, unsettled. A settlement is proof the job ran.
		const ok = drive(initialState(), [...TO_SCHEDULING, { type: 'ok' }]);
		expect(ok.state).toMatchObject({ phase: 'TRANSFORMING', origin: 'render' });
		expect(kinds(ok.effects)).toContain('transform');

		const err = drive(initialState(), [...TO_SCHEDULING, { type: 'err', reason: 'tex-error' }]);
		expect(err.state).toMatchObject({ phase: 'FAILED', reason: 'tex-error' });
		expect(countSettles(err.effects)).toBe(1);

		const [timedOut, fx] = reduce(stateFor('SCHEDULING'), { type: 'timeout' });
		expect(timedOut).toMatchObject({ phase: 'FAILED', reason: 'timeout' });
		expect(kinds(fx)).toEqual(['terminateWorker', 'poison', 'mountErrorCard', 'settle']);
	});

	it('a rejection arriving after the job started is not a pre-start rejection', () => {
		// COMPILING owns `ok` / `err` / `timeout`; funnelling a late queue error through
		// `rejected` must not quietly bypass terminateWorker + poison.
		const compiling = stateFor('COMPILING');
		expect(reduce(compiling, { type: 'rejected', reason: 'timeout' })[0]).toBe(compiling);
	});

	it('COMPILING, unloaded + rejected -> DISPOSED: the queue dropped a job the engine never had', () => {
		// Every block that wanted it let go while it waited for the engine to start (D25). The
		// unloaded block has settled nowhere yet, and must, once.
		const [unloaded, released] = reduce(stateFor('COMPILING'), { type: 'unload' });
		expect(kinds(released)).toEqual(['release']);
		const [state, fx] = reduce(unloaded, { type: 'rejected', reason: 'depthCap' });
		expect(state.phase).toBe('DISPOSED');
		expect(countSettles(fx)).toBe(1);
	});
});

// -------------------------------------------------------------------------------------------
// The total export budget

describe('an export that ran out of time', () => {
	/**
	 * Obsidian's PDF export waits on every block's promise and has no timeout of its own. Without
	 * a total budget, a note with forty uncached diagrams held "Preparing PDF" for forty compiles.
	 */
	it('SCHEDULING + expired -> FAILED(export-budget): the block gives up its place and settles', () => {
		const scheduled = drive(initialState(), [...TO_LOOKUP, { type: 'miss', isExport: true }]).state;
		const [state, fx] = reduce(scheduled, { type: 'expired' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'export-budget' });
		expect(kinds(fx)).toEqual(['release', 'mountErrorCard', 'settle']);
	});

	it('COMPILING + expired -> FAILED(export-budget), without aborting the compile', () => {
		const [state, fx] = reduce(stateFor('COMPILING'), { type: 'expired' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'export-budget' });
		expect(kinds(fx)).toEqual(['release', 'mountErrorCard', 'settle']);
		expect(kinds(fx)).not.toContain('abort');
	});

	it('LOOKUP + expired -> FAILED(export-budget), and the late answer is ignored', () => {
		const [state, fx] = reduce(stateFor('LOOKUP'), { type: 'expired' });
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'export-budget' });
		expect(kinds(fx)).toEqual(['mountErrorCard', 'settle']);
		expect(reduce(state, { type: 'hit', tier: 'l2' })[0]).toBe(state);
	});

	it('a compile it gave up on cannot paint over the card when it finishes', () => {
		const { state, effects } = drive(initialState(), [
			...TO_COMPILING,
			{ type: 'expired' },
			{ type: 'ok' },
			{ type: 'timeout' },
		]);
		expect(state).toMatchObject({ phase: 'FAILED', reason: 'export-budget' });
		expect(kinds(effects)).not.toContain('mount');
		expect(countSettles(effects)).toBe(1);
	});

	it('an unloaded compile just ends', () => {
		const unloaded = reduce(stateFor('COMPILING'), { type: 'unload' })[0];
		const [state, fx] = reduce(unloaded, { type: 'expired' });
		expect(state.phase).toBe('DISPOSED');
		expect(kinds(fx)).toEqual(['settle']);
	});

	it('changes nothing for a block that is already done, or never started', () => {
		for (const phase of ['MOUNTED', 'FAILED', 'IDLE_MANUAL', 'GATING', 'DEBOUNCING'] as const) {
			const state = stateFor(phase);
			expect(reduce(state, { type: 'expired' })[0], phase).toBe(state);
		}
	});
});

// -------------------------------------------------------------------------------------------
// L3 import

describe('an L3 hit is not an artifact yet', () => {
	it('does not write the legacy record into L1 before the pipeline has run', () => {
		const [state, fx] = reduce(stateFor('LOOKUP'), { type: 'hit', tier: 'l3' });
		expect(state).toMatchObject({ phase: 'TRANSFORMING', origin: 'l3' });
		// L1 and L2 hold the FINAL post-processed artifact (§6.2); a legacy record is the raw,
		// pre-SVGO, pgf-id-baked SVG the old bundle stored before it dispatched its event (§8.3).
		// Promoting it here would make the next block with this key take `l1Hit` straight to
		// MOUNTED and paint that raw SVG — #15 and #12 at once, and past the mandatory sanitize
		// stage (§7.2). The import happens at TRANSFORMING + ok, via `persist`.
		expect(kinds(fx)).not.toContain('promote');
		expect(kinds(fx)).toEqual(['transform']);

		const [, imported] = reduce(state, { type: 'ok' });
		expect(kinds(imported)).toContain('persist');
	});

	it('an L2 hit still promotes: that record already is the artifact', () => {
		const [, fx] = reduce(stateFor('LOOKUP'), { type: 'hit', tier: 'l2' });
		expect(fx).toEqual([
			{ kind: 'promote', tier: 'l2' },
			{ kind: 'mount', degraded: false },
		]);
	});
});
