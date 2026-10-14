/** Types for plugin-version.mjs, so the tests build main.js's version as the build does. Keep in step with the .mjs. */

export declare const VERSION_DEFINE: string;

export declare function manifestVersion(root: string): string;

export declare function versionDefine(root: string): Record<string, string>;
