/**
 * Holds a diagram drawn from a saved run to the same diagram drawn from the start, byte for byte.
 *
 *   node scripts/verify-snapshot.mjs [name ...]
 *
 * Since 0.2.1 the worker saves a first pass where the engine's \tikzjaxsnapshot stands, at the end of
 * its \begin{document}, and a later diagram whose input is the same up to there starts from that
 * saved run and compiles only its body (engine-src/snapshot.ts, internal/DECISIONS.md D32). What a
 * resumed run draws must be what a run from the start draws, and this proves it on the build that
 * ships, against itself: nothing here reads the golden corpus, which is recorded again whenever what
 * the engine draws changes, so the proof holds across that too.
 *
 * Every fixture and every case in ./snapshot-hazards.mjs is drawn with two bodies under one
 * preamble: a hazard's own two, or a fixture and a body of its own written under the fixture's
 * preamble. For each:
 *
 *  - in the engine, run here as the worker runs it, with the worker's own modules: the first body
 *    and the second from the start; the first again, saving its run; the first and the second
 *    resumed from that run, and the second again with the stack above TeX's globals filled with
 *    0xAA, which no run may read before it writes; and the same with the bodies swapped. The DVI,
 *    TeX's terminal output, its transcript file input.log, the files TeX did not find and every other
 *    file it wrote must be the same, byte for byte. At each save, every byte of TeX's globals that
 *    differs from the core dump must lie in what the save compared (engine-src/snapshot.ts
 *    saveSpans): a save that missed a byte would start a later diagram from a state the first one
 *    did not have;
 *  - in the worker that ships, run as verify-worker runs it: each body from the start, then saved,
 *    resumed from its own run and resumed from the other body's, every field of every reply the
 *    plugin reads the same as from the start, and each saved or resumed as the case says;
 *  - and in the worker, a save that fails, at its first copy or at its comparison with the dump,
 *    keeps nothing, draws the diagram as from the start, says so, and is counted.
 *
 * Exits 1 on any difference.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { importEngineForNode } from './dvi2html-patch.mjs';
import {
	buildWorker,
	engineIsBuilt,
	packCoreDump,
	readMemoryLayout,
	workerLayout,
} from './engine-assets.mjs';
import { readEngineFile } from './engine-files.mjs';
import { HAZARDS } from './snapshot-hazards.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'engine-build', 'out');
const FIXTURES = join(root, 'test', 'fixtures', 'tex');
const ONLY = process.argv.slice(2);

/** What the host lets a computer's worker hold of saved runs (src/platform/budgets.ts). */
const BUDGET = 32 * 1024 * 1024;

if (!engineIsBuilt(root)) {
	console.error('No engine build. Run: npm run engine:image && npm run engine:build');
	process.exit(2);
}

// --- the cases -------------------------------------------------------------------------------------

const B = '\\';
const DOCUMENT_START = /\\begin\s*\{document\}/;
/** The body a fixture's second diagram has, under the fixture's preamble. */
const OTHER_BODY = `${B}begin{tikzpicture}${B}draw[red] (0,0) -- (2,1) node[right] {other};${B}end{tikzpicture}`;

/**
 * A block under `source`'s preamble with a body of its own: what comes before the end of the line of
 * its \begin{document}, if it has one, then OTHER_BODY, then the whole of `source` as comments, so
 * that the TS1 shim and the Unicode bridge, which go by what characters the block has, put on the
 * first line what they put there for `source`.
 */
function otherBody(source, options) {
	const commented = source
		.split('\n')
		.map((line) => `% ${line}`)
		.join('\n');
	const own = options.wrap !== 'always' && DOCUMENT_START.test(source);
	if (!own) return `${OTHER_BODY}\n${commented}`;
	const m = DOCUMENT_START.exec(source);
	const end = source.indexOf('\n', m.index);
	return `${source.slice(0, end + 1)}${OTHER_BODY}\n${commented}\n${B}end{document}`;
}

