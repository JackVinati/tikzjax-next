/**
 * The plugin's version, baked into main.js by the build, so that the plugin can tell when the
 * main.js it runs is not the one its manifest.json describes (src/platform/version.ts,
 * internal/DECISIONS.md D34).
 *
 * From manifest.json, as the banner's version is (./banner.mjs): never a date, a hash or a path, so
 * the same commit still gives the same main.js.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The identifier src/platform/version.ts reads, which esbuild replaces with the version. */
export const VERSION_DEFINE = '__TIKZJAX_NEXT_VERSION__';

/** manifest.json's version. */
export function manifestVersion(root) {
	return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
}

/** esbuild's `define` for it: the identifier, and the version as a string literal. */
export function versionDefine(root) {
	return { [VERSION_DEFINE]: JSON.stringify(manifestVersion(root)) };
}
