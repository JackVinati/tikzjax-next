import { describe, expect, it } from 'vitest';
import { explain, type TexFailure } from '../src/engine/hints';
import type { EngineCapabilities, TexErrorKind } from '../src/types';

const caps = (over: Partial<EngineCapabilities> = {}): EngineCapabilities => ({
	expl3: false,
	twoPass: false,
	packages: { pgfplots: '1.16', circuitikz: '1.0' },
	files: new Set(['pgfplots.sty', 'circuitikz.sty', 'tikz.code.tex', 'chemfig.sty']),
	...over,
});

const failure = (over: Partial<TexFailure> & { kind: TexErrorKind }): TexFailure => ({
	message: '',
	...over,
});

describe('missing-file', () => {
	it('says expl3 is available, so the package could be added', () => {
		const d = explain(failure({ kind: 'missing-file', message: 'siunitx.sty' }), caps({ expl3: true }));

		expect(d.kind).toBe('missing-file');
		expect(d.message).toBe('siunitx.sty is not bundled with this TeX engine.');
		expect(d.hint).toMatch(/does provide the expl3 primitives/);
		// The point of the branch: it must NOT repeat the old flat "impossible" verdict.
		expect(d.hint).not.toMatch(/would not make it work|impossibility/i);
	});

	it('says expl3 is missing, so adding the file would not be enough', () => {
		const d = explain(failure({ kind: 'missing-file', message: 'siunitx.sty' }), caps({ expl3: false }));

		expect(d.hint).toMatch(/built on expl3/);
		expect(d.hint).toMatch(/Adding the .sty alone would not make it work/);
		expect(d.hint).toMatch(/\\Omega/);
	});

	it('treats a name that IS bundled as a different problem', () => {
		const d = explain(failure({ kind: 'missing-file', message: 'pgfplots.sty', line: 3 }), caps());

		expect(d.message).toBe('pgfplots.sty is bundled, but TeX could not open it.');
		expect(d.hint).toMatch(/not a missing package/);
		expect(d.hint).not.toMatch(/not bundled with this TeX engine/);
		expect(d.line).toBe(3);
	});

	it('suggests a bundled near-miss for what looks like a typo', () => {
		const d = explain(failure({ kind: 'missing-file', message: 'circuittikz.sty' }), caps());

		expect(d.hint).toMatch(/circuitikz\.sty is — did you mean that\?/);
	});

	it('does not suggest a near-miss across file extensions', () => {
		// `tikz.sty` and `tikz.code.tex` are close as strings and unrelated as files.
		const d = explain(failure({ kind: 'missing-file', message: 'tikz.sty' }), caps());

		expect(d.hint).not.toMatch(/did you mean/);
		expect(d.hint).toMatch(/no network access/);
	});

	it('pulls the file name out of a sentence', () => {
		const d = explain(
			failure({
				kind: 'missing-file',
				message: "I can't find file `mathtools.sty'",
				firstError: "I can't find file `mathtools.sty'.",
			}),
			caps(),
		);

		expect(d.message).toBe('mathtools.sty is not bundled with this TeX engine.');
	});
});

describe('capacity', () => {
	it('names the exceeded pool and its limit', () => {
		const d = explain(
			failure({
				kind: 'capacity',
				message: 'TeX capacity exceeded, sorry [main memory size=5000000]',
				firstError: 'TeX capacity exceeded, sorry [main memory size=5000000]',
				line: 12,
			}),
			caps(),
		);

		expect(d.kind).toBe('capacity');
		expect(d.message).toBe('TeX ran out of main memory size (limit 5000000).');
		expect(d.hint).toMatch(/samples=/);
		expect(d.line).toBe(12);
	});

	it('gives pool-specific advice rather than one generic line', () => {
		const stack = explain(
			failure({ kind: 'capacity', message: 'TeX capacity exceeded, sorry [input stack size=5000]' }),
			caps(),
		);
		const save = explain(
			failure({ kind: 'capacity', message: 'TeX capacity exceeded, sorry [save size=100000]' }),
			caps(),
		);

		expect(stack.hint).toMatch(/expands into itself/);
		expect(save.hint).toMatch(/nested scopes/);
		expect(stack.hint).not.toBe(save.hint);
	});

	it('does not read pool advice off Object.prototype', () => {
		// The pool name is parsed out of a string. A plain object literal answers `constructor` with
		// a function, and the hint would then contain `function Object() { [native code] }`.
		const d = explain(failure({ kind: 'capacity', message: 'TeX capacity exceeded, sorry [constructor=1]' }), caps());

		expect(d.hint).not.toMatch(/native code|function Object/);
		expect(d.hint).toMatch(/Simplify the diagram/);
	});

	it('still says something when TeX gave no bracketed pool', () => {
		const d = explain(failure({ kind: 'capacity', message: 'TeX capacity exceeded, sorry' }), caps());

		expect(d.message).toBe('TeX ran out of memory.');
		expect(d.hint).toMatch(/Simplify the diagram/);
	});
});