const fixtures = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.tex'))
	.sort()
	.map((f) => {
		const name = basename(f, '.tex');
		const metaPath = join(FIXTURES, `${name}.json`);
		const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
		const source = readFileSync(join(FIXTURES, f), 'utf8').replace(/\r\n/g, '\n');
		const options = { ...meta.dataset };
		return { name, why: 'a fixture', options, bodies: [source, otherBody(source, options)] };
	});

/**
 * Fixtures that never reach the end of their \begin{document}, so nothing is saved: each ends in a
 * fatal error in its preamble.
 */
const UNSAVED_FIXTURES = new Set(['missing-pgfplots-library']);

const cases = [
	...fixtures.map((c) => ({ ...c, save: !UNSAVED_FIXTURES.has(c.name) })),
	...HAZARDS.map((h) => ({ ...h, name: `hazard ${h.name}` })),
].filter((c) => ONLY.length === 0 || ONLY.some((name) => c.name === name || c.name === `hazard ${name}`));

let failures = 0;
const fail = (what) => {
	failures++;
	console.log(`\x1b[31mFAIL\x1b[0m  ${what}`);
};
const pass = (what) => console.log(`\x1b[32mOK  \x1b[0m  ${what}`);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// --- in the engine ---------------------------------------------------------------------------------

console.log('The engine, run here as the worker runs it…');
const lib = await importEngineForNode(root, 'tikz-snapshot');
const code = new WebAssembly.Module(readEngineFile(OUT, 'tex.wasm'));
const dumpBytes = new Uint8Array(readEngineFile(OUT, 'core.dump'));
const packed = packCoreDump(dumpBytes);
const dump = lib.unpackCoreDump(packed.size, packed.runs, packed.bytes);
const layout = workerLayout(readMemoryLayout(root));

const bundled = new Map();
for (const entry of readdirSync(join(OUT, 'dist', 'tex_files')))
	if (entry.endsWith('.gz'))
		bundled.set(entry.slice(0, -3), new Uint8Array(readFileSync(join(OUT, 'dist', 'tex_files', entry))));
lib.setBundledFiles(bundled, (gz) => new Uint8Array(gunzipSync(gz)));
let transcript = [];
let missed = [];
lib.setLogSink((line) => transcript.push(line));
lib.setMissingFileSink((name) => {
	if (!missed.includes(name)) missed.push(name);
});

/** How many bytes of TeX's globals differ from the dump outside `spans`, sorted and apart. */
function outside(view, spans) {
	let count = 0;
	let s = 0;
	for (let at = 0; at < layout.globalsEnd; at += 4096) {
		const end = Math.min(at + 4096, layout.globalsEnd);
		if (Buffer.compare(view.subarray(at, end), dumpBytes.subarray(at, end)) === 0) continue;
		for (let i = at; i < end; i++) {
			if (view[i] === dumpBytes[i]) continue;
			while (s < spans.length && spans[s][1] <= i) s++;
			if (s >= spans.length || spans[s][0] > i) count++;
		}
	}
	return count;
}

/**
 * One run of TeX over `text`: from the dump, or from `resume`, a run saved by this function; saving
 * itself where \tikzjaxsnapshot stands when `save` is set. What it wrote, and the saved run if any.
 */
