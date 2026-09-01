import { describe, expect, it } from 'vitest';
import { parseDirectives } from '../src/source/directives';
import type { BlockOptions } from '../src/types';

/** A believable global default: a couple of things already set, so "keeps the default" is a real
 *  assertion rather than "stays undefined". */
function defaults(): BlockOptions {
	return {
		baked: {
			border: null,
			packages: { pgfplots: '' },
			libraries: 'arrows',
			preamble: '\\def\\R{\\mathbb{R}}',
			depHashes: ['macros.tex:abc'],
			wrap: 'auto',
			twoPass: false,
		},
		presentation: { scale: 1, colors: 'adapt' },
		raw: false,
		nocache: false,
		fast: false,
		warnings: [],
	};
}

describe('parseDirectives: sources with no directives', () => {
	it('returns the source byte-for-byte and the defaults unchanged', () => {
		const source = [
			'\\begin{document}',
			'\t\\begin{tikzpicture}',
			'\t\t% a plain comment',
			'\t\\end{tikzpicture}',
			'\\end{document}',
			'',
		].join('\n');
		const result = parseDirectives(source, defaults());

		expect(result.body).toBe(source);
		expect(result.options).toEqual(defaults());
		expect(result.inputs).toEqual([]);
		expect(result.preamblePath).toBeNull();
		expect(result.svgo).toBeNull();
	});

	it('leaves a comment that merely starts with the prefix alone', () => {
		// `%!tikzfoo` is a TeX comment, not a misspelled directive: without the boundary check the
		// parser would strip it from the body and warn about an option nobody wrote.
		const source = '%!tikzfoo width=10\n\\draw (0,0);';
		const result = parseDirectives(source, defaults());

		expect(result.body).toBe(source);
		expect(result.options.warnings).toEqual([]);
	});

	it('reads the prefix case-insensitively, like every key and value', () => {
		// Keys and values are already case-folded because "a user should not have to remember which
		// spelling this parser prefers". The prefix has a worse failure mode than a key does: a
		// `%!TikZ` line is not a warning, it is a comment — the option is silently not applied and
		// nothing anywhere says so.
		const result = parseDirectives('%!TikZ width=420\n%:INPUT macros.tex\n\\draw (0,0);', defaults());

		expect(result.options.presentation.width).toBe('420px');
		expect(result.inputs).toEqual(['macros.tex']);
		expect(result.body).toBe('\\draw (0,0);');
	});

	it('does not mutate the defaults object it was handed', () => {
		const shared = defaults();
		const result = parseDirectives('%!tikz packages=circuitikz libraries=calc scale=2', shared);

		expect(shared).toEqual(defaults());
		expect(result.options.baked.packages).not.toBe(shared.baked.packages);
		expect(result.options.baked.packages).toEqual({ pgfplots: '', circuitikz: '' });
	});
});

describe('parseDirectives: grammar', () => {
	it('accepts bare, double-quoted and single-quoted values', () => {
		const result = parseDirectives(
			`%!tikz width=420 alt="RC low-pass" preamble='my notes/macros.tex'`,
			defaults(),
		);

		expect(result.options.presentation.width).toBe('420px');
		expect(result.options.presentation.alt).toBe('RC low-pass');
		expect(result.preamblePath).toBe('my notes/macros.tex');
		expect(result.options.warnings).toEqual([]);
	});

	it('keeps `=` and spaces inside a quoted value', () => {
		const result = parseDirectives('%!tikz alt="y = f(x), for x > 0" align=right', defaults());

		expect(result.options.presentation.alt).toBe('y = f(x), for x > 0');
		expect(result.options.presentation.align).toBe('right');
	});

	it('does not treat a backslash as an escape', () => {
		// Directive values are TeX and vault paths; both are full of backslashes, so an escape
		// character would mangle far more values than it would rescue.
		const result = parseDirectives(`%!tikz alt="the set \\(A\\)"`, defaults());
		expect(result.options.presentation.alt).toBe('the set \\(A\\)');
	});

	it('warns on an unterminated quote and takes the rest of the line', () => {
		const result = parseDirectives('%!tikz alt="never closed', defaults());

		expect(result.options.presentation.alt).toBe('never closed');
		expect(result.options.warnings).toEqual(["line 1: unterminated quote in 'alt='"]);
	});

	it('is indifferent to leading indentation, key case and separator width', () => {
		const result = parseDirectives('\t   %!tikz   WIDTH=50%\t\tMaxWidth=10em', defaults());

		expect(result.options.presentation.width).toBe('50%');
		expect(result.options.presentation.maxWidth).toBe('10em');
	});

	it('tolerates a trailing carriage return', () => {
		// normalize.ts runs first, but a directive parser that mangles its last option on a stray
		// CR would fail in exactly the notes nobody thinks to test.
		const result = parseDirectives('%!tikz align=center\r\n\\draw (0,0);', defaults());

		expect(result.options.presentation.align).toBe('center');
		expect(result.options.warnings).toEqual([]);
	});

	it('accepts an empty alt as a real value, not a missing one', () => {
		const result = parseDirectives('%!tikz alt=""', defaults());

		expect(result.options.presentation.alt).toBe('');
		expect(result.options.warnings).toEqual([]);
	});

	it('warns when a key that needs a value has none', () => {
		const result = parseDirectives('%!tikz width scale=', defaults());

		expect(result.options.presentation.width).toBeUndefined();
		expect(result.options.presentation.scale).toBe(1);
		expect(result.options.warnings).toEqual([
			"line 1: 'width' needs a value; keeping the default",
			"line 1: 'scale' needs a value; keeping the default",
		]);
	});
});

