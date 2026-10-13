import { buildSync } from 'esbuild';

/**
 * A project file's bytes, exactly as they are on disk.
 *
 * Through esbuild's `binary` loader, for the reason read-text.ts gives: tsconfig sets `"types": []`,
 * so `node:fs` has no declarations in this project. A binary file is untouched by core.autocrlf, so
 * unlike readText there are no line endings to normalise.
 *
 * `path` is relative to the project root, which is where vitest runs.
 */
export function readBytes(path: string): Uint8Array {
	const [built] = buildSync({
		entryPoints: [path],
		loader: { [path.slice(path.lastIndexOf('.'))]: 'binary' },
		bundle: false,
		write: false,
		format: 'iife',
		globalName: 'BYTES',
		// Left to its default, esnext, esbuild decodes the bytes with Uint8Array.fromBase64, which
		// Node 22 does not have.
		target: 'es2022',
	}).outputFiles;
	if (!built) throw new Error(`esbuild produced no output for ${path}`);
	return new Function(`${built.text}\nreturn BYTES;`)() as Uint8Array;
}
