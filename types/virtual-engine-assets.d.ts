/**
 * Supplied by the `virtual:engine-assets` esbuild plugin in scripts/esbuild.config.mjs, which
 * reads engine-build/out/ at build time. Nothing here exists in the source tree: the payload is
 * ~8 MB and is reproducible with `npm run engine:image && npm run engine:build`.
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
	/** gzipped tex.wasm, base64. */
	export const TEX_WASM_GZ: string;
	/** core.dump's length: the whole 2500-page WebAssembly.Memory image, zeros included. */
	export const CORE_DUMP_SIZE: number;
	/** core.dump's non-zero runs, in order: an offset and a length for each, flat. */
	export const CORE_DUMP_RUNS: readonly number[];
	/** The runs' bytes back to back, gzipped, base64 (scripts/engine-assets.mjs `packCoreDump`). */
	export const CORE_DUMP_GZ: string;
	/** TeX input filename -> gzipped contents, base64. */
	export const TEX_FILES: Record<string, string>;
	/**
	 * sha256 of the minified worker bundle that embeds it, the id itself left out
	 * (scripts/engine-assets.mjs `buildWorker`). A cache-key input.
	 */
	export const ENGINE_ID: string;
	export const INVENTORY: import('../engine-src/protocol').EngineInventory;
}

declare module 'virtual:engine' {
	/** The bundled TeX worker, as a string, for `new Worker(URL.createObjectURL(blob))`. */
	export const WORKER_SOURCE: string;
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