describe('parseDirectives: accumulation and stripping', () => {
	it('accumulates across lines, with the last write winning for a scalar', () => {
		const source = [
			'%!tikz width=420 align=left',
			'%!tikz align=center colors=paper',
			'%!tikz packages=circuitikz libraries=arrows.meta',
			'\\draw (0,0);',
		].join('\n');
		const result = parseDirectives(source, defaults());

		expect(result.options.presentation).toEqual({
			width: '420px',
			align: 'center',
			colors: 'paper',
			scale: 1,
		});
		expect(result.options.baked.packages).toEqual({ pgfplots: '', circuitikz: '' });
		expect(result.options.baked.libraries).toBe('arrows,arrows.meta');
	});

	it('strips every directive line and preserves the rest exactly', () => {
		const source = [
			'%!tikz width=420',
			'%:input latex/macros.tex',
			'\\begin{document}',
			'  \\begin{tikzpicture}',
			'    \\draw (0,0) -- (1,1);',
			'  \\end{tikzpicture}',
			'\\end{document}',
		].join('\n');
		const result = parseDirectives(source, defaults());

		expect(result.body).toBe(
			[
				'\\begin{document}',
				'  \\begin{tikzpicture}',
				'    \\draw (0,0) -- (1,1);',
				'  \\end{tikzpicture}',
				'\\end{document}',
			].join('\n'),
		);
		// Removed entirely rather than blanked: a leftover empty line would still be hashed, which
		// is the whole reason the directives are stripped before the key is derived.
		expect(result.body).not.toContain('\n\n');
	});

	it('parses a directive written anywhere in the block, verbatim-looking context included', () => {
		// Documented acceptance: we do not model TeX's verbatim. `\verb` cannot span a newline and
		// a verbatim environment inside a tikzpicture is not worth the class of "my directive did
		// nothing and I cannot see why" bug that special-casing it would create.
		const source = [
			'\\begin{document}',
			'\\begin{verbatim}',
			'%!tikz scale=3',
			'\\end{verbatim}',
			'\\end{document}',
		].join('\n');
		const result = parseDirectives(source, defaults());

		expect(result.options.presentation.scale).toBe(3);
		expect(result.body).not.toContain('%!tikz');
	});
});

