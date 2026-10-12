/**
 * The bounded render queue. See internal/DESIGN.md §5.1 and §5.3.
 *
 * Pure by construction: no DOM, no `obsidian`, no wall clock, no ambient `setTimeout`. Timers come
 * in through `opts.timers` and FIFO order comes from a monotonic counter rather than a clock, so
 * every ordering, timeout and cancellation path in here is exercisable in Node against a fake.
 *
 * The failure this module exists to make structurally impossible: the shipped plugin has no slot
 * accounting at all, so one wedged render blocks every later diagram until Obsidian restarts
 * (upstream #18 #23 #27 #39 #51 #82 #85 #89, ~22 reporters). Here the `finally` that frees a slot
 * is attached to the *race*, not to the job — so a compile that never settles costs one slot for
 * `startupMs + timeoutMs` and nothing afterwards.
 *
 * A job's time is counted in two parts. `timeoutMs` is the diagram's own budget, and it starts when
 * the runner says the job has reached the engine (`running`), not when the queue hands it over:
 * booting the engine is not the diagram's work, and on a phone it is seconds of it. Until then the
 * job is in its startup, bounded by `startupMs`; one that never gets there is `stalled`, which
 * says nothing about the diagram and so poisons nothing.
 */

/** 0 export/print · 1 visible · 2 within rootMargin · 3 prefetch / manual / zero-record fallback. */
export type Priority = 0 | 1 | 2 | 3;

/**
 * The timer seam. Ids are numbers because the browser's `setTimeout` returns one; a Node caller
 * supplies its own counter rather than a `NodeJS.Timeout`, which is also why tsconfig sets
 * `types: []`.
 */
export interface QueueTimers {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

export type QueueRejectionKind =
	/** Outlived `timeoutMs`. The job's signal is aborted and its key is poisoned for the session. */
	| 'timeout'
	/**
	 * Started, but never reached the engine within `startupMs`: the engine did not come up. The
	 * job's signal is aborted so the runner can stop waiting on it; the key is NOT poisoned,
	 * because the diagram never ran.
	 */
	| 'stalled'
	/** Refused at the door: this key timed out earlier this session, so `run` was never called. */
	| 'poisoned'
	/** The queue was over its depth cap and this was the least urgent job waiting in it. */
	| 'depth-cap'
	/** Released by its last holder before it started, or dropped because the queue was closed. */
	| 'cancelled';

/**
 * Distinguishable so the caller can branch on a kind rather than parse a message: `depth-cap` and
 * `cancelled` mount a "Render diagram" button; `timeout`, `stalled` and `poisoned` mount an error
 * card, each with its own copy.
 */
export class QueueError extends Error {
	readonly kind: QueueRejectionKind;
	readonly key: string;

	// Not parameter properties: `erasableSyntaxOnly` forbids them.
	constructor(kind: QueueRejectionKind, key: string, message?: string) {
		super(message ?? `${kind}: ${key}`);
		this.name = 'QueueError';
		this.kind = kind;
		this.key = key;
	}
}

export function isQueueError(error: unknown, kind?: QueueRejectionKind): error is QueueError {
	return error instanceof QueueError && (kind === undefined || error.kind === kind);
}

/**
 * Tell one caller its job started. A notification is the caller's own business: one that throws
 * must not fail a job other callers share, nor leave the queue's bookkeeping half-done.
 */
function notify(onStart: (() => void) | undefined): void {
	try {
		onStart?.();
	} catch {
		// Deliberately swallowed; see above.
	}
}

export interface SubmitOptions {
	/**
	 * Identifies the caller, so a release can be matched to the submission that made it.
	 *
	 * Pass the render child itself. Omitting it falls back to an anonymous token, which is the old
	 * "one release means one fewer caller" behaviour — correct while every caller is well behaved,
	 * and wrong exactly when one is not (see Entry.owners).
	 */
	owner?: unknown;

