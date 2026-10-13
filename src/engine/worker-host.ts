import { WORKER_SOURCE, ENGINE_ID, ENGINE_INVENTORY } from 'virtual:engine';
import type {
	EngineInventory,
	RenderOptions,
	WorkerRequest,
	WorkerResponse,
} from '../../engine-src/protocol';
import {
	InterruptedError,
	TexError,
	type EngineCapabilities,
	type TexHost,
	type TexJob,
	type TexResult,
} from '../types';

/** The capability view of an inventory: what pre-flight and the error hints actually read. */
function capabilitiesOf(inventory: EngineInventory | null): EngineCapabilities {
	return {
		expl3: inventory?.capabilities.expl3 ?? false,
		twoPass: inventory?.capabilities.twoPass ?? false,
		packages: inventory?.packages ?? {},
		files: new Set(inventory?.files ?? []),
	};
}

/** The timer seam, as the queue has it, so the idle teardown is testable without a clock. */
export interface HostTimers {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

export interface WorkerHostOptions {
	/** Streams TeX output per job, so a slow compile is watchable rather than silent until it ends. */
	onLog?: ((jobKey: string, line: string) => void) | undefined;
	/**
	 * Terminate a worker that has had nothing to do for this long. Omitted: never.
	 *
	 * An idle worker still holds the inflated core dump, ~156 MiB, and on a phone that is the
	 * difference between surviving in the background and being jetsam-killed (#111, #91). The
	 * price is a boot on the next uncached diagram, which is why the figure is a budget per
	 * platform (platform/budgets.ts) rather than a constant here.
	 */
	idleTeardownMs?: number | undefined;
	/** Required for `idleTeardownMs` to do anything. */
	timers?: HostTimers | undefined;
}

/** One render, from `render()` until it settles. */
interface Job {
	readonly id: number;
	readonly key: string;
	readonly source: string;
	readonly options: RenderOptions;
	readonly log: string[];
	readonly onRunning: (() => void) | undefined;
	readonly signal: AbortSignal;
	readonly onAbort: () => void;
	readonly resolve: (result: TexResult) => void;
	readonly reject: (error: Error) => void;
}

/** One worker, from spawn to terminate. Messages from an older one are recognised and dropped. */
interface Engine {
	readonly worker: Worker;
	blobUrl: string | null;
	/** It has announced itself, so it can take a job. */
	up: boolean;
	readonly ready: Promise<void>;
	readonly resolveReady: () => void;
	readonly rejectReady: (error: Error) => void;
}

/**
 * Owns the TeX worker.
 *
 * The shipped plugin injects a 7 MB <script> into every document and lets it scan the DOM, which
 * means the plugin holds no handle on anything: no timeout, no cancellation, no error surface, no
 * way to know a render even started. Everything this class does is unreachable from that design —
 * see internal/DESIGN.md §2.1.
 *
 * ONE job is in the worker at a time, and the rest wait here. TeX runs a job to completion inside
 * a single message task, so a second job posted beside it does not run alongside it, it waits in
 * the worker's own queue — where nothing can see it. Two things went wrong while they were posted
 * together: the second job's clock ran all through the first, so a heavy diagram could time out
 * its innocent neighbour, and a timeout's terminate took the neighbour down with it and blamed it.
 * Holding the line here is what makes `onRunning` mean "the engine has it", and what makes the
 * job in a terminated worker the only job that was in it.
 */
export class WorkerHost implements TexHost {
	readonly id = ENGINE_ID;

	private engine: Engine | null = null;
	/** The job inside the worker. */
	private current: Job | null = null;
	/** Jobs handed to `render` that the worker has not been given yet, oldest first. */
	private readonly waiting: Job[] = [];
	private disposed = false;
	private idleTimer: number | null = null;
	private inventory: EngineInventory | null = ENGINE_INVENTORY;
	private nextId = 1;

	private readonly onLog: ((jobKey: string, line: string) => void) | undefined;
	private readonly idleTeardownMs: number | undefined;
	private readonly timers: HostTimers | undefined;

	/**
	 * Known from the moment the plugin loads, from the inventory baked in at build time.
	 *
	 * It used to start empty and be filled only when the worker announced itself, and pre-flight
	 * reads it while a block is being PROCESSED — before any render, and in a session that only shows
	 * cached diagrams, before a boot that never comes. Every library and package on a diagram that
	 * had rendered perfectly was then reported as "not bundled". The worker's announcement still
	 * replaces this below; it describes the same build, so the two agree.
	 */
	private caps: EngineCapabilities = capabilitiesOf(ENGINE_INVENTORY);

	// Not parameter properties: `erasableSyntaxOnly` forbids them, because they are the one piece of
	// TypeScript class syntax that emits runtime code rather than being erased.
	constructor(options: WorkerHostOptions = {}) {
		this.onLog = options.onLog;
		this.idleTeardownMs =
			options.idleTeardownMs !== undefined && options.idleTeardownMs > 0
				? options.idleTeardownMs
				: undefined;
		this.timers = options.timers;
	}

