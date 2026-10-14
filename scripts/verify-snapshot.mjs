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
 *    plugin reads the same as from the start, and each saved or resumed as the case says; once with
 *    TeX's log kept, the plugin's default, and once without, which a saved run is kept apart by, and
 *    a run saved with the log kept never starts a diagram without it;
 *  - and in the worker, a save that fails, at its first copy or at its comparison with the dump,
 *    keeps nothing, draws the diagram as from the start, says so, and is counted;
 *  - resumed from storage (engine-src/stored-run.ts, internal/DECISIONS.md D36): in the engine, each
 *    saved run written out as bytes, gzipped and gunzipped, read back and resumed from; in the
 *    worker, the bytes the shipped worker hands the host for each run it saves, sent back with a
 *    render to a second worker that holds no run, as the host sends a stored run after the engine
 *    stopped, the same as from the start, and kept there for the next diagram; and a stored run with
 *    a byte changed, or of another engine, refused and the diagram drawn as from the start.
 *
 * Exits 1 on any difference.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
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

/** Which files of a run are the worker's own (library.ts change 14), as the worker names them. */
const sources = { originOf: lib.storedOriginOf, contentOf: lib.storedContentOf };

/**
 * `saved` as a host keeps it and sends it back: written out as bytes, gzipped as the platform's gzip
 * does it, gunzipped, and read back (engine-src/stored-run.ts). The checksum is read too.
 */
function throughStorage(saved, logging) {
	const raw = lib.encodeSavedRun(
		{ ...saved, logging, route: 'verify', spans: [], bytes: 0 },
		'verify',
		sources,
	);
	return lib.decodeSavedRun(
		new Uint8Array(gunzipSync(gzipSync(raw))),
		'verify',
		layout.globalsEnd,
		sources,
	);
}

let engineRuns = 0;
let engineResumed = 0;
let engineStored = 0;
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
		// The same run as a host keeps it across the engine's stops, and sends it back.
		let stored;
		try {
			stored = throughStorage(run, logging);
		} catch (error) {
			wrong.push(`${what}: written out, it does not read back (${error.message})`);
			continue;
		}
		const resumed = await runTeX(text, logging, files, { resume: stored });
		engineRuns++;
		engineResumed++;
		engineStored++;
		if (resumed.result !== cold.result) wrong.push(`${what}, through storage, against from the start`);
	}
	if (wrong.length) fail(`engine  ${c.name}: ${wrong.join('; ')}`);
	else
		pass(
			`engine  ${c.name}: ${expectSave ? `saved, ${resumes.length * 3} resumed runs, ${resumes.length} through storage` : 'not saved'}, all as from the start`,
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
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	set onmessage(fn) {
		onmessage = fn;
	},
	get onmessage() {
		return onmessage;
	},
};
/**
 * A worker of the build that ships, started as the host starts one. Two of them: the first saves
 * and hands its runs over, and the second, which holds none, is sent them back, as a worker started
 * after the first stopped is. Both post into one inbox; each reply carries the id it answers.
 */
async function startWorker() {
	new Function(workerSource)();
	const handler = onmessage;
	const before = inbox.filter((m) => m.type === 'ready').length;
	handler({ data: { type: 'boot', assets } });
	for (
		let waited = 0;
		inbox.filter((m) => m.type === 'ready').length === before && waited < 60_000;
		waited += 2
	)
		await new Promise((resolve) => setTimeout(resolve, 2));
	if (inbox.filter((m) => m.type === 'ready').length === before) {
		console.error('the worker did not start');
		process.exit(1);
	}
	return handler;
}
const first = await startWorker();
const second = await startWorker();
let id = 0;
const send = (source, options, snapshots, captureLog = true, extra = {}, worker = first) =>
	new Promise((resolve, reject) => {
		const request = {
			type: 'render',
			id: ++id,
			source,
			options: { ...options, captureLog },
			snapshots,
			...extra,
		};
		const deadline = Date.now() + 120_000;
		const settle = () => {
			const reply = inbox.find((m) => m.id === request.id && (m.type === 'ok' || m.type === 'error'));
			if (reply) resolve(reply);
			else if (Date.now() > deadline) reject(new Error('no reply in 120 s'));
			else setTimeout(settle, 2);
		};
		worker({ data: request });
		settle();
	});

