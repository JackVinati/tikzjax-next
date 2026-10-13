import { buildSync } from 'esbuild';

/**
 * A project file's contents, as text, with line endings normalised to LF.
 *
 * Through esbuild's `text` loader, as twopass.test.ts does it, and not `node:fs` or a `?raw` import:
 * tsconfig sets `"types": []`, so `node:fs` has no declarations in this project, and vitest answers
 * every stylesheet import with an empty string unless CSS processing is turned on for the whole run.
 *
 * LF because a Windows checkout with core.autocrlf rewrites every line ending, and a test that
 * fingerprints source text must not fail on one machine and pass on another.
 *
 * `path` is relative to the project root, which is where vitest runs.
 */
export function readText(path: string): string {
	const [built] = buildSync({
		entryPoints: [path],
		loader: { '.ts': 'text', '.css': 'text', '.svg': 'text', '.sh': 'text', '.txt': 'text' },
		bundle: false,
		write: false,
		format: 'iife',
		globalName: 'TEXT',
	}).outputFiles;
	if (!built) throw new Error(`esbuild produced no output for ${path}`);
	const text = new Function(`${built.text}\nreturn TEXT;`)() as string;
	return text.split('\r\n').join('\n');
}