	/**
	 * Try a key the poison set has already refused.
	 *
	 * Export/print only: §3.3's `miss()` fan-out deliberately puts export *ahead* of poison, so a PDF
	 * gets one more attempt at a diagram rather than a card. It does not emit an `unpoison` first: a
	 * real unpoison re-offers the key to every ordinary block, and only the user's own Retry — on a
	 * card that says the diagram timed out — should do that. Refusing the export at the door used to
	 * strand that block in SCHEDULING with "Preparing PDF" hanging; SCHEDULING now handles the
	 * refusal, but the export would still print a card it did not need to.
	 *
	 * Deliberately NOT inferred from `priority === 0`: `fast` also promotes a block one band (§7), so
	 * band 0 is not synonymous with export and a fast block must stay refused.
	 */
	ignorePoison?: boolean | undefined;

	/**
	 * Never evicted by the depth cap, and not counted against it.
	 *
	 * Export/print only, and bounded by the export's own total budget rather than by the cap. An
	 * export of a note with more uncached diagrams than the cap (16 on a phone) used to have its
	 * newest jobs evicted like any others, and an evicted block rests on a "Render diagram" button
	 * — which is what the PDF then contained. A caller joining a job with this set protects it too.
	 */
	uncapped?: boolean | undefined;

	/**
	 * The caller's job had started and the engine was stopped under it: this is that job going back
	 * in line, not new work.
	 *
	 * It was let in once, so the depth cap neither counts it nor turns it away, and it goes ahead of
	 * its band rather than behind the jobs that were waiting while it ran. On a phone the queue is
	 * paused before the worker is killed, so nothing starts in between, and the job used to come
	 * back into a waiting list that was still full, as its newest entry — the one the cap evicts:
	 * the diagram that was compiling turned into a "Render diagram" button. There is at most one
	 * such job per slot, so the cap is never passed by more than the concurrency.
	 */
	resumed?: boolean | undefined;

	/**
	 * Called once when the job this caller is waiting for starts — at once, if it already has.
	 *
	 * Per caller, not per job, because dedup gives every caller of a key the FIRST caller's job. The
	 * notification used to ride on that job object, so only the first caller ever heard; a second
	 * block on the same key waited in SCHEDULING for a word that never came, and never settled. A
	 * caller that releases before the start is not told.
	 */
	onStart?: (() => void) | undefined;
}

export interface RenderQueueOptions<J, T> {
	concurrency: number;
	depthCap: number;
	/**
	 * Do the job. Call `running` once it has reached whatever actually runs it: that is when its
	 * `timeoutMs` starts. Called any later, or more than once, it is ignored.
	 */
	run: (job: J, signal: AbortSignal, running: () => void) => Promise<T>;
	timers: QueueTimers;
	/**
	 * How long a started job may take to call `running` before it is given up as `stalled`.
	 *
	 * Omitted: no startup at all — the job is running from the moment it starts, which is right
	 * for a runner with nothing to wait for.
	 */
	startupMs?: number | undefined;
}

interface Entry<J, T> {
	key: string;
	job: J;
	priority: Priority;
	timeoutMs: number;
	/** Monotonic submission order: the FIFO tiebreak inside a priority band. Never a timestamp. */
	seq: number;
	/**
	 * Who still wants this result. At zero an unstarted job is dropped.
	 *
	 * A SET of owner tokens rather than a counter, because a counter cannot tell one caller's
	 * release from another's. Review found the failure: blocks A and B submit K (refs 2); the job
	 * settles and the entry is deleted; block C later submits K afresh (refs 1) and queues behind
	 * other work; block A then unloads and calls release('K'), which decrements C's brand-new entry
	 * to zero and cancels a job C is still waiting for. Owners make a stale release a no-op — it
	 * names a caller this entry never had.
	 *
	 * Callers that pass no owner fall back to an anonymous token, i.e. the old counting behaviour,
	 * so a release without an owner still means "one fewer caller".
	 *
	 * Each owner maps to its own start notification (SubmitOptions.onStart).
	 */
	owners: Map<unknown, (() => void) | undefined>;
	/** Some caller submitted it `uncapped` or `resumed`: the depth cap neither evicts it nor counts it. */
	uncapped: boolean;
	started: boolean;
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

/** Folded rather than thrown, so the losing side of the race can never be an unhandled rejection. */
type Outcome<T> =
	{ kind: 'ok'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'stalled' };

export class RenderQueue<J, T> {
	private readonly concurrency: number;
	private readonly depthCap: number;
	private readonly run: (job: J, signal: AbortSignal, running: () => void) => Promise<T>;
	private readonly timers: QueueTimers;
	private readonly startupMs: number | undefined;