async function runTeX(text, logging, files, { save = false, resume = null, garbage = false } = {}) {
	transcript = [];
	missed = [];
	const input = new TextEncoder().encode(text);
	const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	const view = new Uint8Array(memory.buffer);
	view.set(dumpBytes);
	if (resume !== null) {
		lib.writeStretches(view, resume.stretches);
		if (garbage) view.fill(0xaa, layout.dataEnd);
	}
	lib.setMemory(memory.buffer);
	if (logging) lib.setShowConsole();
	lib.writeFileSync('input.tex', input);
	if (resume !== null) {
		transcript.push(...resume.log);
		missed.push(...resume.missing);
		lib.restoreHostState(resume.host, { 'input.tex': input });
	} else lib.setInput('input.tex\n\\end\n');

	let exports = null;
	let saved = null;
	let stray = 0;
	if (save) {
		lib.watchJobFile('input.tex');
		lib.setSnapshotHook(() => {
			if (saved !== null) return;
			saved = false;
			const read = lib.jobFileRead();
			if (read === undefined) return;
			const marks = {
				poolPtrHigh: exports.getPoolPtrHigh(),
				strPtrHigh: exports.getStrPtrHigh(),
				stackLow: exports.getStackLow(),
			};
			const spans = lib.saveSpans(view, layout, marks, lib.hostWrites());
			if (spans === undefined) return;
			stray = outside(view, spans);
			saved = {
				prefix: new TextDecoder().decode(input.subarray(0, read)),
				stretches: lib.diffAgainstDump(
					spans.map(([a, b]) => ({ offset: a, bytes: view.subarray(a, b) })),
					dump,
				),
				host: lib.captureHostState(),
				log: [...transcript],
				missing: [...missed],
			};
		});
	}
	const result = { error: null };
	try {
		const instance = await WebAssembly.instantiate(code, { library: lib, env: { memory } });
		exports = instance.exports;
		result.ended = await lib.executeAsync(instance.exports);
	} catch (error) {
		result.error = error instanceof Error ? error.constructor.name : String(error);
	}
	const read = (name) => {
		try {
			return sha(lib.readFileSync(name));
		} catch {
			return null;
		}
	};
	result.dvi = read('input.dvi');
	result.inputLog = (() => {
		try {
			return new TextDecoder().decode(lib.readFileSync('input.log'));
		} catch {
			return null;
		}
	})();
	result.files = Object.fromEntries(['input.aux', ...files].map((name) => [name, read(name)]));
	result.transcript = transcript.join('\n');
	result.missing = [...missed];
	lib.setSnapshotHook(null);
	lib.watchJobFile(null);
	lib.deleteEverything();
	return { result: JSON.stringify(result), saved: saved || null, stray };
}

let engineRuns = 0;
let engineResumed = 0;
for (const c of cases) {
	const logging = true;
	const files = c.files ?? [];
	const [b1, b2] = c.bodies.map((body) => lib.buildInput(body, c.options).text);
	const cold1 = await runTeX(b1, logging, files);
	const cold2 = await runTeX(b2, logging, files);
	const saving1 = await runTeX(b1, logging, files, { save: true });
	const saving2 = await runTeX(b2, logging, files, { save: true });
	engineRuns += 4;
	const wrong = [];
	if (saving1.result !== cold1.result) wrong.push('the first body, saving, against from the start');
	if (saving2.result !== cold2.result) wrong.push('the second body, saving, against from the start');
	const expectSave = c.save !== false;
	if (Boolean(saving1.saved) !== expectSave || Boolean(saving2.saved) !== expectSave)
		wrong.push(expectSave ? 'not saved' : 'saved, where nothing may be');
	if (saving1.stray + saving2.stray > 0)
		wrong.push(
			`${saving1.stray + saving2.stray} byte(s) of TeX's globals changed outside what the save compared`,
		);
	const resumes = [];
	if (saving1.saved) resumes.push([saving1.saved, b1, cold1, 'the first body from its own run']);
	if (saving2.saved) resumes.push([saving2.saved, b2, cold2, 'the second body from its own run']);
	const shared = expectSave && c.shared !== false;
	if (shared && saving1.saved && saving2.saved) {
		if (!b2.startsWith(saving1.saved.prefix) || !b1.startsWith(saving2.saved.prefix))
			wrong.push('the two bodies do not share the text their runs were saved under');
		else {
			resumes.push([saving1.saved, b2, cold2, "the second body from the first's run"]);
			resumes.push([saving2.saved, b1, cold1, "the first body from the second's run"]);
		}
	}
	if (!shared && saving1.saved && b2.startsWith(saving1.saved.prefix))
		wrong.push("the second body shares the text the first's run was saved under");
	for (const [run, text, cold, what] of resumes) {
		for (const garbage of [false, true]) {
			const resumed = await runTeX(text, logging, files, { resume: run, garbage });
			engineRuns++;
			engineResumed++;
			if (resumed.result !== cold.result)
				wrong.push(`${what}${garbage ? ', the stack filled with 0xAA,' : ''} against from the start`);
		}
	}
	if (wrong.length) fail(`engine  ${c.name}: ${wrong.join('; ')}`);
	else
		pass(
			`engine  ${c.name}: ${expectSave ? `saved, ${resumes.length * 2} resumed runs` : 'not saved'}, all as from the start`,
		);
}

