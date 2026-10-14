/**
 * The record that holds OUTPUT_REVISION to the golden corpus (internal/DECISIONS.md D20).
 *
 *   node scripts/output-revision.mjs            say whether test/fixtures/golden/REVISION.json holds
 *   node scripts/output-revision.mjs --record   write it, under the rules below
 *
 * The cache key holds OUTPUT_REVISION (src/cache/key.ts), what the engine draws, instead of
 * ENGINE_ID, which build of it drew it. REVISION.json says what that revision stands for: the
 * output the golden corpus recorded for each fixture under it, as one sha256 per fixture over its
 * DVI's sha256, its transcript and its SVG, and the ENGINE_ID of the worker the corpus was last
 * checked against. test/output-revision.test.ts fails when a fixture's recorded output no longer
 * matches, and test/engine-id.test.ts when the worker is not that one.
 *
 * --record writes what the corpus and the worker are now, and refuses to write a changed output
 * under the revision it was recorded with: that is exactly the change the revision exists to
 * announce, so bump OUTPUT_REVISION first, and then every output is recorded under the new one. A
 * fixture added to the corpus is recorded, one taken out is dropped, and a new worker is recorded,
 * all without a bump — a worker that changes what a diagram outside the corpus draws still needs
 * one, by hand (CONTRIBUTING.md). `npm run verify:golden -- --update` records too, after the corpus.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GOLDEN = ['test', 'fixtures', 'golden'];
const RECORD = 'REVISION.json';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** OUTPUT_REVISION as src/cache/key.ts has it, read from the source: Node does not run TypeScript. */
export function outputRevision(root) {
	const text = readFileSync(join(root, 'src', 'cache', 'key.ts'), 'utf8');
	const m = /export const OUTPUT_REVISION = '([^']+)';/.exec(text);
	if (!m) throw new Error('src/cache/key.ts has no OUTPUT_REVISION');
	return m[1];
}

/**
 * Every fixture's recorded output, as one sha256: the DVI's sha256 from dvi.sha256, the transcript
 * and the SVG, null for a part the fixture does not have. Every fixture has a transcript, so the
 * transcripts are the list.
 */
export function goldenOutputs(root) {
	const dir = join(root, ...GOLDEN);
	const dvis = new Map();
	for (const line of readFileSync(join(dir, 'dvi.sha256'), 'utf8').split('\n')) {
		const m = /^([0-9a-f]{64}) {2}(.+)\.dvi$/.exec(line);
		if (m) dvis.set(m[2], m[1]);
	}
	const outputs = {};
	for (const file of readdirSync(dir)
		.filter((f) => f.endsWith('.log'))
		.sort()) {
		const name = file.slice(0, -'.log'.length);
		const svg = join(dir, `${name}.svg`);
		outputs[name] = sha256(
			JSON.stringify([
				dvis.get(name) ?? null,
				readFileSync(join(dir, file), 'utf8'),
				existsSync(svg) ? readFileSync(svg, 'utf8') : null,
			]),
		);
	}
	return outputs;
}

/** REVISION.json, or null when there is none. */
export function readRecord(root) {
	const path = join(root, ...GOLDEN, RECORD);
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** How the record and the corpus differ: outputs that changed, fixtures new to it, fixtures gone. */
export function compare(record, outputs) {
	const recorded = record?.outputs ?? {};
	const names = Object.keys(outputs);
	return {
		changed: names.filter((n) => n in recorded && recorded[n] !== outputs[n]),
		added: names.filter((n) => !(n in recorded)),
		gone: Object.keys(recorded).filter((n) => !(n in outputs)),
	};
}

/**
 * Write REVISION.json for the corpus as it is and the worker `engine`, unless an output changed
 * under the revision it was recorded with. Says what it did; `refused` lists the fixtures that kept
 * it from writing.
 */
export function record(root, engine) {
	const revision = outputRevision(root);
	const previous = readRecord(root);
	const outputs = goldenOutputs(root);
	const diff = compare(previous, outputs);
	const moved = previous === null || previous.revision !== revision;

	if (!moved && diff.changed.length > 0) return { written: false, refused: diff.changed, ...diff };

	const sorted = Object.fromEntries(Object.entries(outputs).sort(([a], [b]) => (a < b ? -1 : 1)));
	const next = { revision, engine, outputs: sorted };
	writeFileSync(join(root, ...GOLDEN, RECORD), `${JSON.stringify(next, null, 2)}\n`);
	return { written: true, refused: [], moved, ...diff };
}

/** What to tell a developer whose corpus changed under the revision it was recorded with. */
export function bumpAdvice(changed) {
	return (
		`The golden output of ${changed.join(', ')} changed under OUTPUT_REVISION, which would serve ` +
		'every user the diagrams they cached before it. Move OUTPUT_REVISION in src/cache/key.ts ' +
		'(the sha256 of the new worker is the convention), then run node scripts/output-revision.mjs ' +
		'--record. Say in the CHANGELOG that cached diagrams compile once more.'
	);
}

// --- the command ----------------------------------------------------------------------------------

// Only when run, not when a test or verify-golden.mjs imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const args = process.argv.slice(2);
	if (args.some((a) => a !== '--record')) {
		console.error('usage: node scripts/output-revision.mjs [--record]');
		process.exit(2);
	}
	const { buildWorker } = await import('./engine-assets.mjs');
	const { engineId } = await buildWorker(root);

	if (args.includes('--record')) {
		const result = record(root, engineId);
		if (!result.written) {
			console.error(bumpAdvice(result.refused));
			process.exit(1);
		}
		console.log(
			`Recorded ${Object.keys(goldenOutputs(root)).length} fixtures under OUTPUT_REVISION ` +
				`${outputRevision(root).slice(0, 12)}…, worker ${engineId.slice(0, 12)}…` +
				(result.added.length ? `\n  new: ${result.added.join(', ')}` : '') +
				(result.gone.length ? `\n  gone: ${result.gone.join(', ')}` : ''),
		);
		process.exit(0);
	}

	const previous = readRecord(root);
	const diff = compare(previous, goldenOutputs(root));
	const problems = [];
	if (previous === null) problems.push(`there is no ${RECORD}`);
	else {
		if (previous.revision !== outputRevision(root))
			problems.push('OUTPUT_REVISION moved since it was recorded');
		if (previous.engine !== engineId) problems.push(`the worker is ${engineId}, not ${previous.engine}`);
		if (diff.changed.length) problems.push(bumpAdvice(diff.changed));
		if (diff.added.length) problems.push(`not recorded yet: ${diff.added.join(', ')}`);
		if (diff.gone.length) problems.push(`recorded, but no longer in the corpus: ${diff.gone.join(', ')}`);
	}
	if (problems.length) {
		console.error(`${problems.join('\n')}\nRecord it with: node scripts/output-revision.mjs --record`);
		process.exit(1);
	}
	console.log(
		`${RECORD} holds: OUTPUT_REVISION ${previous.revision.slice(0, 12)}…, worker ${engineId.slice(0, 12)}…`,
	);
}
