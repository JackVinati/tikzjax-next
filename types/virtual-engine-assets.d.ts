/**
 * Supplied by the `virtual:engine-assets` esbuild plugin in scripts/esbuild.config.mjs, which
 * reads engine-build/out/ at build time. Nothing here exists in the source tree: the payload is
 * ~8 MB and is reproducible with `npm run engine:image && npm run engine:build`.
 */
declare module 'virtual:engine-assets' {
	import type { EngineInventory } from '../engine-src/protocol';

	/** gzipped tex.wasm, base64. */
	export const TEX_WASM_GZ: string;
	/** gzipped core.dump, base64. The whole 2500-page WebAssembly.Memory image. */
	export const CORE_DUMP_GZ: string;
	/** TeX input filename -> gzipped contents, base64. */
	export const TEX_FILES: Record<string, string>;
	/** sha256 over the engine assets and engine-src/. A cache-key input. */
	export const ENGINE_ID: string;
	export const INVENTORY: EngineInventory;
}

declare module 'virtual:engine' {
	/** The bundled TeX worker, as a string, for `new Worker(URL.createObjectURL(blob))`. */
	export const WORKER_SOURCE: string;
	export const ENGINE_ID: string;
}

declare module 'virtual:fonts' {
	/**
	 * The 140 TeX faces that do NOT ship in styles.css, as @font-face rules with base64 WOFF2.
	 * Injected per-Document on first mount; see scripts/gen-styles.mjs for why they are split.
	 */
	export const COLD_FONT_CSS: string;
}