	get capabilities(): EngineCapabilities {
		return this.caps;
	}

	get engineInventory(): EngineInventory | null {
		return this.inventory;
	}

	async ready(): Promise<void> {
		if (this.disposed) throw unloaded();
		await (this.engine ?? this.spawn()).ready;
	}

	render(job: TexJob, signal: AbortSignal, onRunning?: () => void): Promise<TexResult> {
		// A host that has been disposed refuses with an ordinary failure, NOT an interruption: an
		// interrupted block asks again, and an unloaded plugin must not be asked forever.
		if (this.disposed) return Promise.reject(unloaded());
		if (signal.aborted) {
			return Promise.reject(new TexError('aborted', [], undefined, undefined, 'aborted before start'));
		}

		return new Promise<TexResult>((resolve, reject) => {
			const entry: Job = {
				id: this.nextId++,
				key: job.key,
				source: job.source,
				options: job.options,
				log: [],
				onRunning,
				signal,
				onAbort: () => this.abandon(entry),
				resolve,
				reject,
			};
			signal.addEventListener('abort', entry.onAbort, { once: true });
			this.waiting.push(entry);
			this.pump();
		});
	}

	/**
	 * Destroy the worker and interrupt everything outstanding — the job inside it and the ones
	 * waiting for it alike.
	 *
	 * Terminating is mandatory, not defensive. A TeX run is synchronous inside the worker, so one
	 * that never ends — a \loop with no way out — holds it for good, and nothing but terminate()
	 * stops it. Since 0.2.0 a run TeX gives up on ends by itself, with TeX's message (DECISIONS.md
	 * D14, D17), and \nonstopmode keeps an ordinary error from waiting at TeX's `? ` prompt; neither
	 * stops a run that loops. Terminate-and-respawn is the guarantee.
	 *
	 * The waiting jobs are interrupted too rather than handed a fresh worker, because the callers
	 * here — backgrounding on a phone, above all — kill the worker to be rid of it, and booting
	 * another behind their back would undo exactly that. Whoever wants the work still done
	 * resubmits it, when it suits them.
	 */
	kill(reason = 'the engine was restarted'): void {
		const error = new InterruptedError(reason);
		this.teardown(error);
		const victims = this.waiting.splice(0);
		if (this.current !== null) victims.unshift(this.current);
		this.current = null;
		for (const job of victims) this.settle(job, () => job.reject(error));
	}

	dispose(): void {
		this.disposed = true;
		this.kill('the plugin was unloaded');
	}

	// -------------------------------------------------------------------------------------------

	/** Give the worker its next job, if it has none — booting one first if there is none. */
	private pump(): void {
		if (this.current !== null || this.disposed) return;

		const next = this.waiting[0];
		if (next === undefined) {
			this.armIdleTeardown();
			return;
		}
		this.cancelIdleTeardown();

		let engine = this.engine;
		if (engine === null) {
			try {
				engine = this.spawn();
			} catch (error) {
				this.failWaiting(error as Error);
				return;
			}
		}
		// Still booting: its `ready` message calls back in here.
		if (!engine.up) return;

		this.waiting.shift();
		this.current = next;
		engine.worker.postMessage({
			type: 'render',
			id: next.id,
			source: next.source,
			options: next.options,
		} satisfies WorkerRequest);
		try {
			next.onRunning?.();
		} catch {
			// The caller's clock is its own business; the job is in the worker either way.
		}
	}

	private spawn(): Engine {
		let blobUrl: string | null = null;
		let worker: Worker;
		try {
			blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
			worker = new Worker(blobUrl);
		} catch (cause) {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
			throw new TexError('engine-unavailable', [], undefined, undefined, String(cause));
		}

		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		// Usually nobody is listening: renders wait on `up`, not on this. A boot that fails with
		// no one awaiting `ready()` must not surface as an unhandled rejection.
		ready.catch(() => undefined);

		const engine: Engine = { worker, blobUrl, up: false, ready, resolveReady, rejectReady };
		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			if (this.engine === engine) this.receive(engine, event.data);
		};
		worker.onerror = (event) => {
			if (this.engine === engine) this.crashed(engine, event.message);
		};
		this.engine = engine;
		return engine;
	}

