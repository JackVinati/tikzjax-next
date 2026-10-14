/**
 * Runs the SHIPPED worker bundle — the exact string that goes into main.js — against every
 * fixture, and compares it to the reference SVGs from scripts/smoke.mjs.
 *
 *   node scripts/verify-worker.mjs
 *
 * verify-golden.mjs holds the engine and engine-src/library.ts to the recorded golden corpus. This
 * proves the whole artifact renders what they do: base64 decode, pako inflate, WebAssembly
 * compile, the conditional \begin{document} wrapping, \nonstopmode, error classification and the
 * message protocol. Everything between the source and the SVG, in the form the user will actually
 * install.
 *
 * The worker is evaluated in this realm with `self` shimmed rather than in a vm context, because
 * a second realm gives WebAssembly a different Uint8Array and the instantiation fails in ways
 * that have nothing to do with the code under test.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
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

/**
 * How long a job may go without a reply before it counts as one that never ends.
 *
 * A TeX run is synchronous, so this cannot stop one that loops. What it catches is a run that stops
 * without replying, which is what every fatal error did while the engine made jump_out's jump with
 * asyncify: the worker waited for a promise nothing would ever settle, and this script waited with
 * it, for good. The slowest fixture replies in about a second.
 */
const REPLY_WITHIN_MS = 60_000;

