import { WORKER_SOURCE, ENGINE_ASSETS, ENGINE_ID, ENGINE_INVENTORY } from 'virtual:engine';
import type {
	BootTimings,
	EngineInventory,
	RenderOptions,
	RenderTimings,
	WorkerRequest,
	WorkerResponse,
} from '../../engine-src/protocol';
import { isQueueError } from '../queue/queue';
import {
	InterruptedError,
	TexError,
	type EngineCapabilities,
	type TexHost,
	type TexJob,
	type TexResult,
	type TexTimings,
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

/**
 * Why an engine was stopped, for the diagnostics view.
 *
 * `idle` its idle teardown · `background` the app went to the background (mobile) · `timeout` a job
 * outlived its time budget in it · `restart` Restart the TeX engine · `settings` the second engine
 * was turned off · `error` it crashed, or never finished starting · `unload` the plugin was
 * unloaded.
 */
export type EngineStop = 'idle' | 'background' | 'timeout' | 'restart' | 'settings' | 'error' | 'unload';

/** One engine's life: how long it took to start, and why it stopped. */
export interface EngineLife {
	/**
	 * From created to ready, by the host's clock, rounded. Null until it is ready, and for good if it
	 * never was.
	 */
	startMs: number | null;
	/**
	 * Where the start went inside the worker once its payload arrived, as it said in `ready`, and
	 * whether it had the platform's own gzip and base64 (engine-src/protocol.ts BootTimings). Null
	 * until it is ready, or from a worker that does not say.
	 */
	boot: BootTimings | null;
	/** Null while it runs. */
	stop: EngineStop | null;
}

/** What the diagnostics view says about the engines: how often one started, and how each went. */
export interface EngineReport {
	/** Engines started this session. */
	starts: number;
	/** The most recent of them, oldest first: at most ENGINE_LIVES. */
	lives: readonly EngineLife[];
	/** Why an engine last stopped; null if none has. */
	lastStop: EngineStop | null;
	/** How many engines may run at once now. */
	poolSize: number;
}

/** How many engines' lives the report keeps. A phone stops its engine every time it is backgrounded. */
const ENGINE_LIVES = 20;

/** What an interrupted job is told, for each reason the engine can be stopped under it. */
const INTERRUPTED: Record<'restart' | 'background' | 'unload', string> = {
	restart: 'the engine was restarted',
	background: 'the app was backgrounded',
	unload: 'the plugin was unloaded',
};

/** The timer seam, as the queue has it, so the idle teardown is testable without a clock. */
export interface HostTimers {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

export interface WorkerHostOptions {
	/** Streams TeX output per job, so a slow compile is watchable rather than silent until it ends. */
	onLog?: ((jobKey: string, line: string) => void) | undefined;
	/**
	 * Terminate the workers once none has had anything to do for this long. Omitted: never.
	 *
	 * An idle worker still holds the engine — the 22.3 MiB of core dump it starts each run from,
	 * among the rest (DECISIONS.md D18) — and on a phone that is the difference between surviving
	 * in the background and being jetsam-killed (#111, #91). The price is a start on the next
	 * uncached diagram, which is why the figure is a budget per platform (platform/budgets.ts)
	 * rather than a constant here.
	 */
	idleTeardownMs?: number | undefined;
	/** Required for `idleTeardownMs` to do anything. */
	timers?: HostTimers | undefined;
	/** The clock the engine's start is timed with, in milliseconds. Omitted: performance.now(). */
	now?: (() => number) | undefined;
	/**
	 * How many workers may run at once, each one job at a time. Omitted: 1. Each worker is a start
	 * and memory of its own, so this is decided per device (platform/budgets.ts `engineCount`), and
	 * can be changed while running (`setPoolSize`).
	 */
	poolSize?: number | undefined;
	/**
	 * Told how many jobs the host can run at once whenever that changes: the pool's size was set, an
	 * engine failed to start and the pool is down to one, or the engines stopped and it is whole
	 * again. The queue runs as many (main.ts), so that no job it starts waits in here, on its startup
	 * allowance, behind someone else's diagram.
	 */
	onSize?: ((engines: number) => void) | undefined;
}

/** One render, from `render()` until it settles. */
interface Job {
	readonly id: number;
	readonly key: string;
	readonly source: string;
	readonly options: RenderOptions;
	readonly log: string[];
	/** When `render` was called, by the host's clock. */
	readonly arrived: number;
	/** How long it waited for the engine to start, once it has been posted; see TexTimings. */
	startMs: number | undefined;
	readonly onRunning: (() => void) | undefined;
	readonly signal: AbortSignal;
	readonly onAbort: () => void;
	readonly resolve: (result: TexResult) => void;
	readonly reject: (error: Error) => void;
}

/** One worker, from spawn to terminate. Messages from one no longer in the pool are dropped. */
interface Engine {
	readonly worker: Worker;
	blobUrl: string | null;
	/** It has announced itself, so it can take a job. */
	up: boolean;
	/** The job inside it. */
	current: Job | null;
	/** When it was created, and when it said it was ready, by the host's clock. */
	readonly spawnedAt: number;
	readyAt: number | null;
	readonly ready: Promise<void>;
	readonly resolveReady: () => void;
	readonly rejectReady: (error: Error) => void;
	/** Its entry in the report. */
	readonly life: EngineLife;
}

/**
 * Owns the TeX workers.
 *
 * The shipped plugin injects a 7 MB <script> into every document and lets it scan the DOM, which
 * means the plugin holds no handle on anything: no timeout, no cancellation, no error surface, no
 * way to know a render even started. Everything this class does is unreachable from that design —
 * see internal/DESIGN.md §2.1.
 *
 * ONE job is in a worker at a time, and the rest wait here. TeX runs a job to completion inside a
 * single message task, so a second job posted beside it does not run alongside it, it waits in the
 * worker's own queue — where nothing can see it. Two things went wrong while they were posted
 * together: the second job's clock ran all through the first, so a heavy diagram could time out
 * its innocent neighbour, and a timeout's terminate took the neighbour down with it and blamed it.
 * Holding the line here is what makes `onRunning` mean "the engine has it", and what makes the
 * job in a terminated worker the only job that was in it.
 *
 * Up to `poolSize` workers run side by side (internal/DECISIONS.md D24): two on a desktop, one on a
 * phone. A second one starts only while a job waits that no worker running or starting can take, a
 * timeout or a crash takes down only its own worker, `kill()` stops them all, and they idle down
 * together. Once a worker has failed to start, the pool is one until they next stop together.
 */
export class WorkerHost implements TexHost {
	readonly id = ENGINE_ID;

	/** The workers, up or starting: at most `poolSize`, but for one finishing its job after a shrink. */
	private readonly engines: Engine[] = [];
	/** Jobs handed to `render` that no worker has been given yet, oldest first. */
	private readonly waiting: Job[] = [];
	private disposed = false;
	private idleTimer: number | null = null;
	private inventory: EngineInventory | null = ENGINE_INVENTORY;
	private nextId = 1;

	/** For the diagnostics view: see EngineReport. */
	private starts = 0;
	private readonly lives: EngineLife[] = [];
	private lastStop: EngineStop | null = null;

	private readonly onLog: ((jobKey: string, line: string) => void) | undefined;
	private readonly idleTeardownMs: number | undefined;
	private readonly timers: HostTimers | undefined;
	private readonly now: () => number;
	private poolSize: number;
	private readonly onSize: ((engines: number) => void) | undefined;

	/**
	 * A worker failed to start since the workers last stopped together (idle, or `kill()`), so no
	 * other starts while one is up or starting: the pool is the one that came up. A start that fails
	 * is most likely memory the computer does not have, which the memory rule cannot see where the
	 * WebView reports too much or nothing (platform/budgets.ts). Starting the second again for every
	 * job that waits would be one failed start after another for as long as the first is busy.
	 */
	private startFailed = false;
	/** The size `onSize` was last told. */
	private told: number;

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
		this.now = options.now ?? (() => performance.now());
		this.poolSize = sizeOf(options.poolSize ?? 1);
		this.onSize = options.onSize;
		this.told = this.poolSize;
	}

	get capabilities(): EngineCapabilities {
		return this.caps;
	}

	get engineInventory(): EngineInventory | null {
		return this.inventory;
	}

	/** How often an engine started this session, how long each start took and why each stopped. */
	report(): EngineReport {
		return {
			starts: this.starts,
			lives: this.lives.map((life) => ({ ...life })),
			lastStop: this.lastStop,
			poolSize: this.size,
		};
	}

	/**
	 * Start an engine if none is running or starting, and wait for one to be up. Called as soon as a
	 * diagram turns out not to be cached, so that the start runs while the block waits for its turn
	 * (the viewport, the queue) rather than after it (DECISIONS.md D23). Never more than one.
	 *
	 * Its idle teardown is armed at once, as for any engine with nothing to do: one started for a
	 * diagram nobody scrolls to goes, and so does one whose start never finishes, which no job's
	 * startup allowance would otherwise ever give up on.
	 */
	async ready(): Promise<void> {
		if (this.disposed) throw unloaded();
		if (this.engines.some((engine) => engine.up)) return;
		const engine = this.engines[0] ?? this.spawn();
		this.pump();
		await engine.ready;
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
				arrived: this.now(),
				startMs: undefined,
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
	 * Run at most `size` workers from now on: the second engine was turned on or off.
	 *
	 * A worker above the new size goes at once if it has no job, and when its job is done if it has
	 * one: a TeX run cannot be stopped, and the job did nothing wrong.
	 */
	setPoolSize(size: number): void {
		this.poolSize = sizeOf(size);
		this.resized();
		this.pump();
	}

	/**
	 * Destroy every worker and interrupt everything outstanding — the jobs inside them and the ones
	 * waiting for them alike.
	 *
	 * Terminating is mandatory, not defensive. A TeX run is synchronous inside the worker, so one
	 * that never ends — a \loop with no way out — holds it for good, and nothing but terminate()
	 * stops it. Since 0.2.0 a run TeX gives up on ends by itself, with TeX's message (DECISIONS.md
	 * D14, D17), and \nonstopmode keeps an ordinary error from waiting at TeX's `? ` prompt; neither
	 * stops a run that loops. Terminate-and-respawn is the guarantee.
	 *
	 * The waiting jobs are interrupted too rather than handed a fresh worker, because the callers
	 * here — backgrounding on a phone, above all — kill the workers to be rid of them, and booting
	 * another behind their back would undo exactly that. Whoever wants the work still done
	 * resubmits it, when it suits them.
	 */
	kill(why: 'restart' | 'background' | 'unload' = 'restart'): void {
		const error = new InterruptedError(INTERRUPTED[why]);
		const victims: Job[] = [];
		for (const engine of this.engines.slice()) {
			if (engine.current !== null) victims.push(engine.current);
			engine.current = null;
			this.teardown(engine, error, why);
		}
		victims.push(...this.waiting.splice(0));
		this.startFailed = false;
		this.resized();
		for (const job of victims) this.settle(job, () => job.reject(error));
	}

	dispose(): void {
		this.disposed = true;
		this.kill('unload');
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * Let a worker above the pool's size go if it has no job; give each idle worker the next waiting
	 * job; and start another worker while jobs wait that the ones running and starting cannot take,
	 * up to the pool's size, or to one once a worker has failed to start.
	 */
	private pump(): void {
		if (this.disposed) return;

		// The newest first: that is the second engine, the one turned off.
		for (const engine of this.engines.slice().reverse()) {
			if (this.engines.length <= this.poolSize) break;
			if (engine.current !== null) continue;
			this.teardown(
				engine,
				new TexError(
					'engine-unavailable',
					[],
					undefined,
					undefined,
					'the second engine was turned off',
				),
				'settings',
			);
		}

		for (const engine of this.engines) {
			const next = this.waiting[0];
			if (next === undefined) break;
			if (!engine.up || engine.current !== null) continue;
			this.waiting.shift();
			this.post(engine, next);
		}

		const starting = this.engines.filter((engine) => !engine.up).length;
		// Every waiting job beyond what the starting workers will take wants a worker of its own.
		let wanted = this.waiting.length - starting;
		while (wanted > 0 && this.engines.length < this.size) {
			try {
				this.spawn();
			} catch (error) {
				if (this.engines.length === 0) this.failWaiting(error as Error);
				break;
			}
			wanted--;
		}

		if (this.waiting.length === 0 && this.engines.every((engine) => engine.current === null)) {
			this.armIdleTeardown();
		} else {
			this.cancelIdleTeardown();
		}
	}

	private post(engine: Engine, job: Job): void {
		engine.current = job;
		// The part of the engine's start this job was there for. Waiting behind another job once
		// the engine was up is not the engine starting.
		if (engine.readyAt !== null && job.arrived < engine.readyAt)
			job.startMs = engine.readyAt - Math.max(job.arrived, engine.spawnedAt);
		engine.worker.postMessage({
			type: 'render',
			id: job.id,
			source: job.source,
			options: job.options,
		} satisfies WorkerRequest);
		try {
			job.onRunning?.();
		} catch {
			// The caller's clock is its own business; the job is in the worker either way.
		}
	}

	private spawn(): Engine {
		let blobUrl: string | null = null;
		let worker: Worker | undefined;
		try {
			blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
			worker = new Worker(blobUrl);
			// The engine's payload, as data: the worker starts once it has it, and answers `ready`
			// (internal/DECISIONS.md D30). Posted at once, so it waits in the worker's queue while the
			// thread starts and the script is parsed, which is now 0.45 MB rather than 10.
			if (ENGINE_ASSETS !== null)
				worker.postMessage({ type: 'boot', assets: ENGINE_ASSETS } satisfies WorkerRequest);
		} catch (cause) {
			worker?.terminate();
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

		const life: EngineLife = { startMs: null, boot: null, stop: null };
		this.starts++;
		this.lives.push(life);
		if (this.lives.length > ENGINE_LIVES) this.lives.shift();

		const engine: Engine = {
			worker,
			blobUrl,
			up: false,
			current: null,
			spawnedAt: this.now(),
			readyAt: null,
			ready,
			resolveReady,
			rejectReady,
			life,
		};
		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			if (this.engines.includes(engine)) this.receive(engine, event.data);
		};
		worker.onerror = (event) => {
			if (this.engines.includes(engine)) this.crashed(engine, event.message);
		};
		this.engines.push(engine);
		return engine;
	}

	private receive(engine: Engine, message: WorkerResponse): void {
		if (message.type === 'ready') {
			engine.up = true;
			engine.readyAt = this.now();
			engine.life.startMs = Math.round(engine.readyAt - engine.spawnedAt);
			engine.life.boot = message.boot ?? null;
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
		const job = engine.current;
		if (job === null || message.id !== job.id) return;

		if (message.type === 'log') {
			job.log.push(message.line);
			this.onLog?.(job.key, message.line);
			return;
		}

		engine.current = null;
		const line = blockLine(message.line, message.bodyLine);
		if (message.type === 'ok') {
			const result: TexResult = {
				svg: message.svg,
				log: message.log,
				durationMs: message.durationMs,
				timings: timingsOf(message.timings, job.startMs),
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
	 * reused. A crash mid-run fails that job, and the jobs behind it get a worker.
	 *
	 * A crash while starting makes the pool one until the workers next stop together
	 * (`startFailed`). The jobs waiting then wait for a worker that is up or still starting, if there
	 * is one; with none, they fail, because starting another behind them would loop on a start that
	 * cannot succeed.
	 */
	private crashed(engine: Engine, message: string): void {
		const error = new TexError('engine-unavailable', [], undefined, undefined, message);
		const starting = !engine.up;
		const victims: Job[] = [];
		if (engine.current !== null) victims.push(engine.current);
		engine.current = null;
		this.teardown(engine, error, 'error');

		if (starting) {
			this.startFailed = true;
			this.resized();
			if (this.engines.length === 0) victims.push(...this.waiting.splice(0));
		}
		for (const job of victims) this.settle(job, () => job.reject(error));
		this.pump();
	}

	/**
	 * The caller stopped waiting: its timeout or its startup allowance ran out, or nobody wants the
	 * diagram any more.
	 *
	 * A job abandoned mid-run takes its worker with it, and only its own. It cannot be stopped any
	 * other way, and nothing queued behind it could run there until it ended — which, for a run that
	 * loops, is never. A job abandoned before a worker had it takes nothing with it, unless it was
	 * the last one waiting while every worker was still starting: a start that outlived a caller's
	 * whole startup allowance is presumed wedged, and with nobody left waiting there is no reason to
	 * let it go on.
	 *
	 * Not when the queue cancelled the job (internal/DECISIONS.md D25): its blocks went away, a note
	 * switched away from, which says nothing about the start, and the engine started early for it is
	 * kept for the next note's diagrams, or idles down if none comes. A WebView without
	 * `AbortSignal.reason`, an older iOS WebKit's, cannot tell the two apart, and stops the start as
	 * before.
	 */
	private abandon(job: Job): void {
		const running = this.engines.find((engine) => engine.current === job);
		if (running !== undefined) {
			running.current = null;
			this.teardown(running, new TexError('timeout', job.log), 'timeout');
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

		if (
			!isQueueError(job.signal.reason, 'cancelled') &&
			this.waiting.length === 0 &&
			this.engines.every((engine) => !engine.up && engine.current === null)
		) {
			for (const engine of this.engines.slice()) {
				this.teardown(
					engine,
					new TexError('engine-unavailable', [], undefined, undefined, 'the engine did not start'),
					'error',
				);
			}
		}
		// With nothing left waiting, a worker kept is an idle one.
		this.pump();
	}

	private failWaiting(error: Error): void {
		for (const job of this.waiting.splice(0)) this.settle(job, () => job.reject(error));
	}

	/** Every settlement goes through here, so no job keeps a listener on a signal it is done with. */
	private settle(job: Job, fn: () => void): void {
		job.signal.removeEventListener('abort', job.onAbort);
		fn();
	}

	/** Stop one worker. Its job, if it had one, is the caller's to settle. */
	private teardown(engine: Engine, error: Error, why: EngineStop): void {
		const at = this.engines.indexOf(engine);
		if (at < 0) return;
		this.engines.splice(at, 1);
		if (this.engines.length === 0) this.cancelIdleTeardown();
		engine.life.stop = why;
		this.lastStop = why;
		engine.worker.terminate();
		if (engine.blobUrl) {
			URL.revokeObjectURL(engine.blobUrl);
			engine.blobUrl = null;
		}
		// A no-op if it had already announced itself.
		engine.rejectReady(error);
	}

	/**
	 * Once nothing is running or waiting, stop every worker after the idle budget, together, also one
	 * still starting.
	 */
	private armIdleTeardown(): void {
		if (this.idleTeardownMs === undefined || this.timers === undefined) return;
		if (this.engines.length === 0 || this.idleTimer !== null) return;
		this.idleTimer = this.timers.setTimeout(() => {
			this.idleTimer = null;
			if (this.waiting.length > 0 || this.engines.some((engine) => engine.current !== null)) return;
			for (const engine of this.engines.slice()) {
				this.teardown(
					engine,
					new TexError('engine-unavailable', [], undefined, undefined, 'stopped while idle'),
					'idle',
				);
			}
			this.startFailed = false;
			this.resized();
		}, this.idleTeardownMs);
	}

	private cancelIdleTeardown(): void {
		if (this.idleTimer === null) return;
		this.timers?.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	/** How many workers run at once now: the pool's size, or one once a worker failed to start. */
	private get size(): number {
		return this.startFailed ? 1 : this.poolSize;
	}

	/** Tell `onSize` the size, if it changed. */
	private resized(): void {
		const size = this.size;
		if (size === this.told) return;
		this.told = size;
		try {
			this.onSize?.(size);
		} catch {
			// The caller's business; the pool is this size either way.
		}
	}
}

/** A pool's size: a whole number of workers, at least one. */
function sizeOf(size: number): number {
	return Math.max(1, Math.floor(size));
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

/** The worker's timings with the engine's start added, when this job waited for it. */
function timingsOf(worker: RenderTimings | undefined, startMs: number | undefined): TexTimings | undefined {
	if (worker === undefined) return undefined;
	return startMs === undefined ? { ...worker } : { ...worker, startMs: Math.round(startMs) };
}

function unloaded(): TexError {
	return new TexError('engine-unavailable', [], undefined, undefined, 'the plugin was unloaded');
}
