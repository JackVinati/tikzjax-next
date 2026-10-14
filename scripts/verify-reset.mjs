/**
 * Holds the worker's reset of its Memory to a new Memory, byte for byte.
 *
 *   node scripts/verify-reset.mjs [--orders N]
 *
 * Since 0.2.1 a worker keeps one WebAssembly.Memory and, before each run of TeX, writes the core
 * dump back over only the parts of it the run before can have written, found from the memory's
 * layout, TeX's own counters and the engine's marks (engine-src/reset.ts, internal/DECISIONS.md
 * D31). A part it missed would carry one diagram's state into the next, silently. This proves it
 * does not, on the worker that ships, run as scripts/verify-worker.mjs runs it:
 *
 *  - every fixture, and the inputs below that take TeX where the fixtures do not, in five orders,
 *    each shuffled from its own fixed seed, in a worker of its own;
 *  - before every run of TeX, the Memory the worker hands it is compared with the core dump, all
 *    163,840,000 bytes of it, which is what a new Memory holds; with saved runs on, as the plugin
 *    sends every render (internal/DECISIONS.md D32), a first pass that resumes from a run an earlier
 *    one saved at the end of its \begin{document} must be handed the dump with that run's globals,
 *    as they stood when it was saved, and nothing else, so that the reset after a resumed run is held
 *    to what the run and the saved run's stretches wrote as well;
 *  - a run that jumped out of TeX, overflowed the engine's stack or was cut off at a line longer
 *    than TeX's buffer must leave a new Memory to the next, and every other run its own, reset;
 *  - each input must get the same reply in every order, and each fixture the SVG smoke recorded;
 *  - and, last, a run whose reset bookkeeping fails once TeX has ended must still be drawn, and
 *    leave a new Memory to the next.
 *
 * Exits 1 on any difference.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { tfmData } from '@drgrice1/dvi2html';
import { buildWorker, engineIsBuilt, readCoreDump, readMemoryLayout } from './engine-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(root, 'test', 'fixtures', 'tex');
const REFERENCE = join(root, 'engine-build', 'out', 'smoke');

const args = process.argv.slice(2);
const ORDERS = args.length === 0 ? 5 : args[0] === '--orders' && args.length === 2 ? Number(args[1]) : NaN;
if (!Number.isInteger(ORDERS) || ORDERS < 1) {
	console.error('usage: node scripts/verify-reset.mjs [--orders N]');
	process.exit(2);
}
if (!engineIsBuilt(root)) {
	console.error('No engine build. Run: npm run engine:image && npm run engine:build');
	process.exit(2);
}

console.log('Bundling the worker…');
const { source: workerSource, assets } = await buildWorker(root);
// What a new Memory holds, as one buffer to compare with: the whole dump, zeros included.
const fresh = Buffer.from(readCoreDump(root));
const layout = readMemoryLayout(root);

// --- the inputs ----------------------------------------------------------------------------------

const B = '\\';
const fixtures = readdirSync(FIXTURES)
	.filter((f) => f.endsWith('.tex'))
	.sort()
	.map((f) => {
		const name = basename(f, '.tex');
		const metaPath = join(FIXTURES, `${name}.json`);
		const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
		const reference = join(REFERENCE, `${name}.svg`);
		return {
			name,
			source: readFileSync(join(FIXTURES, f), 'utf8'),
			options: { ...meta.dataset, captureLog: true },
			reference:
				meta.expect === undefined && existsSync(reference) ? readFileSync(reference, 'utf8') : null,
		};
	});

const picture = (body) => `${B}begin{tikzpicture}${B}node{${body}};${B}end{tikzpicture}\n`;
let fractions = 'x';
for (let i = 0; i < 200; i++) fractions = `${B}frac{${fractions}}{2}`;
const letters = 'abcdefghijklmnopqrstuvwxyz'.repeat(400);

// Every font metric the engine can load: the ones dvi2html carries, which openSync tries first,
// among the faces the plugin ships, and the ones bundled with the TeX files. Each at a size of its
// own, so that TeX loads every one rather than finding it loaded.
const isBuiltIn = (name) => {
	try {
		tfmData(name);
		return true;
	} catch {
		return false;
	}
};
const metrics = [
	...new Set([
		...readdirSync(join(root, 'engine-build', 'out', 'dist', 'fonts'))
			.filter((f) => f.endsWith('.woff2'))
			.map((f) => basename(f, '.woff2'))
			.filter(isBuiltIn),
		...Object.keys(assets.files)
			.filter((f) => f.endsWith('.tfm'))
			.map((f) => basename(f, '.tfm')),
	]),
].sort();
const letterName = (i) => String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26));
const everyFont = metrics
	.map((name, i) => `${B}font${B}verify${letterName(i)}=${name} at ${5 + (i % 7)}pt`)
	.join('\n');
const manyNames = Array.from(
	{ length: 20_000 },
	(_, i) => `${B}expandafter${B}def${B}csname verify${i}${B}endcsname{${i}}\n`,
).join('');

const extra = [
	// A string TeX builds and flushes, 10,400 characters past where pool_ptr ends the run.
	[
		'detokenized',
		`${B}edef${B}a{${letters}}${B}edef${B}b{${B}detokenize${B}expandafter{${B}a}}\n${picture('x')}`,
	],
	// The shadow stack, 200 fractions down.
	['nested-fractions', picture(`$${fractions}$`)],
	// Deeper than the engine's stack: TeX is cut off, and the next run must take a new Memory.
	['stack-overflow', `${B}edef${B}y{${`${B}number`.repeat(20_000)}7}\n${picture(`${B}y`)}`],
	// TeX jumps out of its program, and the next run must take a new Memory.
	['fatal-error', `${B}input{no-such-file-anywhere}\n${picture('x')}`],
	// A line longer than TeX's buffer, which the host refuses: cut off, and a new Memory next.
	['long-line', `${B}def${B}x{${'a'.repeat(310_000)}}\n${picture('x')}`],
	// Two passes, the second on the first's Memory, reset.
	['two-passes', `${B}refstepcounter{equation}${B}label{e}\n${picture(`${B}ref{e}`)}`, { twoPass: true }],
	// A macro of 2,621,440 tokens: TeX's free list of one-word nodes runs dry, and hi_mem_min, which
	// no fixture moves, comes down from where the dump has it.
	[
		'free-list',
		`${B}def${B}a{abcdefghij}\n${`${B}edef${B}a{${B}a${B}a}\n`.repeat(18)}${picture('x')}`,
		{},
		['hi_mem_min', 1_000_000],
	],
	// A font's parameters grown past its own, and two \fontdimen errors, each of which writes the dummy
	// entry TeX keeps at fmem_ptr.
	[
		'font-parameters',
		`${B}font${B}fx=cmr10 at 11.5pt ${B}fontdimen99${B}fx=1pt ${B}font${B}fy=cmr12 at 13.5pt ` +
			`${B}fontdimen200${B}fx=2pt ${B}fontdimen0${B}fy=3pt\n${picture('x')}`,
	],
	// \dump where a document's body is.
	['dump', `${B}dump\n${picture('x')}`],
	// Every font metric at once: the reset trusts that none stops loading half-way, past fmem_ptr.
	['every-font', `${everyFont}\n${picture('x')}`],
	// 20,000 names, a line each, which overflow into the hash table's slots from hash_used down.
	['many-names', `${manyNames}${picture('x')}`, {}, ['hash_used', 10_000]],
	// e-TeX's pseudo-files, which \scantokens keeps in mem.
	[
		'scantokens',
		`${B}scantokens{}${B}scantokens{a}${B}scantokens{${'abc '.repeat(3000)}}\n${picture('x')}`,
	],
].map(([name, source, options = {}, lowers]) => ({
	name,
	source,
	options: { ...options, captureLog: true },
	reference: null,
	// The counter of TeX's the input is there to move, and by how much at least below where the dump
	// has it, checked after its run, so that an input that no longer reaches what it is for fails
	// instead of passing.
	lowers,
}));
const inputs = [...fixtures, ...extra];
console.log(
	`${fixtures.length} fixtures and ${extra.length} inputs of its own, one of them the ${metrics.length} ` +
		`font metrics the engine can load.\n`,
);

/** A fixed shuffle: mulberry32 from `seed`, then Fisher-Yates. */
function shuffled(list, seed) {
	let state = seed >>> 0;
	const random = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Which global, or which part of the memory, a byte lies in, to say where a reset fell short. */
function where(offset) {
	for (const [name, v] of Object.entries(layout.variables))
		if (offset >= v.offset && offset < v.offset + v.bytes)
			return v.entry ? `${name}[${(v.min ?? 0) + Math.floor((offset - v.offset) / v.entry)}]` : name;
	if (offset < layout.dataEnd) return 'the string literals';
	return `the stack, ${layout.pages * 65536 - offset} B below the top`;
}

// --- the Memory each run of TeX is handed ----------------------------------------------------------

/** Every run of TeX in the order being checked: the Memory it was handed, and how that went. */
let runs = [];

/** The end of the last 4 KiB block that holds any of TeX's globals. */
const globalsLimit = Math.ceil(layout.globalsEnd / 4096) * 4096;

/** The blocks of 4 KiB of `memory` below `limit` that differ from the dump, each with a copy of its bytes. */
function differingBlocks(memory, limit) {
	const out = [];
	for (let at = 0; at < limit; at += 4096) {
		const end = Math.min(at + 4096, limit);
		if (memory.subarray(at, end).equals(fresh.subarray(at, end))) continue;
		out.push({ offset: at, bytes: Buffer.from(memory.subarray(at, end)) });
	}
	return out;
}

/** Where in a block of differingBlocks it first differs from the dump. */
function firstDifference(block) {
	for (let i = 0; i < block.bytes.length; i++) if (block.bytes[i] !== fresh[block.offset + i]) return i;
	return 0;
}

/** Whether two lists of differingBlocks are the same blocks with the same bytes. */
const sameBlocks = (a, b) =>
	a.length === b.length &&
	a.every((block, i) => block.offset === b[i].offset && block.bytes.equals(b[i].bytes));

/** What a computer's worker may hold of saved runs (src/platform/budgets.ts), sent with every render. */
const SNAPSHOT_BUDGET = 32 * 1024 * 1024;
/** Whether the engine's marks throw when the worker reads them (the last check below). */
let faultyMarks = false;
const realInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (module, imports, ...rest) {
	const memory = imports?.env?.memory;
	if (!(memory instanceof WebAssembly.Memory) || imports.library === undefined)
		return realInstantiate.call(this, module, imports, ...rest);
	const got = Buffer.from(memory.buffer);
	// Where the Memory differs from the dump, in blocks of 4 KiB, with their bytes: nothing for a run
	// from the start, and the saved run's stretches for one that resumes.
	const differs = got.equals(fresh) ? [] : differingBlocks(got, got.length);
	const first = differs.length === 0 ? -1 : differs[0].offset + firstDifference(differs[0]);
	const run = { memory, differs, first, abnormal: false, saved: null };
	runs.push(run);
	// TeX's jump out of its program goes through the host's jumpOut (engine-src/library.ts), which
	// is the one way a run ends that the reply does not always say.
	const library = { ...imports.library };
	library.jumpOut = (...a) => {
		run.abnormal = true;
		return imports.library.jumpOut(...a);
	};
	// At \tikzjaxsnapshot, TeX's globals as they stand, where they differ from the dump: what a run
	// resumed from this one, if the worker keeps it, must be handed, and nothing else.
	library.snapshotPoint = (...a) => {
		if (run.saved === null) run.saved = differingBlocks(got, globalsLimit);
		return imports.library.snapshotPoint(...a);
	};
	const instance = realInstantiate.call(this, module, { ...imports, library }, ...rest);
	if (!faultyMarks) return instance;
	// The engine's marks failing as the worker reads them after TeX has ended, for the check below.
	return instance.then(({ exports }) => ({
		exports: {
			...exports,
			getStackLow: () => {
				throw new RangeError('a fault in the bookkeeping, put there by verify-reset');
			},
		},
	}));
};

// --- run -------------------------------------------------------------------------------------------

/** A new worker, as verify-worker.mjs starts one, started from the payload; returns how to ask it. */
async function startWorker() {
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
	if (!inbox.some((m) => m.type === 'ready')) throw new Error('the worker did not start');
	let id = 0;
	return (input, snapshots = SNAPSHOT_BUDGET) =>
		new Promise((resolve, reject) => {
			const request = {
				type: 'render',
				id: ++id,
				source: input.source,
				options: input.options,
				snapshots,
			};
			const deadline = Date.now() + 120_000;
			const settle = () => {
				const reply = inbox.find(
					(m) => m.id === request.id && (m.type === 'ok' || m.type === 'error'),
				);
				if (reply) resolve(reply);
				else if (Date.now() > deadline) reject(new Error('no reply in 120 s'));
				else setTimeout(settle, 2);
			};
			onmessage({ data: request });
			settle();
		});
}

/** A reply as every order must give it: what it says, not how long it took. */
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

let failures = 0;
const replies = new Map();
const totals = { runs: 0, reused: 0, fresh: 0, afterAbnormal: 0, resumed: 0 };

for (let order = 1; order <= ORDERS; order++) {
	const seed = 0x5eed0000 + order;
	const list = shuffled(inputs, seed);
	const send = await startWorker();
	runs = [];
	/** The globals of each run this worker saved, at \tikzjaxsnapshot (differingBlocks). */
	const saves = [];
	let orderFailures = 0;
	const fail = (what) => {
		orderFailures++;
		console.log(`\x1b[31mFAIL\x1b[0m  order ${order}, ${what}`);
	};

	for (const input of list) {
		const before = runs.length;
		const reply = await send(input);
		const mine = runs.slice(before);
		// A run cut off by the engine's stack, or at a line longer than TeX's buffer, says so in the
		// reply, and it is the render's last run.
		if (
			reply.type === 'error' &&
			reply.kind === 'capacity' &&
			/engine's stack|a line longer than its buffer/.test(reply.message)
		)
			mine[mine.length - 1].abnormal = true;

		// A first pass that saved its run at \tikzjaxsnapshot, which later ones may resume from.
		if (reply.timings?.saveMs !== undefined && mine[0]?.saved) saves.push(mine[0].saved);
		const resumed = reply.timings?.resumed === true;
		for (const run of mine) {
			const previous = runs[runs.indexOf(run) - 1];
			const reused = previous !== undefined && run.memory === previous.memory;
			totals.runs++;
			if (reused) totals.reused++;
			else totals.fresh++;
			if (resumed && run === mine[0]) {
				// The dump with the globals of a run the worker saved, as they stood when it was
				// saved, and nothing else: whatever the run before wrote, and whatever the run this
				// one resumes from had, was put back.
				totals.resumed++;
				if (!saves.some((saved) => sameBlocks(saved, run.differs)))
					fail(
						`${input.name}: resumed on a Memory that is not the dump with a saved run's globals: ` +
							`${run.differs.length} block(s) of 4 KiB differ from the dump, first at byte ${run.first}, ` +
							`in ${where(run.first)}`,
					);
			} else if (run.differs.length > 0)
				fail(
					`${input.name}: the Memory TeX was handed differs from a new one in ${run.differs.length} ` +
						`block(s) of 4 KiB, first at byte ${run.first}, in ${where(run.first)}`,
				);
			if (previous === undefined) continue;
			// After a run that did not end normally, a new Memory; after any other, the worker's own.
			if (previous.abnormal) {
				totals.afterAbnormal++;
				if (reused) fail(`${input.name}: handed the Memory of a run that did not end normally`);
			} else if (!reused) fail(`${input.name}: handed a new Memory after a run that ended normally`);
		}

		// The Memory the run ended with is not reset until the next run starts, so TeX's counters are
		// still where the run left them.
		if (input.lowers !== undefined && mine.length > 0) {
			const [counter, by] = input.lowers;
			const { offset } = layout.variables[counter];
			const reached = Buffer.from(mine[mine.length - 1].memory.buffer).readInt32LE(offset);
			const dumped = fresh.readInt32LE(offset);
			if (reached > dumped - by)
				fail(
					`${input.name}: ${counter} came down from ${dumped} to ${reached}, not by ${by} or more`,
				);
		}
		if (
			input.name === 'every-font' &&
			(reply.type !== 'ok' || reply.log.some((l) => /not loadable/.test(l)))
		)
			fail(`every-font: not all ${metrics.length} font metrics loaded`);

		const said = gist(reply);
		const earlier = replies.get(input.name);
		if (earlier === undefined) replies.set(input.name, said);
		else if (earlier !== said) fail(`${input.name}: a different reply from the order before`);
		if (input.reference !== null && reply.svg !== input.reference)
			fail(`${input.name}: not the SVG smoke recorded`);
	}

	failures += orderFailures;
	console.log(
		`${orderFailures ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mOK  \x1b[0m'}  order ${order} (seed ${seed.toString(16)}): ` +
			`${list.length} inputs, ${runs.length} runs of TeX, beginning ${list
				.slice(0, 3)
				.map((i) => i.name)
				.join(', ')}…`,
	);
}

console.log(
	`\n${totals.runs} runs of TeX: ${totals.reused} on the worker's Memory, reset, and ${totals.fresh} on a new ` +
		`one, ${totals.afterAbnormal} of them after a run that did not end normally; ${totals.resumed} ` +
		`resumed from a run saved at the end of its \\begin{document}.`,
);
if (totals.reused === 0) {
	failures++;
	console.log('\x1b[31mFAIL\x1b[0m  no run reused a Memory: the reset was never exercised');
}
if (totals.resumed === 0) {
	failures++;
	console.log(
		'\x1b[31mFAIL\x1b[0m  no run resumed from a saved run: the reset after one was never exercised',
	);
}

// A fault in the reset's own bookkeeping, after TeX has ended well, must cost the next run a new
// Memory and never this run's diagram: `basic` with the marks throwing as the worker reads them must
// still be drawn as smoke drew it, and the run after it must be handed a new Memory equal to the dump.
{
	const basic = inputs.find((input) => input.name === 'basic');
	const send = await startWorker();
	runs = [];
	faultyMarks = true;
	const reply = await send(basic, 0);
	faultyMarks = false;
	const next = await send(basic, 0);
	// As smoke drew it where smoke has run, and as the run after it draws it in any case.
	const asDrawn = (r) =>
		r.type === 'ok' && r.svg.includes('<svg') && (basic.reference === null || r.svg === basic.reference);
	const drawn = asDrawn(reply) && reply.svg === next.svg;
	const renewed = runs.length === 2 && runs[1].memory !== runs[0].memory && runs[1].differs.length === 0;
	const ok = drawn && renewed && asDrawn(next);
	if (!ok) failures++;
	console.log(
		`${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  a reset whose bookkeeping fails costs a new ` +
			`Memory, not the diagram: ${drawn ? 'drawn' : `${reply.type}: ${reply.message}`}, ` +
			`${renewed ? 'then a new Memory' : 'then not a new Memory equal to the dump'}`,
	);
}
console.log(
	failures
		? `\n${failures} failure(s).`
		: '\nEvery Memory TeX was handed equals a new one, byte for byte, or for a resumed run a new one with the ' +
				'globals of the run it resumed from, and every input got the same reply in every order.',
);
process.exit(failures ? 1 : 0);
