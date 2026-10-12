/**
 * What to tell the user when TeX wrote a DVI and dvi2html could not draw it.
 *
 * Two different failures share a prefix. dvi2html says "Could not find font metric for 127" when a
 * font it knows lacks one character's metrics, and "Could not find font tcrm1000" when it does not
 * know the font at all. Matched the other way round, the first read as a font named "metric", and a
 * German label showed "The font metric is not supported".
 *
 * The first used to be the dieresis accent, and this said so — but it was the last character of
 * EVERY font that had no metrics, \spadesuit and \backepsilon as much as ä, because dvi2html's TFM
 * reader stopped one short. The build patches that (scripts/dvi2html-patch.mjs). What can still
 * arrive here is a character a font's metrics really do not have, and the message says no more
 * than it knows: dvi2html does not say which font.
 */
export function describeConvertError(error: string): string {
	const glyph = /Could not find font metric for (\d+)/.exec(error)?.[1];
	if (glyph !== undefined)
		return `The SVG converter has no metrics for character ${glyph} of a font this diagram uses.`;

	const font = /Could not find font (\S+)/.exec(error)?.[1];
	if (font !== undefined) return `The font ${font} is not supported by the SVG converter.`;

	return `The diagram compiled but could not be converted: ${error}`;
}
