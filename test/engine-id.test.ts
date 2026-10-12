/// <reference types="vite/client" />
import type { Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { buildWorker, ENGINE_ID_PLACEHOLDER } from '../scripts/engine-assets.mjs';

/*
 * ENGINE_ID is a cache-key input: whatever it fails to cover, a user keeps seeing as the old code
 * drew it. It used to hash a list — the engine archives, the NAMES of the bundled TeX files and
 * engine-src/*.ts — which missed a TeX file whose contents changed under the same name, and every
 * npm package the worker bundles. It is now the hash of the bundled worker, and these hold it to
 * covering what the list did not.
 *
 * Built through the build's own function, with plugins standing in for the parts being varied. The
 * 8 MB of engine assets are replaced by a stub where they are not the subject, so each build takes
 * milliseconds; what is asserted is how the id follows the bundle, which the stub does not change.
 */

/** Relative to the project root, which is where vitest runs (vitest.config.ts lives there). */
const ROOT = '.';

/** engine-src/*.ts exactly as this checkout has them, keyed `../engine-src/<name>.ts`. */
const SOURCES = import.meta.glob<string>('../engine-src/*.ts', {
	query: '?raw',
	import: 'default',
	eager: true,
});

/** `virtual:engine-assets` with one bundled TeX file whose base64 contents are `texFile`. */
const stubAssets = (texFile = 'AAAA'): Plugin => ({
	name: 'stub-assets',
	setup(build) {
		build.onResolve({ filter: /^virtual:engine-assets$/ }, () => ({ path: 'assets', namespace: 'stub' }));
		build.onLoad({ filter: /^assets$/, namespace: 'stub' }, () => ({
			contents: [
				`export const TEX_WASM_GZ = '';`,
				`export const CORE_DUMP_GZ = '';`,
				`export const TEX_FILES = ${JSON.stringify({ 'pgf.sty': texFile })};`,
				`export const ENGINE_ID = ${JSON.stringify(ENGINE_ID_PLACEHOLDER)};`,
				`export const INVENTORY = ${JSON.stringify({ engineId: ENGINE_ID_PLACEHOLDER })};`,
			].join('\n'),
			loader: 'js',
		}));
	},
});

/** Every engine-src file served with `eol` line endings, after `edit`, as another checkout would have it. */
const checkout = (
	eol: '\n' | '\r\n',
	edit: (name: string, text: string) => string = (_, t) => t,
): Plugin => ({
	name: 'checkout',
	setup(build) {
		build.onLoad({ filter: /[\\/]engine-src[\\/][\w-]+\.ts$/ }, (args) => {
			const name = /([\w-]+\.ts)$/.exec(args.path)?.[1] ?? '';
			const text = SOURCES[`../engine-src/${name}`];
			if (text === undefined) throw new Error(`no engine-src/${name} in this checkout`);
			return { contents: edit(name, text).split(/\r?\n/).join(eol), loader: 'ts' };
		});
	},
});

/** pako as some other release of it might be: the same exports, different code. */
const otherPako = (release: number): Plugin => ({
	name: 'other-pako',
	setup(build) {
		build.onResolve({ filter: /^pako$/ }, () => ({ path: 'pako', namespace: 'stub' }));
		build.onLoad({ filter: /^pako$/, namespace: 'stub' }, () => ({
			contents:
				`export const ungzip = (bytes) => bytes.subarray(${release});\n` +
				`export class Inflate { constructor() { this.chunks = []; this.release = ${release}; } push() {} }\n`,
			loader: 'js',
		}));
	},
});

const sha256 = async (text: string): Promise<string> =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

describe('ENGINE_ID', () => {
	it('is the sha256 of the worker that ships, written into it in place of the placeholder', async () => {
		const built = await buildWorker(ROOT, { plugins: [stubAssets()] });
		expect(built.engineId).toMatch(/^[0-9a-f]{64}$/);
		expect(built.source).not.toContain(ENGINE_ID_PLACEHOLDER);
		expect(built.source).toContain(built.engineId);
		expect(built.inventory.engineId).toBe(built.engineId);
		expect(await sha256(built.source.split(built.engineId).join(ENGINE_ID_PLACEHOLDER))).toBe(
			built.engineId,
		);
	});

	it('moves when a bundled TeX file changes under the same name', async () => {
		// The old id hashed `names.join('\n')`: a circuitikz or siunitx fix that kept its file names
		// left it where it was, and every diagram drawn with the old package stayed in the cache.
		const before = await buildWorker(ROOT, { plugins: [stubAssets('AAAA')] });
		const after = await buildWorker(ROOT, { plugins: [stubAssets('AAAB')] });
		expect(after.engineId).not.toBe(before.engineId);
	});

	it('moves when an npm package bundled into the worker changes', async () => {
		// dvi2html draws every SVG, and pako and buffer sit on the path to it; none of the three
		// was in the old list at all.
		const one = await buildWorker(ROOT, { plugins: [stubAssets(), otherPako(1)] });
		const two = await buildWorker(ROOT, { plugins: [stubAssets(), otherPako(2)] });
		expect(two.engineId).not.toBe(one.engineId);
	});

	it('is the same for a CRLF checkout and an LF one', async () => {
		// A Windows clone gets CRLF and a Linux one LF. An id that followed them would give one
		// commit two main.js, and a user moving between a local build and a release a full recompile.
		const asIs = await buildWorker(ROOT, { plugins: [stubAssets()] });
		const lf = await buildWorker(ROOT, { plugins: [stubAssets(), checkout('\n')] });
		const crlf = await buildWorker(ROOT, { plugins: [stubAssets(), checkout('\r\n')] });
		expect(crlf.source).toBe(lf.source);
		expect(crlf.engineId).toBe(lf.engineId);
		expect(asIs.engineId).toBe(lf.engineId);
	});

	it('is the same for a development build and a release build of one commit', async () => {
		const release = await buildWorker(ROOT, { plugins: [stubAssets()] });
		const development = await buildWorker(ROOT, { minify: false, plugins: [stubAssets()] });
		expect(development.source).not.toBe(release.source);
		expect(development.source).toContain(release.engineId);
		expect(development.engineId).toBe(release.engineId);
	});

	it('moves with the code, and not with a comment about it', async () => {
		const base = await buildWorker(ROOT, { plugins: [stubAssets(), checkout('\n')] });
		const commented = await buildWorker(ROOT, {
			plugins: [
				stubAssets(),
				checkout('\n', (name, text) => (name === 'worker.ts' ? `${text}\n// a note\n` : text)),
			],
		});
		const changed = await buildWorker(ROOT, {
			plugins: [
				stubAssets(),
				checkout('\n', (name, text) =>
					name === 'worker.ts'
						? text.split("const FIRST_JOB = 'input'").join("const FIRST_JOB = 'job'")
						: text,
				),
			],
		});
		expect(commented.engineId).toBe(base.engineId);
		expect(changed.engineId).not.toBe(base.engineId);
	});
});