// --- in the worker that ships ----------------------------------------------------------------------

console.log('\nThe worker that ships…');
const { source: workerSource, assets } = await buildWorker(root);

/** What the fault below does when it is armed: which copies in the save fail, or none. */
let fault = null;
const realInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (module, imports, ...rest) {
	if (imports?.library === undefined || fault === null)
		return realInstantiate.call(this, module, imports, ...rest);
	const armed = fault;
	const library = { ...imports.library };
	library.snapshotPoint = (...a) => {
		const slice = Uint8Array.prototype.slice;
		let calls = 0;
		Uint8Array.prototype.slice = function (start, end) {
			calls++;
			const length = (end ?? this.length) - (start ?? 0);
			if (armed === 'first' ? calls === 1 : length >= 256)
				throw new RangeError('Out of memory, put there by verify-snapshot');
			return slice.call(this, start, end);
		};
		try {
			return imports.library.snapshotPoint(...a);
		} finally {
			Uint8Array.prototype.slice = slice;
		}
	};
	return realInstantiate.call(this, module, { ...imports, library }, ...rest);
};

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
new Function(workerSource)();
onmessage({ data: { type: 'boot', assets } });
for (let waited = 0; !inbox.some((m) => m.type === 'ready') && waited < 60_000; waited += 2)
	await new Promise((resolve) => setTimeout(resolve, 2));
if (!inbox.some((m) => m.type === 'ready')) {
	console.error('the worker did not start');
	process.exit(1);
}
let id = 0;
const send = (source, options, snapshots) =>
	new Promise((resolve, reject) => {
		const request = {
			type: 'render',
			id: ++id,
			source,
			options: { ...options, captureLog: true },
			snapshots,
		};
		const deadline = Date.now() + 120_000;
		const settle = () => {
			const reply = inbox.find((m) => m.id === request.id && (m.type === 'ok' || m.type === 'error'));
			if (reply) resolve(reply);
			else if (Date.now() > deadline) reject(new Error('no reply in 120 s'));
			else setTimeout(settle, 2);
		};
		onmessage({ data: request });
		settle();
	});

/** A reply as a diagram resumed must give it: everything the plugin reads but how long it took. */
const gist = (reply) =>
	JSON.stringify({
		type: reply.type,
		svg: reply.svg,
		kind: reply.kind,
		message: reply.message,
		firstError: reply.firstError,
		line: reply.line,
		bodyLine: reply.bodyLine,
		log: reply.log,
		missing: reply.missing,
		passes: reply.timings?.passes,
	});
const how = (reply) =>
	reply.timings?.resumed ? 'resumed' : reply.timings?.saveMs !== undefined ? 'saved' : 'from the start';

