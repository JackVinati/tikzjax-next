import { describe, expect, it } from 'vitest';
import { TS1_SYMBOLS } from '../engine-src/ts1-shim';
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

	it('leaves native characters and comments byte-for-byte unchanged', () => {
		const source = '% 中文说明\n\\node {café \\% 中文};';
		const result = bridgeUnicode(source);

		expect(result.runs).toEqual(['中文']);
		expect(result.source).toContain('% 中文说明\n');
		expect(result.source).toContain('café');
	});

	it('does no work when every character renders natively', () => {
		const source = '\\node[draw]{Dvořák it’s 2010–2020 café Erdős İstanbul … ﬁ ﬂ};';
		expect(bridgeUnicode(source)).toEqual({ source, preamble: '', runs: [] });
	});

	it('leaves what the engine or the TS1 shim draws, and bridges the rest of Latin-1', () => {
		const result = bridgeUnicode('\\node {Müller 45° äöü × Łódź £5 ¥5 ‰};');
		expect(result.runs).toEqual(['¥', '‰']);
		expect(result.source).toContain('Müller 45° äöü × Łódź £5 ');
		expect(result.source.match(/\\hbox to1em/g)).toHaveLength(2);
	});

	it('never bridges a character the TS1 shim draws', () => {
		for (const { codepoint } of TS1_SYMBOLS) {
			if (codepoint === undefined) continue;
			expect(bridgeUnicode(String.fromCodePoint(codepoint)).runs, codepoint.toString(16)).toEqual([]);
		}
	});

	it('leaves Unicode macro names alone after an odd number of backslashes', () => {
		for (const count of [1, 3]) {
			const source = `\\def${'\\'.repeat(count)}开始{x}`;
			expect(bridgeUnicode(source)).toEqual({ source, preamble: '', runs: [] });
		}
		expect(bridgeUnicode('\\\\开始').runs).toEqual(['开始']);
	});

	it('restores text and keeps the converter geometry and paint', () => {
		const svg =
			'<svg><g data-tikzjax-unicode="0" data-quad="10.0pt">' +
			'<text x="12" y="34" font-family="cmr10" font-size="10" fill="#c00">M</text>' +
			'<text x="22" y="34" font-family="cmr10" font-size="10" fill="#c00">M</text>' +
			'</g></svg>';

		expect(restoreUnicode(svg, ['开始'])).toBe(
			'<svg><text x="22" y="34" font-family="sans-serif" font-size="10" fill="#c00" text-anchor="middle">开始</text></svg>',
		);
	});

	it('restores every occurrence when TeX expands the same text more than once', () => {
		const marker =
			'<g data-tikzjax-unicode="0" data-quad="10pt"><text x="0" font-family="cmr10" font-size="10">M</text></g>';
		expect(restoreUnicode(marker + marker, ['Ω'])).toBe(
			'<text x="5" font-family="sans-serif" font-size="10" text-anchor="middle">Ω</text>'.repeat(2),
		);
	});

	it.each(['Привет', 'Ωμέγα', 'ɪˈpɑ', '😀'])(
		'centres %s using the TeX quad and codepoint count',
		(text) => {
			const svg =
				'<svg><g data-tikzjax-unicode="0" data-quad="12.5pt"><text x="-10" y="20" transform="rotate(30)">M</text></g></svg>';
			const restored = restoreUnicode(svg, [text]);
			expect(restored).toContain(`x="${-10 + ([...text].length * 12.5) / 2}"`);
			expect(restored).toContain('text-anchor="middle"');
			expect(restored).toContain('transform="rotate(30)"');
		},
	);

	it('escapes XML and replaces forbidden scalars without breaking astral characters', () => {
		const svg = '<g data-tikzjax-unicode="0" data-quad="10pt"><text x="0">M</text></g>';
		const restored = restoreUnicode(svg, ['<&>\uFFFE\uFFFF\uD800x\uDC00\u0001😀']);
		expect(restored).toContain('&lt;&amp;&gt;\uFFFD\uFFFD\uFFFDx\uFFFD\uFFFD😀</text>');
	});

	it('fails instead of returning broken group markup or an unrecoverable marker', () => {
		expect(() => restoreUnicode('<svg><g></svg>', ['开始'])).toThrow('unbalanced');
		expect(() => restoreUnicode('<g data-tikzjax-unicode="0" data-quad="10pt"></g>', ['开始'])).toThrow(
			'position',
		);
		expect(restoreUnicode('<svg><g></svg>', [])).toBe('<svg><g></svg>');
	});
});