	/** Every live key, pending or started. This map is what makes dedup work across both states. */
	private readonly entries = new Map<string, Entry<J, T>>();
	private readonly pending: Entry<J, T>[] = [];
	private readonly poisoned = new Set<string>();

	private inflight = 0;
	private seq = 0;
	/**
	 * The `seq` of a resumed job: counting up from far below any other, so each goes ahead of its
	 * band and the resumed keep their own order among themselves.
	 */
	private resumedSeq = Number.MIN_SAFE_INTEGER;
	private paused = false;
	private closed = false;

	constructor(opts: RenderQueueOptions<J, T>) {
		this.concurrency = Math.max(1, Math.floor(opts.concurrency));
		this.depthCap = Math.max(1, Math.floor(opts.depthCap));
		this.run = opts.run;
		this.timers = opts.timers;
		this.startupMs = opts.startupMs;
	}

	/**
	 * Jobs waiting for a slot. Started jobs are not counted; the depth cap is over this number,
	 * less the jobs submitted `uncapped`.
	 */
	size(): number {
		return this.pending.length;
	}

	/**
	 * Occupied slots — not live `run` promises. A timed-out job gives its slot back immediately
	 * even though the compile behind it may still be running; that gap is the whole point.
	 */
	inflightCount(): number {
		return this.inflight;
	}

	isPoisoned(key: string): boolean {
		return this.poisoned.has(key);
	}

	/**
	 * Cleared by Retry (for that key), by any change saved in the settings tab, by "Restart the TeX
	 * engine" and on unload. Never persisted, so a reload clears it too.
	 */
	clearPoison(key?: string): void {
		if (key === undefined) this.poisoned.clear();
		else this.poisoned.delete(key);
	}

	/**
	 * Start nothing new until `resume`. A job already started carries on; submissions still queue.
	 *
	 * For the phone being backgrounded: the worker is killed to give its memory back, the job that
	 * was in it is resubmitted by its block, and starting it straight away would boot a fresh
	 * worker in the background — undoing the very thing the kill was for.
	 */
	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		this.pump();
	}

	/**
	 * Refuse everything from here on, and drop everything not yet started: the plugin is unloading.
	 *
	 * Without it, the job that unloading interrupts frees its slot in a `finally` that starts the
	 * next one, and that one boots a worker nothing will ever terminate. Jobs already started are
	 * left to the runner, whose own teardown settles them.
	 */
	close(): void {
		this.closed = true;
		for (const entry of this.pending.splice(0)) {
			this.entries.delete(entry.key);
			entry.reject(
				new QueueError('cancelled', entry.key, `${entry.key} was dropped: the plugin is unloading`),
			);
		}
	}

	submit(key: string, job: J, priority: Priority, timeoutMs: number, opts?: SubmitOptions): Promise<T> {
		// A distinct token per anonymous submission, so two anonymous callers still count as two.
		const owner = opts?.owner ?? Symbol('tikz-anonymous-owner');

		if (this.closed) {
			return Promise.reject(
				new QueueError('cancelled', key, `${key} was refused: the plugin is unloading`),
			);
		}

		if (opts?.ignorePoison !== true && this.poisoned.has(key)) {
			return Promise.reject(
				new QueueError(
					'poisoned',
					key,
					`${key} timed out earlier this session and will not be retried`,
				),
			);
		}

		const existing = this.entries.get(key);
		if (existing !== undefined) {
			// The same diagram in two panes, or twice in one note: one compile, two resolutions.
			existing.owners.set(owner, opts?.onStart);
			if (existing.started) notify(opts?.onStart);
			// A block queued as a prefetch and then scrolled into view must not wait out the rest of
			// the prefetch band, so the shared job takes the most urgent caller's priority and the
			// most generous caller's timeout (export's 30 s must not be cut to a visible block's
			// 10 s). `seq` deliberately does not move: promotion may not reorder a band against a
			// job submitted before this one. Priority stops mattering once the job has started; the
			// timeout does not, and `start` re-arms its timer to honour a raise.
			if (priority < existing.priority) existing.priority = priority;
			if (timeoutMs > existing.timeoutMs) existing.timeoutMs = timeoutMs;
			if (opts?.uncapped === true || opts?.resumed === true) existing.uncapped = true;
			return existing.promise;
		}

		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		const resumed = opts?.resumed === true;
		const entry: Entry<J, T> = {
			key,
			job,
			priority,
			timeoutMs,
			seq: resumed ? this.resumedSeq++ : this.seq++,
			owners: new Map([[owner, opts?.onStart]]),
			uncapped: opts?.uncapped === true || resumed,
			started: false,
			promise,
			resolve,
			reject,
		};

		this.entries.set(key, entry);
		this.pending.push(entry);

		// Pump before the cap check so a job that can start right now is never counted as queue
		// depth, and a depthCap of 1 still saturates every slot.
		this.pump();
		this.enforceDepthCap();

		return promise;
	}

