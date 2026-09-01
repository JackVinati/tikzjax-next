import { WORKER_SOURCE, ENGINE_ID } from 'virtual:engine';
import type { EngineInventory, WorkerRequest, WorkerResponse } from '../../engine-src/protocol';
import { TexError, type EngineCapabilities, type TexHost, type TexJob, type TexResult } from '../types';

/**
 * Owns the TeX worker.
 *
 * The shipped plugin injects a 7 MB <script> into every document and lets it scan the DOM, which
 * means the plugin holds no handle on anything: no timeout, no cancellation, no error surface, no
 * way to know a render even started. Everything this class does is unreachable from that design —
 * see docs/DESIGN.md §2.1.
 */
export class WorkerHost implements TexHost {
	readonly id = ENGINE_ID;

	private worker: Worker | null = null;
	private blobUrl: string | null = null;
	private booting: Promise<void> | null = null;
	private inventory: EngineInventory | null = null;

	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ key: string; resolve: (r: TexResult) => void; reject: (e: Error) => void; log: string[] }
	>();

	/** Streams TeX output per job, so a slow compile is watchable rather than silent until it ends. */
	private readonly onLog: ((jobKey: string, line: string) => void) | undefined;

	/** Set once the worker has announced itself; used for error copy, not just the README. */
	private caps: EngineCapabilities = {
		expl3: false,
		twoPass: false,
		packages: {},
		files: new Set(),
	};

	// Not a parameter property: `erasableSyntaxOnly` forbids them, because they are the one piece of
	// TypeScript class syntax that emits runtime code rather than being erased.
	constructor(onLog?: (jobKey: string, line: string) => void) {
		this.onLog = onLog;
	}

	get capabilities(): EngineCapabilities {
		return this.caps;
	}

	ready(): Promise<void> {
		this.booting ??= this.boot();
		return this.booting;
	}

	private boot(): Promise<void> {
		return new Promise((resolve, reject) => {
			let worker: Worker;
			try {
				const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
				this.blobUrl = URL.createObjectURL(blob);
				worker = new Worker(this.blobUrl);
			} catch (cause) {
				reject(new TexError('engine-unavailable', [], undefined, undefined, String(cause)));
				return;
			}

			this.worker = worker;
			worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data, resolve);
			worker.onerror = (event) => {
				const error = new TexError('engine-unavailable', [], undefined, undefined, event.message);
				reject(error);
				this.failAll(error);
			};
		});
	}

	private receive(message: WorkerResponse, onReady: () => void): void {
		if (message.type === 'ready') {
			this.inventory = message.inventory;
			this.caps = {
				expl3: message.inventory.capabilities.expl3,
				twoPass: message.inventory.capabilities.twoPass,
				packages: message.inventory.packages,
				files: new Set(message.inventory.files),
			};
			// The blob URL has done its job the moment the worker is running. Upstream never revokes
			// it, so the whole 9 MB source stays pinned in memory for the life of the app.
			if (this.blobUrl) {
				URL.revokeObjectURL(this.blobUrl);
				this.blobUrl = null;
			}
			onReady();
			return;
		}

		const entry = this.pending.get(message.id);
		if (!entry) return; // a reply for a job we abandoned; ids make that unambiguous rather than a guess

		if (message.type === 'log') {
			entry.log.push(message.line);
			this.onLog?.(entry.key, message.line);
			return;
		}

		this.pending.delete(message.id);

		if (message.type === 'ok') {
			entry.resolve({
				svg: message.svg,
				log: message.log,
				durationMs: message.durationMs,
				firstError: message.firstError,
				line: message.line,
			});
			return;
		}

		entry.reject(
			new TexError(message.kind, message.log, message.firstError, message.line, message.message),
		);
	}

	async render(job: TexJob, signal: AbortSignal): Promise<TexResult> {
		if (signal.aborted) throw new TexError('aborted', [], undefined, undefined, 'aborted before start');

		await this.ready();
		const worker = this.worker;
		if (!worker)
			throw new TexError('engine-unavailable', [], undefined, undefined, 'worker is not running');

		const id = this.nextId++;
		const log: string[] = [];

		return new Promise<TexResult>((resolve, reject) => {
			let done = false;
			const finish = (fn: () => void) => {
				if (done) return;
				done = true;
				signal.removeEventListener('abort', onAbort);
				this.pending.delete(id);
				fn();
			};

			// Aborting stops us WAITING; it does not stop the worker, which cannot be interrupted
			// mid-run. Terminating is the caller's decision (kill()), because it costs a respawn and
			// throws away work already paid for.
			function onAbort(this: void) {
				finish(() => reject(new TexError('timeout', log)));
			}
			signal.addEventListener('abort', onAbort, { once: true });

			this.pending.set(id, {
				key: job.key,
				resolve: (result) => finish(() => resolve(result)),
				reject: (error: Error) => finish(() => reject(error)),
				log,
			});

			worker.postMessage({
				type: 'render',
				id,
				source: job.source,
				options: job.options,
			} satisfies WorkerRequest);
		});
	}

	/**
	 * Destroy the worker and reject everything outstanding.
	 *
	 * This is mandatory, not defensive. A TeX run that gets stuck suspends the asyncify'd wasm, and
	 * a suspended asyncify continuation cannot be resumed — only terminated. \nonstopmode makes that
	 * far rarer (it is why the `broken` fixture now reports a line number instead of hanging), but it
	 * is an optimisation; terminate-and-respawn is the guarantee.
	 */
	kill(reason = 'the engine was restarted'): void {
		this.worker?.terminate();
		this.worker = null;
		this.booting = null;
		if (this.blobUrl) {
			URL.revokeObjectURL(this.blobUrl);
			this.blobUrl = null;
		}
		this.failAll(new TexError('timeout', [], undefined, undefined, reason));
	}

	private failAll(error: Error): void {
		for (const [, entry] of this.pending) entry.reject(error);
		this.pending.clear();
	}

	dispose(): void {
		this.kill('the plugin was unloaded');
	}

	get engineInventory(): EngineInventory | null {
		return this.inventory;
	}
}