const send = (request) =>
	new Promise((resolve, reject) => {
		const before = inbox.length;
		const deadline = Date.now() + REPLY_WITHIN_MS;
		const settle = () => {
			const replies = inbox.slice(before).filter((m) => m.id === request.id && m.type !== 'log');
			if (replies.length) resolve(replies[replies.length - 1]);
			else if (Date.now() > deadline) reject(new Error(`no reply in ${REPLY_WITHIN_MS / 1000} s`));
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
/** Fixtures that rendered other than as expected, of all the failures counted. */
let fixtureFailures = 0;

/**
 * The fields of the reply a fixture names under `reply`, as `[field, expected, got]` for each that
 * differs. A failure fixture can say what the error card has to be told — the kind, and TeX's own
 * first error — and not merely that something went wrong.
 */
const unexpected = (reply, expected = {}) =>
	Object.entries(expected)
		.filter(([field, value]) => reply[field] !== value)
		.map(([field, value]) => [field, value, reply[field]]);

const basicSource = readFileSync(join(FIXTURES, 'basic.tex'), 'utf8');
const basicReference = existsSync(join(REFERENCE, 'basic.svg'))
	? readFileSync(join(REFERENCE, 'basic.svg'), 'utf8')
	: null;

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
	}).catch((error) => ({ type: 'none', message: error.message, durationMs: REPLY_WITHIN_MS }));

	const refPath = join(REFERENCE, `${name}.svg`);
	const reference = existsSync(refPath) ? readFileSync(refPath, 'utf8') : null;

	let ok;
	let detail;

	if (reply.type === 'none') {
		ok = false;
		detail = reply.message;
	} else if (expectUnsupported) {
		// A documented boundary. It must still fail CLEANLY — a classified error the user can read,
		// never a crash and never a silent blank — so the assertion is on the shape of the failure.
		ok = reply.type === 'error' && !!reply.message;
		detail = `limit: ${reply.type === 'error' ? reply.message : 'unexpectedly rendered'}`;
	} else if (expectFailure) {
		// The point of the failure fixture is a classified, explainable diagnostic — not a hang
		// and not a broken-image marker. Whether a diagram also comes out is a separate question:
		// under \nonstopmode TeX usually recovers and renders what it can, so this accepts either
		// an error message or a successful render that still reports what went wrong — unless the
		// fixture says which, under `reply`.
		const wrong = unexpected(reply, meta.reply);
		ok = !!reply.firstError && wrong.length === 0;
		detail = reply.firstError
			? `${reply.type === 'error' ? reply.kind : 'recovered'}: ${reply.firstError}${reply.line ? ` (line ${reply.line})` : ''}`
			: `${reply.type} with no diagnostic`;
		for (const [field, want, got] of wrong)
			detail += `\n      ${field}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
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

	if (!ok) {
		failures++;
		fixtureFailures++;
	}
	console.log(
		`${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(24)} ` +
			`${String(reply.durationMs ?? 0).padStart(5)} ms  ${detail}`,
	);
	if (!ok && reply.log?.length) for (const l of reply.log.slice(-6)) console.log(`      | ${l}`);

	// A run that failed must leave the worker as it found it: the plugin gives the same worker the
	// next diagram. So after each one, the plainest fixture again, which has to draw as it always does.
	if (expectFailure || expectUnsupported) {
		const next = await send({
			type: 'render',
			id: ++id,
			source: basicSource,
			options: { captureLog: true },
		}).catch((error) => ({ type: 'none', message: error.message }));
		const drew = next.type === 'ok' && basicReference !== null && next.svg === basicReference;
		if (!drew) failures++;
		console.log(
			`${drew ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${''.padEnd(24)} ` +
				`${String(next.durationMs ?? 0).padStart(5)} ms  then basic, ` +
				`${drew ? 'as drawn on its own' : next.type === 'ok' ? 'drawn differently' : `${next.type}: ${next.message}`}`,
		);
	}
}

console.log(`\n${names.length - fixtureFailures}/${names.length} match the reference render.`);

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

	// An error in something run as the document starts, behind a preamble that ends in a newline,
	// as a saved file usually does. The worker's \begin{document} is then on a line of its own, the
	// one just above the block, and the card names it only if that is the line TeX blames: 0.
	const hooked = await send({
		type: 'render',
		id: ++id,
		source: '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}',
		options: { addToPreamble: '\\AtBeginDocument{\\undefinedatbegindocument}\n', captureLog: true },
	});
	const begin =
		hooked.line === undefined || hooked.bodyLine === undefined
			? `l.${hooked.line} with bodyLine ${hooked.bodyLine}`
			: hooked.line - hooked.bodyLine + 1;
	if (begin !== 0) failures++;
	console.log(
		`${begin === 0 ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  an \\AtBeginDocument error ` +
			`behind a preamble ending in a newline is blamed on the \\begin{document} line, 0: ${begin}`,
	);
}

// --- deeper than the engine's stack ---------------------------------------------------------------
// Twenty thousand nested \number: each one's scan_int expands the next, a few calls deeper in the
// engine every time, and the worker's stack runs out long before any limit of TeX's own, so TeX says
// nothing. Not a fixture, because what it shows is the stack of the JavaScript engine running it, and
// smoke and verify-golden run TeX outside the worker. The reply has to say TeX ran out of room, not
// that it produced nothing, and the same worker has to draw `basic` afterwards.
{
	const deep = `\\edef\\y{${'\\number'.repeat(20_000)}7}\n\\begin{tikzpicture}\n\\node {\\y};\n\\end{tikzpicture}`;
	const reply = await send({ type: 'render', id: ++id, source: deep, options: { captureLog: true } }).catch(
		(error) => ({ type: 'none', message: error.message }),
	);
	const ok = reply.type === 'error' && reply.kind === 'capacity';
	if (!ok) failures++;
	console.log(
		`${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  a run deeper than the engine's stack is ` +
			`reported as capacity: ${reply.type === 'error' ? `${reply.kind}: ${reply.message}` : reply.type}`,
	);
	const next = await send({
		type: 'render',
		id: ++id,
		source: basicSource,
		options: { captureLog: true },
	}).catch((error) => ({ type: 'none', message: error.message }));
	const drew = next.type === 'ok' && basicReference !== null && next.svg === basicReference;
	if (!drew) failures++;
	console.log(
		`${drew ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${''.padEnd(24)} then basic, ` +
			`${drew ? 'as drawn on its own' : next.type === 'ok' ? 'drawn differently' : `${next.type}: ${next.message}`}`,
	);
}

// Smoke and verify-fork exercise the bare engine, so these literal Unicode fixtures live apart
// from that corpus. A worker with the bridge reverted must fail this check.
const window = new Window();
for (const twoPass of [false, true]) {
	const reply = await send({
		type: 'render',
		id: ++id,
		source: readFileSync(join(root, 'test', 'fixtures', 'worker', 'unicode-labels.tex'), 'utf8'),
		options: { captureLog: true, twoPass },
	});
	try {
		assert.equal(reply.type, 'ok', reply.message);
		assert.equal(reply.firstError, undefined);
		if (twoPass) assert.ok(reply.log.some((line) => line.includes('(tikzjax) second pass:')));
		// äöü, 45° and × stay with the engine and the TS1 shim, in Computer Modern; only what neither
		// draws comes back as sans-serif text, and no marker is left for the sanitizer to strip.
		assert.ok(!reply.svg.includes('data-tikzjax-unicode'), 'a marker is left in the SVG');
		const doc = new window.DOMParser().parseFromString(reply.svg, 'image/svg+xml');
		assert.equal(doc.documentElement.localName, 'svg');
		assert.equal(doc.querySelector('parsererror'), null);
		const restored = [...doc.querySelectorAll('text[font-family="sans-serif"]')];
		assert.deepEqual(
			restored.map((text) => text.textContent),
			['开始', 'Привет', '😀', 'Ωμέγα', '中文', '中文', '中文'],
		);
		for (const text of restored) {
			assert.equal(text.getAttribute('text-anchor'), 'middle');
			assert.ok(!/[\uF000-\uF8FF]/u.test(text.textContent), 'leftover proxy glyph');
		}
		writeFileSync(join(RESULTS, `unicode-labels-${twoPass ? 'two' : 'one'}-pass.svg`), reply.svg);
		console.log(`OK    Unicode labels (${twoPass ? 'two' : 'one'} pass)`);
	} catch (error) {
		failures++;
		console.error(`FAIL  Unicode labels: ${error.message}`);
	}
}
const broken = await send({
	type: 'render',
	id: ++id,
	source: readFileSync(join(root, 'test', 'fixtures', 'worker', 'unicode-broken-marker.tex'), 'utf8'),
	options: { captureLog: true },
});
if (broken.type !== 'error' || !broken.message.includes('unbalanced') || !broken.log?.length) {
	failures++;
	console.error('FAIL  Broken Unicode markers must return an error with the TeX log.');
} else console.log('OK    Broken Unicode markers report an error with the TeX log.');
await window.happyDOM.close();
process.exit(failures ? 1 : 0);