describe('tex-error: undefined control sequence', () => {
	it('extracts the control sequence and names the package that provides it', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				firstError: 'Undefined control sequence.',
				message: '! Undefined control sequence.\nl.5 \\draw (0,0) node {\\si\n                          {\\metre}};',
				line: 5,
			}),
			caps({ expl3: true }),
		);

		expect(d.message).toBe('Undefined control sequence \\si');
		expect(d.hint).toMatch(/siunitx/);
		expect(d.hint).toMatch(/expl3/);
		expect(d.line).toBe(5);
	});

	it('reassembles a sequence split across TeX’s 79-column wrap', () => {
		// TeX's max_print_line is a hard wrap, not a line ending, and it lands wherever the 80th
		// character falls — here in the middle of \schemestart.
		const head = 'l.7 \\draw (0,0) node {';
		const tail = '\\schem';
		const first = head + 'a'.repeat(79 - head.length - tail.length) + tail;
		expect(first).toHaveLength(79);

		const d = explain(
			failure({
				kind: 'tex-error',
				firstError: 'Undefined control sequence.',
				message: ['! Undefined control sequence.', first, 'estart}'].join('\n'),
			}),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence \\schemestart');
		expect(d.hint).toMatch(/chemfig/);
	});

	it('prefers a macro it has advice about over the last one echoed', () => {
		// `\metre` is textually last, but `\si` is the token TeX actually choked on.
		const d = explain(
			failure({
				kind: 'tex-error',
				firstError: 'Undefined control sequence.',
				message: 'l.5 \\si{\\metre}',
			}),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence \\si');
	});

	it('tells the user to load a package that IS bundled', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				firstError: 'Undefined control sequence.',
				message: 'l.4 \\schemestart',
			}),
			caps(),
		);

		expect(d.hint).toMatch(/does bundle/);
		expect(d.hint).toMatch(/\\usepackage\{chemfig\}/);
	});

	it('says a package cannot help when it is not bundled and expl3 is irrelevant', () => {
		const d = explain(
			failure({ kind: 'tex-error', firstError: 'Undefined control sequence.', message: 'l.4 \\Forest' }),
			caps(),
		);

		expect(d.hint).toMatch(/forest/);
		expect(d.hint).toMatch(/will not help either/);
	});

	it('falls back to the last macro echoed when none is in the table', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				firstError: 'Undefined control sequence.',
				message: 'l.9 \\draw (0,0) -- \\myTypo',
			}),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence \\myTypo');
		expect(d.hint).toMatch(/Check the spelling/);
	});

	it('does not invent a macro when TeX echoed none', () => {
		// The worker's `message` is the bare `!` line, so this is the common shape.
		const d = explain(
			failure({ kind: 'tex-error', message: 'Undefined control sequence.', firstError: 'Undefined control sequence.' }),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence.');
		expect(d.hint).toMatch(/did not echo the macro/);
	});
});

describe('tex-error: everything else', () => {
	it('keeps TeX’s own wording as the headline', () => {
		const d = explain(
			failure({ kind: 'tex-error', message: 'Missing $ inserted', firstError: 'Missing $ inserted', line: 2 }),
			caps(),
		);

		expect(d.kind).toBe('tex-error');
		expect(d.message).toBe('Missing $ inserted.');
		expect(d.hint).toMatch(/maths-mode/);
	});

	it('offers no hint rather than a wrong one for an unrecognised error', () => {
		const d = explain(
			failure({ kind: 'tex-error', message: 'Paragraph ended before \\pgfutil@next was complete' }),
			caps(),
		);

		expect(d.message).toBe('Paragraph ended before \\pgfutil@next was complete.');
		expect(d.hint).toBeUndefined();
	});
});

