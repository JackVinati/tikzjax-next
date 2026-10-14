/**
 * Cache key derivation (internal/DESIGN.md §6.1).
 *
 * The key is a pure function of everything that changes the STORED BYTES and of nothing else.
 * `Presentation` — theme, colour mode, scale, width, alignment, alt text, lazy mode, timeout — is
 * deliberately absent, which is the whole point: switching theme or resizing a diagram costs zero
 * recompiles and zero re-post-processing. `KeyInputs` in src/types.ts is the enumeration, and
 * test/key.test.ts asserts both halves of the property (sensitive to every input; blind to
 * presentation) so it stays a fact rather than an intention.
 */

import type { KeyInputs } from '../types';
import { sha256Hex } from './sha256';

/**
 * Bumped ONLY when the shape of a stored `Artifact` changes — not when a pipeline stage changes
 * what goes into `template`, which is PIPELINE_REVISION below, and not when a setting does, which
 * is `artifactRevision` in the settings module. Mixing them would make every settings tweak or
 * stage fix look like a format migration.
 */
export const SCHEMA_VERSION = 1;

/**
 * Bumped when the SVG pipeline (src/svg/) can write a different template for the same inputs.
 *
 * The key is a function of the pipeline's inputs, and the artifact is its output, so a stage that
 * changes what it writes moves no key: without this, the next release would serve every artifact
 * the previous one stored, built by the code it just fixed. test/pipeline-revision.test.ts
 * fingerprints the stage modules and fails until the revision is reconsidered.
 *
 * Once per release is enough — what matters is that no two RELEASED pipelines share a number.
 *
 *   1  everything up to 0.1.4, which had no revision in the key at all.
 *   2  the colour pass runs for every colour mode (it used to bake preserve and invert in), and
 *      the sanitizer became an allowlist.
 */
export const PIPELINE_REVISION = 2;

/**
 * Moved when what the engine draws can change: the DVI TeX writes, the transcript the plugin reads
 * its errors from, or the SVG the converter makes of the DVI. See internal/DECISIONS.md D20.
 *
 * The key used to hold ENGINE_ID, the hash of the worker itself, so every change to the worker
 * recompiled every cached diagram once, also one that made TeX faster and drew every diagram the
 * same to the byte. This holds the engine's OUTPUT instead. Its first value is the ENGINE_ID 0.2.0
 * shipped with, so the keys 0.2.0 stored under are the keys derived now, and updating to a release
 * that changes only speed recompiles nothing.
 *
 * test/output-revision.test.ts holds it to the golden corpus: a fixture whose recorded output
 * changes fails it until this moves and test/fixtures/golden/REVISION.json is recorded again. The
 * corpus is 37 diagrams, so a change the CHANGELOG announces as changing what diagrams draw moves
 * it too, by hand, whether or not a fixture shows it — a newly bundled package, say, changes every
 * diagram that was drawn without it. Any new string will do; the sha256 of the worker that first
 * draws the new way is the convention.
 */
export const OUTPUT_REVISION = '5e861510239768c57ca2965eb2329bd2bafc1370df4821cd8d3b7088ce60efde';

/**
 * Fields are length-prefixed rather than joined with a separator.
 *
 * A separator has to be a byte no input can contain, and no such byte exists here: `baked.preamble`
 * is arbitrary TeX and `normalizedSource` is arbitrary user text. With `a|b` there is always some
 * other pair of fields that concatenates to the same string, so a change could move a character
 * across a field boundary and land on the same key. Length prefixes make the encoding injective in
 * the fields for free.
 */
function field(s: string): string {
	return `${s.length}:${s}`;
}

export function deriveKey(i: KeyInputs): string {
	const payload =
		field(`s${SCHEMA_VERSION}`) +
		field(`p${PIPELINE_REVISION}`) +
		field(i.outputRevision) +
		field(i.normalizedSource) +
		field(stableStringify(i.baked)) +
		field(i.artifactRevision) +
		field(stableStringify(i.pipeline));

	// 128 bits. Birthday collision at ~2^64 distinct diagrams; a vault holds ~10^4.
	return sha256Hex(payload).slice(0, 32);
}

/**
 * `JSON.stringify` with object keys sorted, recursively.
 *
 * `BakedOptions.packages` is a `Record` built by parsing `%!tikz packages=` directives, so its
 * insertion order follows the order the user wrote them; plain `JSON.stringify` would then give
 * `packages=pgfplots,circuitikz` and `packages=circuitikz,pgfplots` different keys for identical
 * TeX. Arrays keep their order — `depHashes` is documented as sorted by its producer, and array
 * order is meaningful in general.
 */
function stableStringify(value: unknown): string {
	if (value === undefined) return 'null';
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

	const obj = value as Record<string, unknown>;
	const parts = Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
	return `{${parts.join(',')}}`;
}
