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
 *    163,840,000 bytes of it, which is what a new Memory holds;
 *  - a run that jumped out of TeX or overflowed the engine's stack must leave a new Memory to the
 *    next, and every other run its own, reset;
 *  - each input must get the same reply in every order, and each fixture the SVG smoke recorded.
 *
 * Exits 1 on any difference.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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
	// Two passes, the second on the first's Memory, reset.
	['two-passes', `${B}refstepcounter{equation}${B}label{e}\n${picture(`${B}ref{e}`)}`, { twoPass: true }],
].map(([name, source, options = {}]) => ({
	name,
	source,
	options: { ...options, captureLog: true },
	reference: null,
}));
const inputs = [...fixtures, ...extra];

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
const realInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (module, imports, ...rest) {
	const memory = imports?.env?.memory;
	if (!(memory instanceof WebAssembly.Memory) || imports.library === undefined)
		return realInstantiate.call(this, module, imports, ...rest);
	const got = Buffer.from(memory.buffer);
	let first = -1;
	let blocks = 0;
	if (!got.equals(fresh)) {
		for (let at = 0; at < got.length; at += 65536) {
			const end = Math.min(at + 65536, got.length);
			if (got.subarray(at, end).equals(fresh.subarray(at, end))) continue;
			blocks++;
			for (let i = at; i < end && first < 0; i++) if (got[i] !== fresh[i]) first = i;
		}
	}
	const run = { memory, equal: first < 0, first, blocks, abnormal: false };
	runs.push(run);
	// TeX's jump out of its program goes through the host's jumpOut (engine-src/library.ts), which
	// is the one way a run ends that the reply does not always say.
	const library = { ...imports.library };
	library.jumpOut = (...a) => {
		run.abnormal = true;
		return imports.library.jumpOut(...a);
	};
	return realInstantiate.call(this, module, { ...imports, library }, ...rest);
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
	return (input) =>
		new Promise((resolve, reject) => {
			const request = { type: 'render', id: ++id, source: input.source, options: input.options };
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
const totals = { runs: 0, reused: 0, fresh: 0, afterAbnormal: 0 };

for (let order = 1; order <= ORDERS; order++) {
	const seed = 0x5eed0000 + order;
	const list = shuffled(inputs, seed);
	const send = await startWorker();
	runs = [];
	let orderFailures = 0;
	const fail = (what) => {
		orderFailures++;
		console.log(`\x1b[31mFAIL\x1b[0m  order ${order}, ${what}`);
	};

	for (const input of list) {
		const before = runs.length;
		const reply = await send(input);
		const mine = runs.slice(before);
		// A run cut off by the engine's stack says so in the reply, and it is the render's last run.
		if (reply.type === 'error' && reply.kind === 'capacity' && /engine's stack/.test(reply.message))
			mine[mine.length - 1].abnormal = true;

		for (const run of mine) {
			const previous = runs[runs.indexOf(run) - 1];
			const reused = previous !== undefined && run.memory === previous.memory;
			totals.runs++;
			if (reused) totals.reused++;
			else totals.fresh++;
			if (!run.equal)
				fail(
					`${input.name}: the Memory TeX was handed differs from a new one in ${run.blocks} ` +
						`block(s) of 64 KiB, first at byte ${run.first}, in ${where(run.first)}`,
				);
			if (previous === undefined) continue;
			// After a run that did not end normally, a new Memory; after any other, the worker's own.
			if (previous.abnormal) {
				totals.afterAbnormal++;
				if (reused) fail(`${input.name}: handed the Memory of a run that did not end normally`);
			} else if (!reused) fail(`${input.name}: handed a new Memory after a run that ended normally`);
		}

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
		`one, ${totals.afterAbnormal} of them after a run that did not end normally.`,
);
if (totals.reused === 0) {
	failures++;
	console.log('\x1b[31mFAIL\x1b[0m  no run reused a Memory: the reset was never exercised');
}
console.log(
	failures
		? `\n${failures} failure(s).`
		: '\nEvery Memory TeX was handed equals a new one, byte for byte, and every input got the same reply in every order.',
);
process.exit(failures ? 1 : 0);