describe('overfull boxes never become an error card', () => {
	it('downgrades an Overfull \\hbox that reaches explain() to a warning', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				message: 'Overfull \\hbox (12.4pt too wide) in paragraph at lines 4--4',
				firstError: 'Overfull \\hbox (12.4pt too wide) in paragraph at lines 4--4',
			}),
			caps(),
		);

		expect(d.kind).toBe('warning');
		expect(d.message).toMatch(/overfull box/i);
		expect(d.hint).toMatch(/diagram rendered/);
	});

	it('downgrades Underfull too', () => {
		const d = explain(
			failure({ kind: 'tex-error', firstError: 'Underfull \\vbox (badness 10000) detected at line 9' }),
			caps(),
		);

		expect(d.kind).toBe('warning');
	});

	it('does not downgrade a real error whose log merely mentions one', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				firstError: 'Undefined control sequence.',
				message: 'Overfull \\hbox (3.0pt too wide) in paragraph at lines 2--2\n! Undefined control sequence.\nl.6 \\qw',
			}),
			caps(),
		);

		expect(d.kind).toBe('tex-error');
		expect(d.hint).toMatch(/quantikz/);
	});
});

describe('the remaining kinds', () => {
	it('explains empty output as an empty or commented-out block', () => {
		const d = explain(failure({ kind: 'empty-output', message: 'TeX produced no output.' }), caps());

		expect(d.kind).toBe('empty-output');
		expect(d.hint).toMatch(/commented out/);
	});

	it('says the engine was restarted after a timeout', () => {
		const d = explain(failure({ kind: 'timeout', message: 'Timed out' }), caps());

		expect(d.kind).toBe('timeout');
		expect(d.message).toMatch(/time budget/);
		expect(d.hint).toMatch(/restarted/);
	});

	it('explains a dead engine as affecting the whole page', () => {
		const d = explain(failure({ kind: 'engine-unavailable', message: 'worker failed to boot' }), caps());

		expect(d.kind).toBe('engine-unavailable');
		expect(d.hint).toMatch(/Reload Obsidian/);
	});

	it('returns something useful for a kind it does not know', () => {
		const d = explain(
			failure({ kind: 'dvi-broken' as TexErrorKind, message: '! Something new went wrong.' }),
			caps(),
		);

		expect(d.kind).toBe('dvi-broken');
		expect(d.message).toBe('Something new went wrong.');
		expect(d.hint).toMatch(/full log/);
	});

	it('does not throw on an empty message with no firstError', () => {
		const d = explain(failure({ kind: 'weird' as TexErrorKind, message: '' }), caps());

		expect(d.message).toBe('TeX failed.');
		expect(d.hint).toBeTruthy();
	});
});

describe('purity', () => {
	it('does not mutate the capabilities it is given', () => {
		const c = caps({ expl3: true });
		const before = { files: [...c.files], packages: { ...c.packages }, expl3: c.expl3 };

		explain(failure({ kind: 'missing-file', message: 'siunitx.sty' }), c);
		explain(failure({ kind: 'tex-error', firstError: 'Undefined control sequence.', message: 'l.1 \\ce' }), c);

		expect([...c.files]).toEqual(before.files);
		expect(c.packages).toEqual(before.packages);
		expect(c.expl3).toBe(before.expl3);
	});

	it('is deterministic for the same input', () => {
		const input = failure({ kind: 'capacity', message: 'TeX capacity exceeded, sorry [pool size=100000]' });

		expect(explain(input, caps())).toEqual(explain(input, caps()));
	});
});

