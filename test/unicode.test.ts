import { describe, expect, it } from 'vitest';
import { bridgeUnicode, restoreUnicode } from '../engine-src/unicode';

describe('8-bit TeX Unicode bridge', () => {
	it('replaces literal Unicode runs with one-em proxy boxes', () => {
		const result = bridgeUnicode('\\node {开始 and Ω};');

		expect(result.runs).toEqual(['开始', 'Ω']);
		expect(result.preamble).toContain('data-tikzjax-unicode');
		expect(result.source).toContain('tikzjaxUnicodeBridge\\endcsname{0}');
		expect(result.source.match(/\\hbox to1em/g)).toHaveLength(3);
		expect(result.source).not.toContain('开始');
	});

	it('counts an astral codepoint as one layout box', () => {
		const result = bridgeUnicode('\\node {😀};');
		expect(result.runs).toEqual(['😀']);
		expect(result.source.match(/\\hbox to1em/g)).toHaveLength(1);
	});

	it('leaves Latin-1 and comments byte-for-byte unchanged', () => {
		const source = '% 中文说明\n\\node {café \\% 中文};';
		const result = bridgeUnicode(source);

		expect(result.runs).toEqual(['中文']);
		expect(result.source).toContain('% 中文说明\n');
		expect(result.source).toContain('café');
	});

	it('does no work when a source is already 8-bit-safe', () => {
		const source = '\\node {café};';
		expect(bridgeUnicode(source)).toEqual({ source, preamble: '', runs: [] });
	});

	it('restores text and keeps the converter geometry and paint', () => {
		const svg =
			'<svg><g data-tikzjax-unicode="0">' +
			'<text x="12" y="34" font-family="cmr10" font-size="10" fill="#c00">M</text>' +
			'<text x="22" y="34" font-family="cmr10" font-size="10" fill="#c00">M</text>' +
			'</g></svg>';

		expect(restoreUnicode(svg, ['开始'])).toBe(
			'<svg><g data-tikzjax-unicode="0"><text x="12" y="34" font-family="sans-serif" font-size="10" fill="#c00">开始</text></g></svg>',
		);
	});

	it('restores every occurrence when TeX expands the same text more than once', () => {
		const marker = '<g data-tikzjax-unicode="0"><text font-family="cmr10" font-size="10">M</text></g>';
		expect(restoreUnicode(marker + marker, ['Ω'])).toBe(
			'<g data-tikzjax-unicode="0"><text font-family="sans-serif" font-size="10">Ω</text></g>'.repeat(
				2,
			),
		);
	});
});
