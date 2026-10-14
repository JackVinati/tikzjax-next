import { builtinModules } from 'node:module';
import { mkdir, copyFile, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';
import { buildWorker as buildEngineWorker, engineIsBuilt } from './engine-assets.mjs';
import { buildStyles, fontsPlugin } from './gen-styles.mjs';
import { assertMobileSafe } from './check-mobile.mjs';
import { banners } from './banner.mjs';

const prod = process.argv[2] === 'production';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Where the source is and what is embedded under which licence: scripts/banner.mjs.
const banner = banners(root);

// Only the @codemirror packages that still exist in CM6. The upstream config listed 21, of which
// 13 (closebrackets, comment, fold, gutter, highlight, history, matchbrackets, panel, rangeset,
// rectangular-selection, stream-parser, text, tooltip) were folded into other packages years ago
// and are dead weight in the externals list.
const codemirror = [
	'@codemirror/autocomplete',
	'@codemirror/collab',
	'@codemirror/commands',
	'@codemirror/language',
	'@codemirror/lint',
	'@codemirror/search',
	'@codemirror/state',
	'@codemirror/view',
];
const lezer = ['@lezer/common', '@lezer/highlight', '@lezer/lr'];

const external = ['obsidian', 'electron', ...codemirror, ...lezer, ...builtinModules];

/**
 * The TeX worker is bundled separately and injected into the main bundle as a string constant,
 * because it runs as a Worker created from a Blob — Obsidian's community installer only ever
 * fetches main.js, manifest.json and styles.css, so a sibling worker file would not reach users.
 *
 * ENGINE_ID is the sha256 of the worker itself (scripts/engine-assets.mjs, buildWorker). It names
 * the build: change anything the worker runs and it moves. Since 0.2.1 the cache key holds
 * OUTPUT_REVISION instead (src/cache/key.ts), which moves only when what the engine draws does.
 */
async function buildWorker() {
	const entry = join(root, 'engine-src', 'worker.ts');
	try {
		await access(entry);
	} catch {
		return { source: '', engineId: 'unbuilt', inventory: null };
	}

	if (!engineIsBuilt(root)) {
		// Refuse rather than emit a plugin whose engine is an empty string: that would install
		// cleanly and then fail at the first diagram with something unhelpful.
		throw new Error(
			'engine-build/out/ is missing or incomplete.\n' +
				'Build the TeX engine first:  npm run engine:image && npm run engine:build',
		);
	}

	const { source, engineId, stats, inventory } = await buildEngineWorker(root, { minify: prod });
	const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
	console.log(
		`  worker ${mb(source.length)}  (wasm ${mb(stats.wasmGz)} + dump ${mb(stats.dumpGz)} gz, ` +
			`${stats.texFiles} tex files ${mb(stats.texFilesBytes)} b64)  ENGINE_ID ${engineId.slice(0, 12)}…`,
	);
	return { source, engineId, inventory };
}

const { source: workerSource, engineId, inventory: engineInventory } = await buildWorker();

const styles = buildStyles(root, banner.css);
{
	const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
	console.log(
		`  styles.css ${kb(styles.coreBytes)} (${styles.core} core faces) + ` +
			`${kb(styles.coldBytes)} cold in main.js (${styles.cold} faces)`,
	);
}

/** Resolves `virtual:engine` to the built worker string. Keeps the 7 MB payload out of the source tree. */
const virtualEngine = {
	name: 'virtual-engine',
	setup(build) {
		build.onResolve({ filter: /^virtual:engine$/ }, () => ({
			path: 'virtual:engine',
			namespace: 'virtual',
		}));
		build.onLoad({ filter: /^virtual:engine$/, namespace: 'virtual' }, () => ({
			contents:
				`export const WORKER_SOURCE = ${JSON.stringify(workerSource)};\n` +
				`export const ENGINE_ID = ${JSON.stringify(engineId)};\n` +
				// The file list, package versions and capabilities, known at build time. The main
				// thread needs them BEFORE the worker has booted — and a session that only shows cached
				// diagrams never boots it at all. ~10 KB; the worker string above carries a copy too.
				`export const ENGINE_INVENTORY = ${JSON.stringify(engineInventory)};\n`,
			loader: 'js',
		}));
	},
};

/** Copies the built plugin into a real vault so the hot-reload plugin picks it up. */
const deploy = {
	name: 'deploy',
	setup(build) {
		const dir = process.env.OBSIDIAN_PLUGIN_DIR;
		if (!dir) return;
		build.onEnd(async (result) => {
			if (result.errors.length) return;
			await mkdir(dir, { recursive: true });
			for (const f of ['main.js', 'manifest.json', 'styles.css']) {
				await copyFile(join(root, f), join(dir, f)).catch(() => {});
			}
			await writeFile(join(dir, '.hotreload'), '');
			console.log(`  deployed -> ${dir}`);
		});
	},
};

const options = {
	entryPoints: [join(root, 'src', 'main.ts')],
	outfile: join(root, 'main.js'),
	bundle: true,
	external,
	format: 'cjs',
	platform: 'browser',
	target: 'es2022',
	banner: { js: banner.js },
	minify: prod,
	sourcemap: prod ? false : 'inline',
	legalComments: 'none',
	treeShaking: true,
	logLevel: 'info',
	plugins: [virtualEngine, fontsPlugin(root, styles.coldCss), deploy],
};

if (prod) {
	await esbuild.build(options);

	// Against the artifact, not the source: what ships is what has to parse on a phone, and it is
	// the bundler's output — dependencies included — that decides. 0.1.0 shipped a lookbehind and
	// no iPhone could enable it. See scripts/check-mobile.mjs.
	assertMobileSafe(await readFile(options.outfile, 'utf8'), 'main.js');
} else {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('watching…');
}