describe('wrap reassembly stops at the end of the wrapped line', () => {
	// A wrap chain is `79, 79, …, remainder`. Deciding continuation from the length of the line
	// built so far rather than from the last chunk makes every following line a continuation too,
	// which glues the whole transcript into one string.
	const wrapped = (logical: string): string[] => logical.match(/.{1,79}/g) ?? [logical];

	it('does not glue the lines that follow a wrapped one', () => {
		const overfull = `[]\\OT1/cmr/m/n/10 ${'x'.repeat(67)}`;
		expect(overfull).toHaveLength(85);
		expect(wrapped(overfull)).toHaveLength(2);

		const d = explain(
			failure({
				kind: 'tex-error',
				message: [
					'Overfull \\hbox (12.4pt too wide) detected at line 4',
					...wrapped(overfull),
					'! Undefined control sequence.',
					'l.9 \\qw',
				].join('\n'),
			}),
			caps(),
		);

		// The `!` line is still a headline of its own, so a real error behind a long Overfull
		// report is not silently downgraded to "nothing to fix".
		expect(d.kind).toBe('tex-error');
		expect(d.message).toBe('Undefined control sequence \\qw');
	});

	it('still rejoins a control sequence split by the wrap', () => {
		const head = 'l.7 \\draw (0,0) node {';
		// Enough filler that the 79th column lands inside `\schemestart`, as TeX's wrap does.
		const logical = `${head}${'a'.repeat(79 - head.length - 6)}\\schemestart}`;
		const chunks = wrapped(logical);
		expect(chunks[0]).toHaveLength(79);
		expect(chunks[1]).not.toMatch(/schemestart/); // the name really is split

		const d = explain(
			failure({ kind: 'tex-error', message: ['! Undefined control sequence.', ...chunks].join('\n') }),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence \\schemestart');
	});
});

describe('the transcript the worker actually sends', () => {
	// What main.ts hands `explain` for a tex-error is `TexError.message`, which the worker sets to
	// the bare `!` text. The macro only ever appears in `log`, so a hint that can only read
	// `message` never fires on a real failure — the whole point of the module.
	const undefinedCs = ['This is e-TeX, Version 3.141592653', '(input.tex', '! Undefined control sequence.'];

	it('names the macro and its package from the log', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				message: 'Undefined control sequence.',
				firstError: 'Undefined control sequence.',
				line: 5,
				log: [...undefinedCs, 'l.5 \\draw (0,0) node {\\si', '                          {\\metre}};', '?'],
			}),
			caps({ expl3: true }),
		);

		expect(d.message).toBe('Undefined control sequence \\si');
		expect(d.hint).toMatch(/siunitx/);
		expect(d.line).toBe(5);
	});

	it('reads only the first error’s echo, not the whole transcript', () => {
		// `\OT1` and `\hbox` are control sequences too, and a later `\si` belongs to a different
		// error. Scanning everything would name any of them as the offender.
		const d = explain(
			failure({
				kind: 'tex-error',
				message: 'Undefined control sequence.',
				firstError: 'Undefined control sequence.',
				log: [
					'Overfull \\hbox (12.4pt too wide) in paragraph at lines 2--2',
					'[]\\OT1/cmr/m/n/10 label',
					'! Undefined control sequence.',
					'l.5 \\draw (0,0) -- \\myTypo',
					'! Undefined control sequence.',
					'l.9 \\si{\\metre}',
				],
			}),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence \\myTypo');
	});

	it('falls back to the message when the log carries no error line', () => {
		const d = explain(
			failure({
				kind: 'tex-error',
				message: '! Undefined control sequence.\nl.4 \\schemestart',
				log: ['This is e-TeX, Version 3.141592653', '(input.tex'],
			}),
			caps(),
		);

		expect(d.message).toBe('Undefined control sequence \\schemestart');
	});
});

describe('a headline that still carries TeX’s bang', () => {
	// protocol.ts documents `firstError` as "the first `! ...` line"; the worker happens to strip
	// the bang, a future producer need not. A leading `!` must not defeat every hint we have.
	it('recognises the error anyway', () => {
		const d = explain(
			failure({ kind: 'tex-error', message: '! Missing $ inserted.', firstError: '! Missing $ inserted.' }),
			caps(),
		);

		expect(d.message).toBe('Missing $ inserted.');
		expect(d.hint).toMatch(/maths-mode/);
	});
});