/** The run the worker handed over after the render `reply` answers, once it has: within 60 s. */
async function handedOver(reply) {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const message = inbox.find((m) => m.type === 'saved-run' && m.id === reply.id);
		if (message) return message;
		if (Date.now() > deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A diagram that lets every saved run the second worker holds go, as the switch turned off does. */
const letGo = () => send('\\draw (0,0) -- (1,1);', {}, 0, true, {}, second);

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
	reply.timings?.resumed
		? 'resumed'
		: reply.timings?.saveNotKept
			? 'not kept'
			: reply.timings?.saveMs !== undefined
				? 'saved'
				: 'from the start';

let workerResumed = 0;
let workerSaved = 0;
let workerStored = 0;
// The log kept, as the plugin keeps it by default, and not, as the setting can have it.
for (const logging of [true, false])
	for (const c of cases) {
		const [b1, b2] = c.bodies;
		const o = c.options;
		const ask = (body, budget, extra = {}, worker = first) =>
			send(body, o, budget, logging, extra, worker);
		const cold1 = await ask(b1, 0);
		const cold2 = await ask(b2, 0);
		const saved1 = await ask(b1, BUDGET, { persist: true });
		// Handed over only for a run the host can name, which it can find again (engine-src/document.ts).
		const named =
			lib.routeOf(lib.buildInput(b1, { ...o, captureLog: logging }).text, logging) !== undefined;
		const stored1 = how(saved1) === 'saved' && named ? await handedOver(saved1) : undefined;
		const own1 = await ask(b1, BUDGET);
		const other2 = await ask(b2, BUDGET);
		await ask(b2, 0);
		const saved2 = await ask(b2, BUDGET);
		const other1 = await ask(b1, BUDGET);
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
		const route = lib.routeOf(lib.buildInput(b1, { ...o, captureLog: logging }).text, logging);
		// Or, where the host can give it none, under a name of its own.
		if (
			expectSave &&
			(route === undefined
				? saved1.snapshots?.held.length !== 1
				: !saved1.snapshots?.held.includes(route))
		)
			wrong.push('the worker does not hold the run under the name the host gives it');
		if (!expectSave && (saved1.snapshots?.held.length ?? 0) > 0) wrong.push('the worker holds a run');

		// Through storage: the run the first worker handed over, sent with the same diagram to the
		// second, which holds none, as after the engine stopped; then the other body, which resumes from
		// it in memory where the two share their preamble; then, after letting it go, the other body
		// sent the stored run, which it starts from where they share it and refuses as not its own
		// where they do not.
		const storage = [];
		if (expectSave && route !== undefined) {
			if (stored1 === undefined) wrong.push('the worker handed over no run for the host to keep');
			else {
				const copy = () => ({ ...stored1.run, data: stored1.run.data.slice(0) });
				const back1 = await ask(b1, BUDGET, { stored: copy() }, second);
				const then2 = await ask(b2, BUDGET, {}, second);
				await letGo();
				const back2 = await ask(b2, BUDGET, { stored: copy() }, second);
				await letGo();
				for (const [reply, cold, what, outcome, way] of [
					[back1, cold1, 'the first body from storage', 'used', 'resumed'],
					[then2, cold2, 'the second body after it', undefined, shared ? 'resumed' : 'saved'],
					[
						back2,
						cold2,
						'the second body from storage',
						shared ? 'used' : 'mismatch',
						shared ? 'resumed' : 'saved',
					],
				]) {
					if (gist(reply) !== gist(cold))
						wrong.push(`${what} (${how(reply)}) is not as from the start`);
					if (reply.stored !== outcome)
						wrong.push(`${what}: the stored run was ${reply.stored}, not ${outcome}`);
					if (how(reply) !== way) wrong.push(`${what} was ${how(reply)}, not ${way}`);
					if (outcome === 'used' && reply.timings?.restored !== true)
						wrong.push(`${what} does not say it was restored`);
					if (reply.stored === 'used') workerStored++;
					storage.push(reply.stored === 'used' ? 'restored' : how(reply));
				}
			}
		}
		const where = logging ? 'worker ' : 'worker, log off,';
		if (wrong.length) fail(`${where} ${c.name}: ${wrong.join('; ')}`);
		else
			pass(
				`${where} ${c.name}: ${replies.map(([, reply]) => how(reply)).join(', ')}` +
					(storage.length ? `; through storage: ${storage.join(', ')}` : ''),
			);
	}

// A run saved with the log kept says again what TeX had said by then, which a diagram drawn without
// the log never says: it saves a run of its own, and resumes from that.
{
	const basic = fixtures.find((c) => c.name === 'basic');
	const [body] = basic.bodies;
	const cold = await send(body, basic.options, 0, false);
	const withLog = await send(body, basic.options, BUDGET, true);
	const without = await send(body, basic.options, BUDGET, false);
	const again = await send(body, basic.options, BUDGET, false);
	if (
		how(withLog) === 'saved' &&
		how(without) === 'saved' &&
		how(again) === 'resumed' &&
		gist(without) === gist(cold) &&
		gist(again) === gist(cold) &&
		again.log.length === 0
	)
		pass('a run saved with the log kept starts no diagram drawn without it');
	else
		fail(
			`a run saved with the log kept, then the same diagram without: ${how(withLog)}, ${how(without)}, ${how(again)}`,
		);
}

// A stored run as a platform without its own gzip keeps it, uncompressed, iOS before 16.4: resumed
// from, the same as from the start. And a stored run with a byte changed, gzipped or not, or cut
// short, is refused: the diagram is drawn as from the start, and the host told to delete it.
{
	const basic = fixtures.find((c) => c.name === 'basic');
	const [body] = basic.bodies;
	const cold = await send(body, basic.options, 0);
	const saving = await send(body, basic.options, BUDGET, true, { persist: true });
	const message = await handedOver(saving);
	await letGo();
	const raw = new Uint8Array(gunzipSync(new Uint8Array(message.run.data)));
	const plain = () => ({ ...message.run, compressed: false, data: raw.slice().buffer });
	const changed = (stored, at) => {
		const data = new Uint8Array(stored.data.slice(0));
		data[at] ^= 0x40;
		return { ...stored, data: data.buffer };
	};
	const fromPlain = await send(body, basic.options, BUDGET, true, { stored: plain() }, second);
	await letGo();
	// A stored run larger than what the worker may hold is started from all the same, and not kept.
	const tooLarge = await send(body, basic.options, 1024, true, { stored: plain() }, second);
	await letGo();
	if (
		tooLarge.stored === 'used' &&
		how(tooLarge) === 'resumed' &&
		gist(tooLarge) === gist(cold) &&
		tooLarge.snapshots?.held.length === 0
	)
		pass('a stored run larger than the budget is started from, as from the start, and not kept');
	else
		fail(
			`a stored run larger than the budget: ${tooLarge.stored}, ${how(tooLarge)}, holding ${tooLarge.snapshots?.held.length}`,
		);
	const outcomes = [];
	for (const stored of [
		changed(message.run, 10),
		changed(message.run, Math.floor(message.run.data.byteLength / 2)),
		{ ...message.run, data: message.run.data.slice(0, message.run.data.byteLength - 9) },
		changed(plain(), Math.floor(raw.length / 2)),
		changed(plain(), raw.length - 1),
		{ ...plain(), data: raw.slice(0, raw.length - 8).buffer },
	]) {
		const reply = await send(body, basic.options, BUDGET, true, { stored }, second);
		await letGo();
		outcomes.push(
			`${reply.stored}, ${how(reply)}, ${gist(reply) === gist(cold) ? 'as from the start' : 'NOT as from the start'}`,
		);
	}
	if (fromPlain.stored === 'used' && how(fromPlain) === 'resumed' && gist(fromPlain) === gist(cold))
		pass('a stored run kept uncompressed is resumed from, as from the start');
	else fail(`a stored run kept uncompressed: ${fromPlain.stored}, ${how(fromPlain)}`);
	if (outcomes.every((o) => o === 'corrupt, saved, as from the start'))
		pass(
			'a stored run with a byte changed, gzipped or not, or cut short, is refused, and the diagram drawn as from the start',
		);
	else fail(`a stored run with a byte changed, or cut short: ${outcomes.join('; ')}`);
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
	`\n${cases.length} cases. In the engine, ${engineRuns} runs, ${engineResumed} of them resumed, ${engineStored} ` +
		`through storage; in the worker, ${workerSaved} renders saved and ${workerResumed} resumed, ` +
		`${workerStored} from a run sent back from storage.`,
);
if (engineResumed === 0 || workerResumed === 0) fail('nothing was resumed: the snapshot was never exercised');
if (engineStored === 0 || workerStored === 0) fail('nothing was resumed from storage');
console.log(
	failures
		? `\n${failures} failure(s).`
		: '\nEvery diagram resumed from a saved run is as from the start, byte for byte.',
);
process.exit(failures ? 1 : 0);