	/**
	 * Drop one caller's interest in `key`.
	 *
	 * At zero refs an unstarted job is dropped and its promise rejects with `cancelled` — it never
	 * hangs, because a promise that never settles is the bug class this whole module is about. A
	 * STARTED job is left to finish: we have already paid for the compile and the result still
	 * reaches the cache, so the next mount of that key is free.
	 *
	 * The refcount is per KEY, not per submission, so a release is only meaningful while the caller's
	 * own job is still live. A holder that releases a key long after that job settled — and after
	 * some other block has resubmitted the same key — would cancel the newcomer's job instead of its
	 * own. `machine.ts` is safe by construction (it emits `release` only from SCHEDULING and
	 * COMPILING, and latches `unloaded` so it cannot emit twice); any other caller must keep that
	 * property, because the queue has no submission handle with which to tell the generations apart.
	 */
	release(key: string, owner?: unknown): void {
		const entry = this.entries.get(key);
		if (entry === undefined) return;

		if (owner === undefined) {
			// Anonymous release: drop any one owner, preserving the old counting semantics.
			const first = entry.owners.keys().next();
			if (!first.done) entry.owners.delete(first.value);
		} else if (!entry.owners.delete(owner)) {
			// This owner never held this entry — a release arriving after its own job settled and a
			// different caller re-submitted the key. Ignoring it is the whole point.
			return;
		}

		if (entry.owners.size > 0) return;
		if (entry.started) return;

		this.drop(entry);
		this.entries.delete(key);
		entry.reject(new QueueError('cancelled', key, `${key} was released before it started`));
	}

	private pump(): void {
		while (!this.paused && !this.closed && this.inflight < this.concurrency) {
			const entry = this.nextToStart();
			if (entry === undefined) return;
			this.drop(entry);
			entry.started = true;
			void this.start(entry);
		}
	}