describe('parseDirectives: presentation values', () => {
	it('reads CSS lengths, treating a bare number as px', () => {
		const result = parseDirectives('%!tikz width=100 max-width=80% scale=1.5 timeout=15', defaults());

		expect(result.options.presentation.width).toBe('100px');
		expect(result.options.presentation.maxWidth).toBe('80%');
		expect(result.options.presentation.scale).toBe(1.5);
		expect(result.options.presentation.timeoutMs).toBe(15_000);
	});

	it('reads a timeout in explicit units', () => {
		const result = parseDirectives('%!tikz timeout=500ms', defaults());
		expect(result.options.presentation.timeoutMs).toBe(500);
		// Same numeric shape as every other value, leading dot included.
		expect(parseDirectives('%!tikz timeout=.5', defaults()).options.presentation.timeoutMs).toBe(500);
	});

	it('rejects a duration that rounds down to no timeout at all', () => {
		// `timeout=0` is refused as "not a positive duration", and 0.0001 s has to be refused for
		// the same reason: it rounds to 0 ms, and a 0 ms budget reaches queue.ts as a timer that
		// fires before the job starts — the block fails instantly AND its key is poisoned for the
		// rest of the session, which is the one outcome worse than a slow render.
		const result = parseDirectives('%!tikz timeout=0.0001', defaults());

		expect(result.options.presentation.timeoutMs).toBeUndefined();
		expect(result.options.warnings).toEqual([
			"line 1: 'timeout=0.0001' is not a positive duration; keeping the default",
		]);
	});

	it('reads a number the way every other value is read, not the way `Number()` does', () => {
		// `Number('0x10')` is 16. Every other value in this module goes through a whitelist regex;
		// scale went through `Number`, so a typo silently became a 16x diagram.
		const hex = parseDirectives('%!tikz scale=0x10', defaults());
		expect(hex.options.presentation.scale).toBe(1);
		expect(hex.options.warnings).toEqual([
			"line 1: 'scale=0x10' is not a positive number; keeping the default",
		]);

		expect(parseDirectives('%!tikz scale=1e3', defaults()).options.presentation.scale).toBe(1);
		// A leading dot is how people write a half, and it is valid CSS too.
		expect(parseDirectives('%!tikz scale=.5', defaults()).options.presentation.scale).toBe(0.5);
		expect(parseDirectives('%!tikz width=.5em', defaults()).options.presentation.width).toBe('.5em');
	});

	it('only accepts the keyword each property actually has', () => {
		// `width: none` and `max-width: auto` are not CSS; the browser drops the whole declaration,
		// so accepting them meant the directive silently did nothing.
		expect(parseDirectives('%!tikz width=auto', defaults()).options.presentation.width).toBe('auto');
		expect(parseDirectives('%!tikz max-width=none', defaults()).options.presentation.maxWidth).toBe(
			'none',
		);

		const bad = parseDirectives('%!tikz width=none max-width=auto', defaults());
		expect(bad.options.presentation.width).toBeUndefined();
		expect(bad.options.presentation.maxWidth).toBeUndefined();
		expect(bad.options.warnings).toEqual([
			"line 1: 'width=none' is not a CSS length; keeping the default",
			"line 1: 'max-width=auto' is not a CSS length; keeping the default",
		]);
	});

	it('rejects a length that smuggles more CSS after it', () => {
		// The value lands in an inline style attribute, so a permissive parse here is a per-note
		// style injection, not just a cosmetic bug.
		const result = parseDirectives(`%!tikz width="100px;background:url(evil)"`, defaults());

		expect(result.options.presentation.width).toBeUndefined();
		expect(result.options.warnings).toEqual([
			"line 1: 'width=100px;background:url(evil)' is not a CSS length; keeping the default",
		]);
	});

	it('warns and keeps the default for every invalid presentation value', () => {
		const source = [
			'%!tikz scale=abc',
			'%!tikz align=sideways',
			'%!tikz colors=blue',
			'%!tikz lazy=sometimes',
			'%!tikz timeout=0',
		].join('\n');
		const result = parseDirectives(source, defaults());

		expect(result.options.presentation).toEqual({ scale: 1, colors: 'adapt' });
		expect(result.options.warnings).toEqual([
			"line 1: 'scale=abc' is not a positive number; keeping the default",
			"line 2: 'align=sideways' is not left, center or right; keeping the default",
			"line 3: 'colors=blue' is not adapt, preserve, paper or invert; keeping the default",
			"line 4: 'lazy=sometimes' is not on, off or manual; keeping the default",
			"line 5: 'timeout=0' is not a positive duration; keeping the default",
		]);
	});
});

