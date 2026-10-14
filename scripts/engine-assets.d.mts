/**
 * Types for engine-assets.mjs, so the tests can call the build's own functions rather than a copy
 * of them. Only what a test needs is declared; keep it in step with the .mjs beside it.
 */
import type { Plugin } from 'esbuild';
import type { EngineAssets, EngineInventory } from '../engine-src/protocol';

export declare const ENGINE_ID_PLACEHOLDER: string;

export declare function engineIdOf(bundle: string): string;

export declare function readCoreDump(root: string): Uint8Array;

/** The globals engine-src/reset.ts reads, whose places the worker carries. */
export declare const RESET_NAMES: readonly string[];

/** engine-build/out/memory-layout.json as the worker reads it. */
export declare function readMemoryLayout(root: string): import('../engine-src/reset').MemoryLayout;

/** `runs` is an offset and a length for each run, flat; `bytes` the runs' bytes back to back. */
export declare function packCoreDump(
	dump: Uint8Array,
	gap?: number,
): { size: number; runs: number[]; bytes: Uint8Array };

/** The committed dump as the worker string carries it: packed, and `gz` the gzip of its bytes. */
export declare function encodeCoreDump(root: string): { size: number; runs: number[]; gz: Uint8Array };

export declare function buildWorker(
	root: string,
	options?: { minify?: boolean; plugins?: Plugin[]; payload?: EngineAssets },
): Promise<{
	source: string;
	/** What the host sends the worker as its first message. */
	assets: EngineAssets;
	engineId: string;
	inventory: EngineInventory;
	stats: { wasmGz: number; dumpGz: number; texFiles: number; texFilesBytes: number };
}>;
