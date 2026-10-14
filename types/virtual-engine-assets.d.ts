/**
 * Supplied by the `virtual:engine-assets` esbuild plugin in scripts/esbuild.config.mjs, which
 * reads engine-build/out/ at build time. Nothing here exists in the source tree: the payload is
 * ~8 MB and is reproducible with `npm run engine:image && npm run engine:build`. Since 0.2.1 the
 * worker carries only the dump's layout and sizes; the payload itself is `virtual:engine`'s
 * ENGINE_ASSETS, which the host posts to the worker (internal/DECISIONS.md D30).
 *
 * EngineInventory is referenced as `import('../engine-src/protocol').EngineInventory`, an import
 * TYPE, and never through an `import type { … }` declaration inside the `declare module` block.
 * TypeScript 7 accepts the declaration form; typescript-eslint, which checks with TypeScript 5,
 * resolves it to an error type that behaves as `any`. Every value typed with it then arrived as
 * `any` — the community store reported "unsafe assignment of an error typed value" on the worker's
 * INVENTORY for weeks, and our own lint never saw it because engine-src/ is exempt from the unsafe
 * rules to keep the fork diffable.
 */
declare module 'virtual:engine-assets' {
	/** tex.wasm's length, which it must inflate to exactly. It comes in the payload (protocol.ts). */
	export const TEX_WASM_SIZE: number;
	/** core.dump's length: the whole 2500-page WebAssembly.Memory image, zeros included. */
	export const CORE_DUMP_SIZE: number;
	/** core.dump's non-zero runs, in order: an offset and a length for each, flat. */
	export const CORE_DUMP_RUNS: readonly number[];
	/**
	 * sha256 of the minified worker bundle that embeds it, the id itself left out
	 * (scripts/engine-assets.mjs `buildWorker`). Names the build; the cache key holds
	 * OUTPUT_REVISION (src/cache/key.ts) instead.
	 */
	export const ENGINE_ID: string;
	export const INVENTORY: import('../engine-src/protocol').EngineInventory;
}

declare module 'virtual:engine' {
	/** The bundled TeX worker, as a string, for `new Worker(URL.createObjectURL(blob))`. */
	export const WORKER_SOURCE: string;
	/**
	 * What the worker starts from, sent to it as its first message (engine-src/protocol.ts). Null only
	 * for a build made without an engine.
	 */
	export const ENGINE_ASSETS: import('../engine-src/protocol').EngineAssets | null;
	export const ENGINE_ID: string;
	/**
	 * What the engine ships, known at build time rather than announced by the running worker.
	 * Null only for a build made without an engine, which refuses to produce a plugin anyway.
	 */
	export const ENGINE_INVENTORY: import('../engine-src/protocol').EngineInventory | null;
}

declare module 'virtual:fonts' {
	/**
	 * The 140 TeX faces that do NOT ship in styles.css, as @font-face rules with base64 WOFF2.
	 * Injected per-Document on first mount; see scripts/gen-styles.mjs for why they are split.
	 */
	export const COLD_FONT_CSS: string;
}
