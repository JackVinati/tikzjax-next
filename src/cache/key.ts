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
		field(i.engineId) +
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
