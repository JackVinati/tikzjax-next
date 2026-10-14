/** Types for start-worker.mjs. Keep it in step with the .mjs beside it. */
import type { BootTimings, EngineAssets } from '../../engine-src/protocol';

export type StartOutcome =
	| { type: 'ready'; boot: BootTimings | undefined; ms: number }
	| { type: 'error'; message: string; ms: number }
	| { type: 'timeout'; ms: number };

export declare function startWorker(
	source: string,
	payload: EngineAssets | Record<string, unknown>,
	options?: { legacy?: boolean; timeoutMs?: number },
): Promise<StartOutcome>;