	private receive(engine: Engine, message: WorkerResponse): void {
		if (message.type === 'ready') {
			engine.up = true;
			this.inventory = message.inventory;
			this.caps = capabilitiesOf(message.inventory);
			// The blob URL has done its job the moment the worker is running. Upstream never revokes
			// it, so the whole 9 MB source stays pinned in memory for the life of the app.
			if (engine.blobUrl) {
				URL.revokeObjectURL(engine.blobUrl);
				engine.blobUrl = null;
			}
			engine.resolveReady();
			this.pump();
			return;
		}

		// A reply for a job we abandoned; ids make that unambiguous rather than a guess.
		const job = this.current;
		if (job === null || message.id !== job.id) return;

		if (message.type === 'log') {
			job.log.push(message.line);
			this.onLog?.(job.key, message.line);
			return;
		}

		this.current = null;
		const line = blockLine(message.line, message.bodyLine);
		if (message.type === 'ok') {
			const result: TexResult = {
				svg: message.svg,
				log: message.log,
				durationMs: message.durationMs,
				firstError: message.firstError,
				line,
			};
			this.settle(job, () => job.resolve(result));
		} else {
			const error = new TexError(message.kind, message.log, message.firstError, line, message.message);
			this.settle(job, () => job.reject(error));
		}
		this.pump();
	}

	/**
	 * `onerror`: an exception nothing in the worker caught, so its state is unknown and it is not
	 * reused. A crash while booting fails everyone waiting for that boot — respawning behind them
	 * would loop on a boot that cannot succeed. A crash mid-run fails that job, and the jobs behind
	 * it get a fresh worker.
	 */
	private crashed(engine: Engine, message: string): void {
		const error = new TexError('engine-unavailable', [], undefined, undefined, message);
		const booting = !engine.up;
		this.teardown(error);

		const victims = booting ? this.waiting.splice(0) : [];
		if (this.current !== null) victims.unshift(this.current);
		this.current = null;
		for (const job of victims) this.settle(job, () => job.reject(error));
		this.pump();
	}

	/**
	 * The caller stopped waiting: its timeout, or its startup allowance, ran out.
	 *
	 * A job abandoned mid-run takes the worker with it. It cannot be stopped any other way, and
	 * nothing queued behind it could run until it ended — which, for a run that loops, is never. A
	 * job abandoned before the worker had it takes nothing with it, unless it
	 * was the last one waiting on a boot: a boot that outlived a caller's whole startup allowance
	 * is presumed wedged, and with nobody left waiting there is no reason to let it go on.
	 */
	private abandon(job: Job): void {
		if (this.current === job) {
			this.current = null;
			this.teardown(new TexError('timeout', job.log));
			this.settle(job, () => job.reject(new TexError('timeout', job.log)));
			this.pump();
			return;
		}

		const index = this.waiting.indexOf(job);
		if (index < 0) return;
		this.waiting.splice(index, 1);
		this.settle(job, () =>
			job.reject(new TexError('aborted', [], undefined, undefined, 'abandoned before it started')),
		);

		const engine = this.engine;
		if (engine !== null && !engine.up && this.current === null && this.waiting.length === 0) {
			this.teardown(
				new TexError('engine-unavailable', [], undefined, undefined, 'the engine did not start'),
			);
		}
	}

	private failWaiting(error: Error): void {
		for (const job of this.waiting.splice(0)) this.settle(job, () => job.reject(error));
	}

	/** Every settlement goes through here, so no job keeps a listener on a signal it is done with. */
	private settle(job: Job, fn: () => void): void {
		job.signal.removeEventListener('abort', job.onAbort);
		fn();
	}

	/** Stop the current worker, if there is one. Jobs are the caller's to settle. */
	private teardown(error: Error): void {
		this.cancelIdleTeardown();
		const engine = this.engine;
		if (engine === null) return;
		this.engine = null;
		engine.worker.terminate();
		if (engine.blobUrl) {
			URL.revokeObjectURL(engine.blobUrl);
			engine.blobUrl = null;
		}
		// A no-op if it had already announced itself.
		engine.rejectReady(error);
	}

	private armIdleTeardown(): void {
		if (this.idleTeardownMs === undefined || this.timers === undefined) return;
		if (this.engine === null || !this.engine.up || this.idleTimer !== null) return;
		this.idleTimer = this.timers.setTimeout(() => {
			this.idleTimer = null;
			if (this.current !== null || this.waiting.length > 0) return;
			this.teardown(new TexError('engine-unavailable', [], undefined, undefined, 'stopped while idle'));
		}, this.idleTeardownMs);
	}

	private cancelIdleTeardown(): void {
		if (this.idleTimer === null) return;
		this.timers?.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}
}

/**
 * TeX's `l.NN`, as a line of the block.
 *
 * TeX counts the lines of the whole input, and every preamble file comes first, so the block's own
 * first line is wherever the worker says it put it (engine-src/document.ts). The error card used to
 * subtract a fixed 2, which was right only for a preamble of one line: with a three-line preamble
 * file it showed the block's line two below the one at fault. Lines above the block come out as 0,
 * -1 and so on, counting up through the preamble — block/error-card.ts says which file that is.
 *
 * A worker that does not say is the one-line assembly every worker before this one used.
 */
function blockLine(line: number | undefined, bodyLine: number | undefined): number | undefined {
	return line === undefined ? undefined : line - (bodyLine ?? 2) + 1;
}

function unloaded(): TexError {
	return new TexError('engine-unavailable', [], undefined, undefined, 'the plugin was unloaded');
}
