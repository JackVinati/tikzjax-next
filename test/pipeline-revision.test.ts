/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { PIPELINE_REVISION } from '../src/cache/key';
import { sha256Hex } from '../src/cache/sha256';
import { readText } from './support/read-text';

/**
 * A tripwire for PIPELINE_REVISION (src/cache/key.ts).
 *
 * The stored artifact is the pipeline's OUTPUT, and the cache key is derived from the pipeline's
 * INPUTS. So a change to a stage that alters what it writes — a colour rule, a sanitizer list, an
 * id scheme — leaves every key where it was and the previous release's artifacts are served as
 * though this release had made them. The revision in the key is how a release says "my templates
 * differ"; this test is how forgetting to say so fails CI instead of reaching a vault.
 *
 * It fingerprints the source of every stage module. Any edit trips it, comment or not, because a
 * test cannot tell which edits reach the output and a person can. When it fails: if a stored
 * template can now come out differently, bump PIPELINE_REVISION, once per release; then record the
 * new fingerprint below, with the revision it belongs to.
 *
 * Not fingerprinted: freeze.ts, geometry.ts and measure.ts, which run at export and mount time on
 * an artifact already stored, and render-child.ts's `transform`, which assembles the pipeline from
 * outside src/svg/ and changes for reasons that have nothing to do with its output. A change there
 * that alters the template needs the bump without the reminder.
 */
const RECORDED = {
	revision: 2,
	fingerprint: '2f798865c6b1dc83c2c258d57a8386ffafeb2e21d06598a50d325502e6b582b5',
};

/** Read at runtime rather than at build time, so this tracks the files as they are now. */
const STAGE_FILES = Object.keys(import.meta.glob('../src/svg/*.ts'))
	.map((path) => path.slice('../'.length))
	.filter((path) => !['src/svg/freeze.ts', 'src/svg/geometry.ts', 'src/svg/measure.ts'].includes(path))
	.sort();

function fingerprint(): string {
	const parts = STAGE_FILES.map((path) => {
		const text = readText(path);
		return `${path.length}:${path}${text.length}:${text}`;
	});
	return sha256Hex(parts.join(''));
}

describe('PIPELINE_REVISION', () => {
	it('covers the stage modules', () => {
		expect(STAGE_FILES).toEqual(
			expect.arrayContaining([
				'src/svg/colors.ts',
				'src/svg/ids.ts',
				'src/svg/pipeline.ts',
				'src/svg/sanitize.ts',
				'src/svg/serialize.ts',
				'src/svg/stages.ts',
			]),
		);
	});

	it('was bumped for the stage code it was recorded against', () => {
		expect(
			{ revision: PIPELINE_REVISION, fingerprint: fingerprint() },
			'src/svg/ changed since this revision was recorded: bump PIPELINE_REVISION in ' +
				'src/cache/key.ts if a stored template can come out differently, then record the new ' +
				'fingerprint in test/pipeline-revision.test.ts',
		).toEqual(RECORDED);
	});
});
