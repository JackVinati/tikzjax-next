import { describe, expect, it } from 'vitest';
import { OUTPUT_REVISION } from '../src/cache/key';
import { bumpAdvice, compare, goldenOutputs, readRecord } from '../scripts/output-revision.mjs';

/**
 * A tripwire for OUTPUT_REVISION (src/cache/key.ts), as test/pipeline-revision.test.ts is one for
 * PIPELINE_REVISION.
 *
 * The cache key holds what the engine draws, not which build of the worker drew it, so a worker
 * that draws something differently moves no key by itself: without a bump, every user would go on
 * being shown what the previous engine drew for each diagram they had cached. The golden corpus is
 * what says the engine's output changed (`npm run verify:golden`), and test/fixtures/golden/
 * REVISION.json records that output under the revision it belongs to. A recorded fixture whose
 * output is not what was recorded fails here until OUTPUT_REVISION moves and the record is written
 * again (`node scripts/output-revision.mjs --record`, which refuses to write it before the bump).
 *
 * A fixture new to the corpus is recorded without a bump: nothing was cached from its output
 * before. The corpus does not reach every input, so a change the CHANGELOG announces as changing
 * what diagrams draw moves the revision by hand too (CONTRIBUTING.md).
 */

/** Relative to the project root, which is where vitest runs. */
const ROOT = '.';

describe('OUTPUT_REVISION', () => {
	const record = readRecord(ROOT);
	const outputs = goldenOutputs(ROOT);

	it('has a record, taken under the revision the key holds now', () => {
		expect(record, 'record it: node scripts/output-revision.mjs --record').not.toBeNull();
		expect(
			record?.revision,
			'OUTPUT_REVISION moved: record the golden outputs under it with ' +
				'node scripts/output-revision.mjs --record',
		).toBe(OUTPUT_REVISION);
	});

	it('was moved for every fixture whose output changed since it was recorded', () => {
		const { changed } = compare(record, outputs);
		expect(changed, changed.length ? bumpAdvice(changed) : '').toEqual([]);
	});

	it('records every fixture in the corpus, and none that is gone', () => {
		const { added, gone } = compare(record, outputs);
		expect(
			{ added, gone },
			'a fixture was added to or taken out of the golden corpus: record it, no bump needed, with ' +
				'node scripts/output-revision.mjs --record',
		).toEqual({ added: [], gone: [] });
		expect(Object.keys(outputs).length).toBeGreaterThanOrEqual(37);
	});

	it('tells a changed output from an unchanged one', () => {
		// The comparison itself, on a record that has one output moved, one fixture it has not seen
		// and one the corpus no longer has.
		const [first = '', second = ''] = Object.keys(outputs);
		const altered = {
			revision: OUTPUT_REVISION,
			engine: '',
			outputs: { ...outputs, [first]: '0'.repeat(64), gone: '1'.repeat(64) },
		};
		delete altered.outputs[second];
		expect(compare(altered, outputs)).toEqual({ changed: [first], added: [second], gone: ['gone'] });
	});
});
