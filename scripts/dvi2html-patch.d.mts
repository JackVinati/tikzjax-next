/**
 * Types for dvi2html-patch.mjs, so the tests exercise the patch the build applies rather than a copy
 * of it. Only what a test needs is declared; keep it in step with the .mjs beside it.
 */
import type { Plugin } from 'esbuild';

export declare function patchDvi2html(code: string): string;

export declare function dvi2htmlPatch(): Plugin;
