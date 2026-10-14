/**
 * The version this main.js was built as, against the one manifest.json says (internal/DECISIONS.md
 * D34).
 *
 * They are the same file's two halves, and differ only where something replaced one and not the
 * other. Obsidian Sync Standard does that: it caps a file at 5 MB, main.js is about 12 MB, and with
 * "Installed community plugins" on it copies the new manifest.json to another device and leaves the
 * old main.js there. Obsidian and BRAT read the version from manifest.json, so that device says it
 * has the new release, offers no update, and runs the old code, with nothing to tell anyone so.
 *
 * The build bakes manifest.json's version into main.js (scripts/plugin-version.mjs, esbuild's
 * `define`), and the plugin compares it with `this.manifest.version` when it loads. Only a main.js
 * that has this can tell: a device still running 0.2.1-beta.2 or older is told nothing by it.
 */

/**
 * Replaced by the build with manifest.json's version, as a string literal. Nothing else defines it,
 * so where nothing replaced it, as in the tests, it is not there at all.
 */
declare const __TIKZJAX_NEXT_VERSION__: string | undefined;

/** The version main.js was built as; null for one built without it, which the tests are. */
export const BUILT_VERSION: string | null =
	typeof __TIKZJAX_NEXT_VERSION__ === 'string' ? __TIKZJAX_NEXT_VERSION__ : null;

/**
 * Whether main.js and manifest.json are of different versions: false where either is unknown, so
 * that a build without the version never warns.
 */
export function outOfStep(built: string | null, manifest: string | undefined): boolean {
	return built !== null && typeof manifest === 'string' && manifest !== '' && built !== manifest;
}

/** The pair a warning was shown for, as data.json keeps it, so that it is shown once for each pair. */
export const versionPair = (built: string, manifest: string): string => `${built} → ${manifest}`;