describe('parseDirectives: baked values', () => {
	it('parses package options, including commas inside the bracket', () => {
		const result = parseDirectives('%!tikz packages=circuitikz[siunitx,european],chemfig', defaults());

		expect(result.options.baked.packages).toEqual({
			pgfplots: '',
			circuitikz: 'siunitx,european',
			chemfig: '',
		});
	});

	it('skips a package name that would break out of the \\usepackage argument', () => {
		const result = parseDirectives('%!tikz packages="ok,bad}\\\\input{/etc/passwd"', defaults());

		expect(result.options.baked.packages).toEqual({ pgfplots: '', ok: '' });
		expect(result.options.warnings).toEqual([
			"line 1: 'bad}\\\\input{/etc/passwd' is not a package name; skipped",
		]);
	});

	it('skips package OPTIONS that would break out of the \\usepackage argument', () => {
		// The name is only half of what gets spliced: worker.ts writes
		// `\usepackage[${opts}]{${name}}`, so an unchecked payload closes the option list with `]`
		// and then runs arbitrary TeX. Whitelisting the name and not the options guards nothing.
		const result = parseDirectives(String.raw`%!tikz packages=foo[a]}\input{secret}]`, defaults());

		expect(result.options.baked.packages).toEqual({ pgfplots: '' });
		expect(result.options.warnings).toEqual([
			String.raw`line 1: 'foo[a]}\input{secret}]' has package options that are not a key=value list; skipped`,
		]);
	});

	it('keeps a real option list, spaces and all', () => {
		const result = parseDirectives(
			'%!tikz packages="circuitikz[siunitx, european],pgfplots[compat=1.16]"',
			defaults(),
		);

		expect(result.options.baked.packages).toEqual({
			pgfplots: 'compat=1.16',
			circuitikz: 'siunitx, european',
		});
		expect(result.options.warnings).toEqual([]);
	});

	it('merges libraries onto the defaults without duplicating', () => {
		const result = parseDirectives('%!tikz libraries=calc,arrows,positioning', defaults());
		expect(result.options.baked.libraries).toBe('arrows,calc,positioning');
	});

	it('reads a border as a TeX dimension, defaulting a bare number to pt', () => {
		expect(parseDirectives('%!tikz border=2pt', defaults()).options.baked.border).toBe('2pt');
		expect(parseDirectives('%!tikz border=5', defaults()).options.baked.border).toBe('5pt');
		expect(parseDirectives('%!tikz border="2pt 3mm"', defaults()).options.baked.border).toBe('2pt 3mm');
	});

	it('lets a block turn the border back off', () => {
		// `null` is not just the default; it is what keeps the legacy-cache import window open, so
		// undoing a global border has to be expressible per block.
		const withBorder = { ...defaults(), baked: { ...defaults().baked, border: '3pt' } };
		expect(parseDirectives('%!tikz border=none', withBorder).options.baked.border).toBeNull();
	});

	it('warns on a border that is not a length', () => {
		const withBorder = { ...defaults(), baked: { ...defaults().baked, border: '3pt' } };
		const result = parseDirectives('%!tikz border=thick', withBorder);

		expect(result.options.baked.border).toBe('3pt');
		expect(result.options.warnings).toEqual([
			"line 1: 'border=thick' is not a TeX length; keeping the default",
		]);
	});

	it('accepts both spellings of wrap', () => {
		expect(parseDirectives('%!tikz wrap=off', defaults()).options.baked.wrap).toBe('never');
		expect(parseDirectives('%!tikz wrap=never', defaults()).options.baked.wrap).toBe('never');
		expect(parseDirectives('%!tikz wrap=on', defaults()).options.baked.wrap).toBe('always');
		expect(parseDirectives('%!tikz wrap=auto', defaults()).options.baked.wrap).toBe('auto');
		expect(parseDirectives('%!tikz wrap=sometimes', defaults()).options.baked.wrap).toBe('auto');
	});

	it('leaves the expanded preamble text alone and only reports the path', () => {
		const result = parseDirectives('%!tikz preamble=latex/preamble.tex', defaults());

		expect(result.preamblePath).toBe('latex/preamble.tex');
		expect(result.options.baked.preamble).toBe('\\def\\R{\\mathbb{R}}');
		expect(result.options.baked.depHashes).toEqual(['macros.tex:abc']);
	});
});

