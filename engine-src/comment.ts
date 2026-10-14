/**
 * Where TeX's comment starts on a line of input, as its default catcodes read it: at the first `%`
 * that is not escaped, a `%` with an even run of backslashes before it, none included (`\\%` is the
 * control symbol `\\` and then a comment, `\%` a percent sign). -1 when the line has none.
 *
 * Read off the text, so it cannot see a catcode a preamble changed or a `%` inside `\verb`. It is
 * used where that costs nothing worse than today: by the host, to end a preamble whose last line is a
 * comment with a newline (src/preamble/resolve.ts), and to name the run a diagram would resume from
 * (./document predictedPoint).
 *
 * A module of its own, imported by the worker and the host alike, with nothing in it of either.
 */
export function commentStart(line: string): number {
	for (let at = line.indexOf('%'); at >= 0; at = line.indexOf('%', at + 1)) {
		let slashes = 0;
		for (let i = at - 1; i >= 0 && line.charCodeAt(i) === 92; i--) slashes++;
		if (slashes % 2 === 0) return at;
	}
	return -1;
}