let workerResumed = 0;
let workerSaved = 0;
for (const c of cases) {
	const [b1, b2] = c.bodies;
	const o = c.options;
	const cold1 = await send(b1, o, 0);
	const cold2 = await send(b2, o, 0);
	const saved1 = await send(b1, o, BUDGET);
	const own1 = await send(b1, o, BUDGET);
	const other2 = await send(b2, o, BUDGET);
	await send(b2, o, 0);
	const saved2 = await send(b2, o, BUDGET);
	const other1 = await send(b1, o, BUDGET);
	const replies = [
		['saved', saved1, cold1, 'the first body'],
		['own', own1, cold1, 'the first body again'],
		['other', other2, cold2, 'the second body'],
		['saved', saved2, cold2, 'the second body, after the runs were let go'],
		['other', other1, cold1, 'the first body again'],
	];
	const expectSave = c.save !== false;
	const shared = expectSave && c.shared !== false;
	const wrong = [];
	for (const [role, reply, cold, what] of replies) {
		if (gist(reply) !== gist(cold)) wrong.push(`${what} (${how(reply)}) is not as from the start`);
		const want = !expectSave
			? 'from the start'
			: role === 'saved'
				? 'saved'
				: role === 'own' || shared
					? 'resumed'
					: 'saved';
		if (how(reply) !== want) wrong.push(`${what} was ${how(reply)}, not ${want}`);
		if (how(reply) === 'resumed') workerResumed++;
		if (how(reply) === 'saved') workerSaved++;
		if (reply.timings?.saveFailed) wrong.push(`${what}: a save failed`);
	}
	// The host sends a diagram to the worker that holds the name of its run (engine-src/document.ts).
	const route = lib.routeOf(lib.buildInput(b1, { ...o, captureLog: true }).text, true);
	if (expectSave && !saved1.snapshots?.held.includes(route))
		wrong.push('the worker does not hold the run under the name the host gives it');
	if (!expectSave && (saved1.snapshots?.held.length ?? 0) > 0) wrong.push('the worker holds a run');
	if (wrong.length) fail(`worker  ${c.name}: ${wrong.join('; ')}`);
	else pass(`worker  ${c.name}: ${replies.map(([, reply]) => how(reply)).join(', ')}`);
}

// A save that fails, at its first copy or at its comparison with the dump: nothing is kept, the
// diagram is drawn as from the start and says the save failed, the worker counts it, and the next
// diagram saves again.
{
	const basic = fixtures.find((c) => c.name === 'basic');
	for (const where of ['first', 'large']) {
		const cold = await send(basic.bodies[0], basic.options, 0);
		const before = cold.snapshots?.failures ?? 0;
		fault = where;
		const failed = await send(basic.bodies[0], basic.options, BUDGET);
		fault = null;
		const next = await send(basic.bodies[0], basic.options, BUDGET);
		const ok =
			gist(failed) === gist(cold) &&
			failed.timings?.saveFailed === true &&
			failed.snapshots?.failures === before + 1 &&
			failed.snapshots?.held.length === 0 &&
			gist(next) === gist(cold) &&
			how(next) === 'saved';
		if (ok)
			pass(
				`a save that fails at ${where === 'first' ? 'its first copy' : 'its comparison with the dump'} keeps nothing and the diagram is drawn as from the start`,
			);
		else
			fail(
				`a save that fails at ${where === 'first' ? 'its first copy' : 'its comparison with the dump'}: ` +
					`${failed.type} ${how(failed)}, saveFailed ${failed.timings?.saveFailed}, failures ${failed.snapshots?.failures}, ` +
					`then ${how(next)}`,
			);
	}
}
WebAssembly.instantiate = realInstantiate;

console.log(
	`\n${cases.length} cases. In the engine, ${engineRuns} runs, ${engineResumed} of them resumed; in the worker, ` +
		`${workerSaved} renders saved and ${workerResumed} resumed.`,
);
if (engineResumed === 0 || workerResumed === 0) fail('nothing was resumed: the snapshot was never exercised');
console.log(
	failures
		? `\n${failures} failure(s).`
		: '\nEvery diagram resumed from a saved run is as from the start, byte for byte.',
);
process.exit(failures ? 1 : 0);