describe('parseDirectives: flags', () => {
	it('reads a bare flag as true and an explicit boolean either way', () => {
		const result = parseDirectives('%!tikz fast raw=true nocache=1', defaults());

		expect(result.options.fast).toBe(true);
		expect(result.options.raw).toBe(true);
		expect(result.options.nocache).toBe(true);
	});

	it('lets a block turn a globally enabled flag off', () => {
		const allOn = { ...defaults(), fast: true, raw: true, nocache: true };
		const result = parseDirectives('%!tikz fast=off raw=false nocache=no', allOn);

		expect(result.options.fast).toBe(false);
		expect(result.options.raw).toBe(false);
		expect(result.options.nocache).toBe(false);
	});

	it('warns on a non-boolean flag value rather than silently enabling it', () => {
		const result = parseDirectives('%!tikz fast=maybe', defaults());

		expect(result.options.fast).toBe(false);
		expect(result.options.warnings).toEqual([
			"line 1: 'fast=maybe' is not a boolean; keeping the default",
		]);
	});

	it('returns svgo beside the options, since BlockOptions has no slot for it', () => {
		expect(parseDirectives('%!tikz svgo=off', defaults()).svgo).toBe('off');
		expect(parseDirectives('%!tikz svgo=targeted', defaults()).svgo).toBe('targeted');

		const bad = parseDirectives('%!tikz svgo=fast', defaults());
		expect(bad.svgo).toBeNull();
		expect(bad.options.warnings).toEqual([
			"line 1: 'svgo=fast' is not preset, targeted or off; keeping the default",
		]);
	});
});

describe('parseDirectives: unknown keys', () => {
	it('warns, never throws, and never silently drops', () => {
		const result = parseDirectives('%!tikz frobnicate=7 width=200', defaults());

		expect(result.options.presentation.width).toBe('200px');
		expect(result.options.warnings).toEqual(["line 1: unknown option 'frobnicate'"]);
	});

	it('suggests the intended key for a near miss', () => {
		const result = parseDirectives('%!tikz wdith=200\n%!tikz ALGIN=left', defaults());

		expect(result.options.warnings).toEqual([
			"line 1: unknown option 'wdith'; did you mean 'width'?",
			"line 2: unknown option 'ALGIN'; did you mean 'align'?",
		]);
	});

	it('does not hint at a key that shares nothing but a letter', () => {
		// Two edits is most of a three-letter key. `w=1` is plainly a stab at `width`, and pointing
		// the user at `raw` — a flag that changes what the pipeline does — is worse than silence.
		const result = parseDirectives('%!tikz w=1\n%!tikz alto=x', defaults());

		expect(result.options.warnings).toEqual([
			"line 1: unknown option 'w'",
			"line 2: unknown option 'alto'; did you mean 'alt'?",
		]);
	});

	it('says specifically that a designed-then-dropped key is gone', () => {
		const result = parseDirectives('%!tikz options=thick engine=extended', defaults());

		expect(result.options.warnings).toEqual([
			"line 1: 'options' is not supported; put TikZ options on the picture itself",
			"line 1: 'engine' is a global setting, not a per-block option",
		]);
	});

	it('reports a value with no key at all', () => {
		const result = parseDirectives('%!tikz =3', defaults());
		expect(result.options.warnings).toEqual(['line 1: option with no name; ignored']);
	});

	it('appends to warnings the defaults already carried', () => {
		const seeded = { ...defaults(), warnings: ['from the global settings'] };
		const result = parseDirectives('%!tikz nope=1', seeded);

		expect(result.options.warnings).toEqual([
			'from the global settings',
			"line 1: unknown option 'nope'",
		]);
		expect(seeded.warnings).toEqual(['from the global settings']);
	});
});

describe('parseDirectives: %:input', () => {
	it('collects paths in source order, unresolved', () => {
		const source = [
			'%:input latex/macros.tex',
			'\\draw (0,0);',
			'%:input  ../shared/colors.tex ',
			`%:input "my notes/spaced path.tex"`,
		].join('\n');
		const result = parseDirectives(source, defaults());

		expect(result.inputs).toEqual([
			'latex/macros.tex',
			'../shared/colors.tex',
			'my notes/spaced path.tex',
		]);
		expect(result.body).toBe('\\draw (0,0);');
	});

	it('keeps a repeated include rather than deduping it', () => {
		// Cycle and duplicate handling belongs to the resolver: it is the stage that can see the
		// whole include graph, and it is where the visible error for a missing file lives.
		const result = parseDirectives('%:input a.tex\n%:input a.tex', defaults());
		expect(result.inputs).toEqual(['a.tex', 'a.tex']);
	});

	it('warns on an empty path and leaves nothing behind in the body', () => {
		const result = parseDirectives('%:input\n\\draw (0,0);', defaults());

		expect(result.inputs).toEqual([]);
		expect(result.body).toBe('\\draw (0,0);');
		expect(result.options.warnings).toEqual(['line 1: %:input needs a path']);
	});

	it('ignores a comment that only looks like the prefix', () => {
		const source = '%:inputs a.tex';
		expect(parseDirectives(source, defaults()).body).toBe(source);
	});
});
