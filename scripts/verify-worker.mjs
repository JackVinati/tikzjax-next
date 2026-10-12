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
import { buildWorker, engineIsBuilt } from './engine-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(root, 'test', 'fixtures', 'tex');
const REFERENCE = join(root, 'engine-build', 'out', 'smoke');
const RESULTS = join(root, 'engine-build', 'out', 'worker');

if (!engineIsBuilt(root)) {
	console.error('No engine build. Run: npm run engine:image && npm run engine:build');
	process.exit(2);
}

// The production build's worker, minified and carrying its ENGINE_ID, from the same function the
// build calls, so the string evaluated here is the one a release puts into main.js.
console.log('Bundling the worker…');
const { source: workerSource, engineId } = await buildWorker(root);
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
// The id is written into the bundle after it is hashed. A worker announcing anything else — the
// placeholder, or an id from another build — would key every diagram it renders wrongly.
if (ready.engineId !== engineId || ready.inventory.engineId !== engineId) {
	console.error(`Worker announced ENGINE_ID ${ready.engineId}, the build computed ${engineId}.`);
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

// --- the blamed line, under a preamble of several lines -----------------------------------------
// TeX's l.NN counts the whole input file, preamble first. The worker reports the line the block
// starts on, so the plugin can name the block's own line: with a three-line preamble TeX blames a
// line two further down, and `bodyLine` has to move with it. The undefined control sequence in
// broken.tex is on its third line, whatever comes before it.
if (names.includes('broken')) {
	const source = readFileSync(join(FIXTURES, 'broken.tex'), 'utf8');
	const blamed = [];
	for (const addToPreamble of ['', '\\def\\a{1}\n\\def\\b{2}\n\\def\\c{3}']) {
		const reply = await send({
			type: 'render',
			id: ++id,
			source,
			options: { addToPreamble, captureLog: true },
		});
		blamed.push(
			reply.line === undefined || reply.bodyLine === undefined
				? `l.${reply.line} with bodyLine ${reply.bodyLine}`
				: reply.line - reply.bodyLine + 1,
		);
	}
	const ok = blamed.every((line) => line === 3);
	if (!ok) failures++;
	console.log(
		`${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  the blamed line is the block's line 3, ` +
			`with a one-line and a three-line preamble: ${blamed.join(', ')}`,
	);

	// An error in the preamble itself. The plugin finds the preamble's line by counting up from the
	// block — 0 is the preamble's last line (src/block/error-card.ts) — which holds only while the
	// worker writes the preamble's lines straight before the block and puts everything of its own
	// ahead of them on their first line. The undefined control sequence is on the preamble's line 2.
	const preamble = '\\def\\a{1}\n\\undefinedinthepreamble\n\\def\\c{3}';
	const reply = await send({
		type: 'render',
		id: ++id,
		source: '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}',
		options: { addToPreamble: preamble, captureLog: true },
	});
	const found =
		reply.line === undefined || reply.bodyLine === undefined
			? `l.${reply.line} with bodyLine ${reply.bodyLine}`
			: preamble.split('\n').length + (reply.line - reply.bodyLine + 1);
	if (found !== 2) failures++;
	console.log(
		`${found === 2 ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  an error in a three-line ` +
			`preamble is found on the preamble's line 2: ${found}`,
	);
}

process.exit(failures ? 1 : 0);
