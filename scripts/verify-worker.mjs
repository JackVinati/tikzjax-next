/**
 * Runs the SHIPPED worker bundle — the exact string that goes into main.js — against every
 * fixture, and compares it to the reference SVGs from scripts/smoke.mjs.
 *
 *   node scripts/verify-worker.mjs
 *
 * verify-fork.mjs proves engine-src/library.ts matches upstream. This proves the whole artifact
 * does: base64 decode, pako inflate, WebAssembly compile, the conditional \begin{document}
 * wrapping, \nonstopmode, error classification and the message protocol. Everything between the
 * source and the SVG, in the form the user will actually install.
 *
 * The worker is evaluated in this realm with `self` shimmed rather than in a vm context, because
 * a second realm gives WebAssembly a different Uint8Array and the instantiation fails in ways
 * that have nothing to do with the code under test.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { engineAssetsPlugin, engineIsBuilt } from './engine-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(root, 'test', 'fixtures', 'tex');
const REFERENCE = join(root, 'engine-build', 'out', 'smoke');
const RESULTS = join(root, 'engine-build', 'out', 'worker');

if (!engineIsBuilt(root)) {
	console.error('No engine build. Run: npm run engine:image && npm run engine:build');
	process.exit(2);
}

console.log('Bundling the worker…');
const built = await esbuild.build({
	entryPoints: [join(root, 'engine-src', 'worker.ts')],
	bundle: true,
	write: false,
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	logLevel: 'warning',
	plugins: [engineAssetsPlugin(root)],
});
const workerSource = built.outputFiles[0].text;
console.log(`  ${(workerSource.length / 1048576).toFixed(2)} MB\n`);

// --- boot it ---------------------------------------------------------------------------------
const inbox = [];
let onmessage = null;
globalThis.self = {
	postMessage: (m) => inbox.push(m),
	set onmessage(fn) {
		onmessage = fn;
	},
	get onmessage() {
		return onmessage;
	},
};

const t0 = Date.now();
new Function(workerSource)();
const bootMs = Date.now() - t0;

const ready = inbox.find((m) => m.type === 'ready');
if (!ready) {
	console.error('Worker never signalled ready. Messages:', inbox);
	process.exit(1);
}
console.log(
	`ready in ${bootMs} ms — engine ${ready.inventory.engine}, ` +
		`${ready.inventory.files.length} tex files, expl3=${ready.inventory.capabilities.expl3}, ` +
		`ENGINE_ID ${ready.engineId.slice(0, 12)}…\n`,
);

const send = (request) =>
	new Promise((resolve, reject) => {
		const before = inbox.length;
		const settle = () => {
			const replies = inbox.slice(before).filter((m) => m.id === request.id && m.type !== 'log');
			if (replies.length) resolve(replies[replies.length - 1]);
			else setTimeout(settle, 5);
		};
		try {
			onmessage({ data: request });
			settle();
		} catch (e) {
			reject(e);
		}
	});

// --- compare ----------------------------------------------------------------------------------
mkdirSync(RESULTS, { recursive: true });

const names = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.tex'))
	.map((f) => basename(f, '.tex'))
	.filter((n) => process.argv.length <= 2 || process.argv.slice(2).includes(n));

let id = 0;
let failures = 0;

for (const name of names) {
	const source = readFileSync(join(FIXTURES, `${name}.tex`), 'utf8');
	const metaPath = join(FIXTURES, `${name}.json`);
	const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
	const expectFailure = meta.expect === 'failure';
	const expectUnsupported = meta.expect === 'unsupported';

	const reply = await send({
		type: 'render',
		id: ++id,
		source,
		options: { ...(meta.dataset ?? {}), captureLog: true },
	});

	const refPath = join(REFERENCE, `${name}.svg`);
	const reference = existsSync(refPath) ? readFileSync(refPath, 'utf8') : null;

	let ok;
	let detail;

	if (expectUnsupported) {
		// A documented boundary. It must still fail CLEANLY — a classified error the user can read,
		// never a crash and never a silent blank — so the assertion is on the shape of the failure.
		ok = reply.type === 'error' && !!reply.message;
		detail = `limit: ${reply.type === 'error' ? reply.message : 'unexpectedly rendered'}`;
	} else if (expectFailure) {
		// The point of the failure fixture is a classified, explainable diagnostic — not a hang
		// and not a broken-image marker. Whether a diagram also comes out is a separate question:
		// under \nonstopmode TeX usually recovers and renders what it can, so this accepts either
		// an error message or a successful render that still reports what went wrong.
		ok = !!reply.firstError;
		detail = reply.firstError
			? `${reply.type === 'error' ? reply.kind : 'recovered'}: ${reply.firstError}${reply.line ? ` (line ${reply.line})` : ''}`
			: `${reply.type} with no diagnostic`;
	} else if (reply.type !== 'ok') {
		ok = false;
		detail = `${reply.kind}: ${reply.message}`;
	} else {
		writeFileSync(join(RESULTS, `${name}.svg`), reply.svg);
		ok = reference !== null && reply.svg === reference;
		detail =
			reference === null
				? 'no reference — run npm run smoke first'
				: ok
					? `${reply.svg.length} B`
					: `${reply.svg.length} B vs reference ${reference.length} B`;
	}

	if (!ok) failures++;
	console.log(
		`${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(24)} ` +
			`${String(reply.durationMs ?? 0).padStart(5)} ms  ${detail}`,
	);
	if (!ok && reply.log?.length) for (const l of reply.log.slice(-6)) console.log(`      | ${l}`);
}

console.log(`\n${names.length - failures}/${names.length} match the reference render.`);
process.exit(failures ? 1 : 0);
