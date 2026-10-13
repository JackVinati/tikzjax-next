import { buildSync, type Plugin } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorker, encodeCoreDump, ENGINE_ID_PLACEHOLDER } from '../scripts/engine-assets.mjs';

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

// buildWorker reads the committed engine before any plugin stands in for it, and the first time a
// process does, it packs the core dump (scripts/engine-assets.mjs `encodeCoreDump`): about 3 s on
// the desktop, and five times as long under coverage. Done once here, with a limit to match, so it
// does not land on whichever test runs first.
beforeAll(() => {
	encodeCoreDump(ROOT);
}, 120_000);

/**
 * A file's text exactly as this checkout has it.
 *
 * Through esbuild's text loader, as test/twopass.test.ts reads the worker, because tsconfig keeps
 * Node's types out of this project. Not `import.meta.glob`: vitest caches the expanded glob with
 * the test file, so a file added to engine-src/ would be missing from it until the cache went.
 */
function readText(path: string): string {
	const [out] = buildSync({
		entryPoints: [path],
		loader: { '.ts': 'text' },
		write: false,
		format: 'iife',
		globalName: 'TEXT',
	}).outputFiles;
	if (!out) throw new Error(`esbuild produced no output for ${path}`);
	return new Function(`${out.text}\nreturn TEXT;`)() as string;
}

/** The core dump as the worker carries it: its size, its non-zero runs, and their bytes. */
interface StubDump {
	size: number;
	runs: number[];
	gz: string;
}

const STUB_DUMP: StubDump = { size: 65536, runs: [16, 4], gz: 'AAAA' };

/**
 * `virtual:engine-assets` with one bundled TeX file whose base64 contents are `texFile`, and the
 * core dump `dump`.
 */
const stubAssets = (texFile = 'AAAA', dump = STUB_DUMP): Plugin => ({
	name: 'stub-assets',
	setup(build) {
		build.onResolve({ filter: /^virtual:engine-assets$/ }, () => ({ path: 'assets', namespace: 'stub' }));
		build.onLoad({ filter: /^assets$/, namespace: 'stub' }, () => ({
			contents: [
				`export const TEX_WASM_GZ = '';`,
				`export const CORE_DUMP_SIZE = ${dump.size};`,
				`export const CORE_DUMP_RUNS = ${JSON.stringify(dump.runs)};`,
				`export const CORE_DUMP_GZ = ${JSON.stringify(dump.gz)};`,
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
			return { contents: edit(name, readText(args.path)).split(/\r?\n/).join(eol), loader: 'ts' };
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

// Each build is quick, but the first in a process reads and encodes the committed engine, and under
// coverage on a loaded machine that alone has taken 10 s, twice vitest's default.
describe('ENGINE_ID', { timeout: 60_000 }, () => {
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

	it('moves when the core dump changes, in its bytes, where they go, or its size', async () => {
		// The dump ships as its non-zero runs (scripts/engine-assets.mjs `packCoreDump`), so the
		// whole of it is the three of these together: zeros that became something, or something that
		// moved, change the runs, and zeros added at the end change only the size.
		const ids = new Set<string>();
		for (const dump of [
			STUB_DUMP,
			{ ...STUB_DUMP, gz: 'AAAB' },
			{ ...STUB_DUMP, runs: [17, 4] },
			{ ...STUB_DUMP, size: 131072 },
		]) {
			ids.add((await buildWorker(ROOT, { plugins: [stubAssets('AAAA', dump)] })).engineId);
		}
		expect(ids.size).toBe(4);
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
