/**
 * Types for engine-assets.mjs, so the tests can call the build's own functions rather than a copy
 * of them. Only what a test needs is declared; keep it in step with the .mjs beside it.
 */
import type { Plugin } from 'esbuild';
import type { EngineInventory } from '../engine-src/protocol';

export declare const ENGINE_ID_PLACEHOLDER: string;

export declare function engineIdOf(bundle: string): string;

export declare function readCoreDump(root: string): Uint8Array;

export declare function buildWorker(
	root: string,
	options?: { minify?: boolean; plugins?: Plugin[] },
): Promise<{
	source: string;
	engineId: string;
	inventory: EngineInventory;
	stats: { wasmGz: number; dumpGz: number; texFiles: number; texFilesBytes: number };
}>;
