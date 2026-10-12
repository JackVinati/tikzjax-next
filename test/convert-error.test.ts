import { describe, expect, it } from 'vitest';
import { describeConvertError } from '../engine-src/convert-error';

/*
 * What the worker says when TeX wrote a DVI and dvi2html could not draw it. The two dvi2html
 * failures share a prefix, and matching them in the wrong order once told a German label that
 * "The font metric is not supported". The message for character 127 then blamed the dieresis
 * accent — wrongly for \spadesuit and \backepsilon, which failed the same way, and wrongly for
 * every one of them once the build fixed the converter (scripts/dvi2html-patch.mjs).
 */
describe('describeConvertError', () => {
	it('names the character, and does not guess which letter it was', () => {
		const message = describeConvertError('Could not find font metric for 127');
		expect(message).toBe(
			'The SVG converter has no metrics for character 127 of a font this diagram uses.',
		);
		expect(message).not.toContain('dieresis');
		expect(message).not.toContain('ä');
	});

	it('names a font the converter does not know, and never a font called "metric"', () => {
		expect(describeConvertError('Could not find font tcrm1000')).toBe(
			'The font tcrm1000 is not supported by the SVG converter.',
		);
		expect(describeConvertError('Could not find font metric for 3')).not.toContain('font metric is');
	});

	it('passes anything else through, rather than dressing it up', () => {
		expect(describeConvertError('Unexpected opcode 250')).toBe(
			'The diagram compiled but could not be converted: Unexpected opcode 250',
		);
	});
});