	private async start(entry: Entry<J, T>): Promise<void> {
		this.inflight += 1;
		const controller = new AbortController();
		let timerId: number | undefined;
		let done = false;
		let running = false;

		// §5.3: a bare setTimeout around the await is not enough — `Worker.terminate()` fires no
		// message, so the pending deferred inside the host never settles and the await hangs forever.
		// Racing an explicit timer is the contract. Built before `run` is called, because the runner
		// may say `running` before it even returns.
		let expire: (outcome: Outcome<T>) => void = () => undefined;
		const timer = new Promise<Outcome<T>>((settle) => {
			expire = settle;
		});

		// Re-armed rather than fired when a caller who joined *after* the start raised the deadline:
		// an export (30 s) that dedups onto an already-compiling visible block (10 s) must not be cut
		// at 10 s and have its key poisoned for the session by a compile that was never given its own
		// budget. Waiting only the difference not yet waited keeps the total exact without a clock,
		// which this module has no business holding.
		let armed = 0;
		const arm = (): void => {
			const remaining = entry.timeoutMs - armed;
			armed = entry.timeoutMs;
			timerId = this.timers.setTimeout(() => {
				if (entry.timeoutMs > armed) arm();
				else expire({ kind: 'timeout' });
			}, remaining);
		};

		// The job reached the engine: its own budget starts now, and not a moment before.
		const begin = (): void => {
			if (running || done) return;
			running = true;
			if (timerId !== undefined) this.timers.clearTimeout(timerId);
			try {
				arm();
			} catch (error) {
				// Called back from the runner, outside the `try` below; a broken timer seam must still
				// end the job rather than leave it unbounded.
				expire({ kind: 'error', error });
			}
		};

		try {
			for (const onStart of entry.owners.values()) notify(onStart);

			if (this.startupMs === undefined) {
				running = true;
				arm();
			} else {
				timerId = this.timers.setTimeout(() => expire({ kind: 'stalled' }), this.startupMs);
			}

			const outcome = await Promise.race<Outcome<T>>([
				this.invoke(entry.job, controller.signal, begin),
				timer,
			]);

			if (outcome.kind === 'ok') {
				entry.resolve(outcome.value);
			} else if (outcome.kind === 'error') {
				entry.reject(outcome.error);
			} else if (outcome.kind === 'stalled') {
				const error = new QueueError(
					'stalled',
					entry.key,
					`the engine did not take ${entry.key} within ${this.startupMs ?? 0}ms`,
				);
				// Aborted so the runner stops waiting on whatever never came up. Not poisoned: the
				// diagram never ran, so nothing is known against it.
				controller.abort(error);
				entry.reject(error);
			} else {
				const error = new QueueError('timeout', entry.key, `render exceeded ${entry.timeoutMs}ms`);
				// Session-scoped: one wedging block must not starve the vault for the rest of the
				// session, but it must come back after a reload, a Retry, a settings change or an
				// engine restart.
				this.poisoned.add(entry.key);
				controller.abort(error);
				entry.reject(error);
			}
		} catch (error) {
			// Nothing above is *supposed* to throw — `invoke` folds both of the job's settlements into
			// a value precisely so the race can never reject. But the timer seam is injected, and a
			// throw out of it would free the slot while leaving the caller's promise pending for the
			// rest of the session, visible only as an unhandled rejection off `void this.start()`. An
			// entry that never settles is the one failure this module exists to make impossible, so
			// the guarantee is structural rather than by inspection of the code above.
			entry.reject(error);
		} finally {
			done = true;
			if (timerId !== undefined) this.timers.clearTimeout(timerId);
			this.inflight -= 1;
			this.entries.delete(entry.key);
			this.pump();
		}
	}

	/** Never rejects. Folding both settlements into a value is what keeps the losing racer quiet. */
	private invoke(job: J, signal: AbortSignal, running: () => void): Promise<Outcome<T>> {
		try {
			return this.run(job, signal, running).then(
				(value): Outcome<T> => ({ kind: 'ok', value }),
				(error: unknown): Outcome<T> => ({ kind: 'error', error }),
			);
		} catch (error) {
			// A `run` that throws synchronously must not take the slot down with it.
			return Promise.resolve({ kind: 'error', error });
		}
	}

	/**
	 * Overflow rejects the LEAST urgent waiting job — lowest priority band, and within it the most
	 * recently added. A 200-diagram note therefore keeps the work nearest the viewport and hands
	 * the rest back as `depth-cap` for a "Render diagram" button, instead of committing to hours.
	 */
	private enforceDepthCap(): void {
		// Uncapped jobs are bounded some other way — an export by its budget, a resumed job by the
		// slot it already had — so they take none of the cap.
		let capped = 0;
		for (const entry of this.pending) if (!entry.uncapped) capped++;

		while (capped > this.depthCap) {
			const victim = this.leastUrgentPending();
			if (victim === undefined) return;
			this.drop(victim);
			this.entries.delete(victim.key);
			capped--;
			victim.reject(new QueueError('depth-cap', victim.key, `queue is full (${this.depthCap})`));
		}
	}

	private nextToStart(): Entry<J, T> | undefined {
		let best: Entry<J, T> | undefined;
		for (const entry of this.pending) {
			if (best === undefined) best = entry;
			else if (entry.priority < best.priority) best = entry;
			else if (entry.priority === best.priority && entry.seq < best.seq) best = entry;
		}
		return best;
	}

	/** Among the jobs the cap may evict: never an uncapped one. */
	private leastUrgentPending(): Entry<J, T> | undefined {
		let worst: Entry<J, T> | undefined;
		for (const entry of this.pending) {
			if (entry.uncapped) continue;
			if (worst === undefined) worst = entry;
			else if (entry.priority > worst.priority) worst = entry;
			else if (entry.priority === worst.priority && entry.seq > worst.seq) worst = entry;
		}
		return worst;
	}

	private drop(entry: Entry<J, T>): void {
		const index = this.pending.indexOf(entry);
		if (index >= 0) this.pending.splice(index, 1);
	}
}
