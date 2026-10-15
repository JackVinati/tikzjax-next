/**
 * A simulated phone: the real RenderQueue and the real WorkerHost, a worker that answers after the
 * times the iPhone's beta.6 diagnostics gave, stored runs read after theirs, and one clock for all
 * (internal/DECISIONS.md D40).
 *
 * Every timer goes through `Sim`, and after each one fires every promise the code under test has
 * queued is let run (setImmediate), so the order of things is the code's own and the times are the
 * diagnostics'.
 */
import { buildInput, routeOf } from '../../engine-src/document';
import type {
	EngineInventory,
	RenderOptions,
	SavedRunMessage,
	StoredRun,
	WorkerRequest,
	WorkerResponse,
} from '../../engine-src/protocol';
import { WorkerHost, type StoredRuns } from '../../src/engine/worker-host';
import { RenderQueue } from '../../src/queue/queue';
import type { TexResult } from '../../src/types';

export class Sim {
	now = 0;
	private id = 0;
	private readonly due = new Map<number, { at: number; fn: () => void }>();

	setTimeout = (fn: () => void, ms: number): number => {
		const id = ++this.id;
		this.due.set(id, { at: this.now + Math.max(0, ms), fn });
		return id;
	};

	clearTimeout = (id: number): void => {
		this.due.delete(id);
	};

	/** Run every timer due up to `until`, in time order, letting all promises settle after each. */
	async run(until: number): Promise<void> {
		await flush();
		for (;;) {
			let next: [number, { at: number; fn: () => void }] | undefined;
			for (const entry of this.due) {
				if (next === undefined || entry[1].at < next[1].at) next = entry;
			}
			if (next === undefined || next[1].at > until) break;
			this.due.delete(next[0]);
			this.now = next[1].at;
			next[1].fn();
			await flush();
		}
		this.now = Math.max(this.now, until);
	}
}

const flush = (): Promise<void> =>
	new Promise((resolve) =>
		(globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate(resolve),
	);

/** One diagram of the note, with what the engine took for it on the phone. */
export interface Diagram {
	name: string;
	/** Its place in the note: the order Obsidian made the blocks in. */
	place: number;
	packages: Record<string, string>;
	/** In the worker: memory reset or new memory, TeX, putting a stored run back, DVI to SVG, saving. */
	workMs: number;
	/** Reading its stored run, when one is stored; undefined when none is. */
	readMs: number | undefined;
	/** After the engine, on the main thread: the SVG pipeline and drawing. */
	afterMs: number;
}

const INVENTORY: EngineInventory = {
	engineId: 'test-engine',
	engine: 'test',
	packages: {},
	files: [],
	capabilities: { expl3: true, twoPass: false },
};

const SOURCE = '\\draw (0,0) -- (1,1);';
export const optionsOf = (d: Diagram): RenderOptions => ({ texPackages: d.packages, captureLog: true });
export const routeOfDiagram = (d: Diagram): string =>
	routeOf(buildInput(`${SOURCE} % ${d.name}`, optionsOf(d)).text, true)!;

/** When a diagram asked for its compile, when the queue last started it, and when it was compiled. */
export interface Outcome {
	name: string;
	asked: number;
	started: number | undefined;
	settled: number | undefined;
}

export function phone(
	diagrams: readonly Diagram[],
	opts: { bootMs: number; engines?: number | undefined; place?: boolean | undefined },
) {
	const sim = new Sim();
	const byRoute = new Map(diagrams.map((d) => [routeOfDiagram(d), d]));
	const posted: string[] = [];

	class SimWorker {
		onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
		onerror: ((event: ErrorEvent) => void) | null = null;
		private held: string[] = [];

		constructor(_url: string) {}

		postMessage(message: WorkerRequest): void {
			if (message.type === 'boot') {
				sim.setTimeout(
					() => this.emit({ type: 'ready', engineId: 'test-engine', inventory: INVENTORY }),
					opts.bootMs,
				);
				return;
			}
			if (message.type === 'flush') {
				this.emit({ type: 'flushed' });
				return;
			}
			if (message.type !== 'render') return;
			const route = routeOf(buildInput(message.source, message.options).text, true)!;
			const d = byRoute.get(route);
			if (d === undefined) throw new Error('unknown diagram');
			posted.push(d.name);
			sim.setTimeout(() => {
				if (!this.held.includes(route)) this.held.push(route);
				this.emit({
					type: 'ok',
					id: message.id,
					svg: '<svg/>',
					log: [],
					missing: [],
					durationMs: d.workMs,
					snapshots: { held: [...this.held], bytes: 1, failures: 0 },
				});
			}, d.workMs);
		}

		terminate(): void {}

		private emit(message: WorkerResponse): void {
			this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
		}
	}
	(globalThis as { Worker?: unknown }).Worker = SimWorker;
	(globalThis as { URL: { createObjectURL?: unknown } }).URL.createObjectURL = () => 'blob:sim';
	(globalThis as { URL: { revokeObjectURL?: unknown } }).URL.revokeObjectURL = () => undefined;

	const runs: StoredRuns = {
		readable: true,
		writable: true,
		epoch: 1,
		load: () => Promise.resolve(),
		has: (route) => byRoute.get(route)?.readMs !== undefined,
		read: (route) => {
			const d = byRoute.get(route);
			if (d?.readMs === undefined) return Promise.resolve(undefined);
			return new Promise<StoredRun>((resolve) =>
				sim.setTimeout(
					() => resolve({ route, data: new ArrayBuffer(8), compressed: true, rawBytes: 24 }),
					d.readMs!,
				),
			);
		},
		keep: (_message: SavedRunMessage) => Promise.resolve(),
		forget: () => Promise.resolve(),
		measured: () => undefined,
		used: () => undefined,
	};

	const engines = opts.engines ?? 1;
	const host = new WorkerHost({
		timers: sim,
		idleTeardownMs: 15_000,
		now: () => sim.now,
		poolSize: engines,
		snapshotBudget: () => 12 * 1048576,
		runs,
	});
	const queue = new RenderQueue<Diagram, TexResult>({
		concurrency: engines,
		depthCap: 16,
		timers: sim,
		startupMs: 30_000,
		run: (d, signal, running) =>
			host.render(
				{ key: d.name, source: `${SOURCE} % ${d.name}`, options: optionsOf(d), timeoutMs: 20_000 },
				signal,
				running,
			),
	});

	const outcomes: Outcome[] = [];
	/** What main.ts does at a block's cache miss: start the engine (D23). */
	const miss = () => void host.ready().catch(() => undefined);
	/** What a block does once seen: submit in band 1, as GATING + intersect does. */
	const submit = (d: Diagram) => {
		const outcome: Outcome = { name: d.name, asked: sim.now, started: undefined, settled: undefined };
		outcomes.push(outcome);
		void queue
			.submit(d.name, d, 1, 20_000, {
				owner: outcome,
				// The latest start, as the block keeps it (render-child.ts `started`).
				onStart: () => void (outcome.started = sim.now),
				...(opts.place === true ? { place: d.place } : {}),
			})
			.then(() => void (outcome.settled = sim.now));
	};

	return { sim, host, queue, posted, outcomes, miss, submit, diagrams };
}
