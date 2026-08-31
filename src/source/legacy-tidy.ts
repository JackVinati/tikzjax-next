/**
 * FROZEN. A byte-for-byte reimplementation of main.ts:117-134 (`TikzPlugin.tidyTikzSource`).
 *
 * This is not a utility and it is NOT to be "improved" — every defect below is load-bearing:
 *
 *   - it deletes the six-character HTML entity `&nbsp;` rather than the real U+00A0 a paste
 *     actually contains (docs/DESIGN.md §2.2 #14),
 *   - `line.trim()` destroys leading whitespace, and
 *   - `filter(line => line)` deletes every blank line, i.e. every `\par`.
 *
 * It has to stay because the legacy localForage cache is keyed on the md5 of *this* output
 * (docs/DESIGN.md §8.3, L3 read-through). Changing a single byte here does not "fix" old notes,
 * it makes every legacy cache record unreachable and forces a full recompile of every vault —
 * the exact incident L3 exists to prevent. It is also what the `Source handling: legacy` setting
 * selects for users who want their pre-0.6 rendering back unchanged (§8.2).
 *
 * New code wants `normalizeSource` from ./normalize.
 */

export function legacyTidyTikzSource(input: string): string {
	// Remove non-breaking space characters, otherwise we get errors
	const remove = '&nbsp;';
	const tikzSource = input.replaceAll(remove, '');

	let lines = tikzSource.split('\n');

	// Trim whitespace that is inserted when pasting in code, otherwise TikZJax complains
	lines = lines.map((line) => line.trim());

	// Remove empty lines
	lines = lines.filter((line) => line);

	return lines.join('\n');
}
