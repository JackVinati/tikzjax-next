import { describe, expect, it } from 'vitest';
import { preflight } from '../src/source/preflight';
import type { BakedOptions, EngineCapabilities } from '../src/types';

/**
 * The fixture models the engine we actually ship against, because the value of every rule here is
 * that it is true of a real bundle: pgfplots 1.16 (internal/DECISIONS.md D7), `arrows` present but
 * `arrows.meta` absent, `patterns` in the pgf flavour only, `siunitx` absent, expl3 available.
 * A caps object made of round numbers would let a rule pass while being wrong about the bundle.
 */
function caps(over: Partial<EngineCapabilities> = {}): EngineCapabilities {
	const base: EngineCapabilities = {
		expl3: true,
		twoPass: false,
		packages: { pgfplots: '1.16', pgf: '3.1.5', circuitikz: '1.0', standalone: '1.3' },
		files: new Set([
			'tikz.sty',
			'pgf.sty',
			'pgfplots.sty',
			'circuitikz.sty',
			'standalone.cls',
			// Both flavours.
			'tikzlibraryarrows.code.tex',
			'pgflibraryarrows.code.tex',
			// pgf flavour only — the common case, and the one the fallback exists for.
			'pgflibraryplothandlers.code.tex',
			'pgflibrarypatterns.code.tex',
			// tikz flavour only.
			'tikzlibrarycalc.code.tex',
			'tikzlibrarypositioning.code.tex',
		]),
	};
	return { ...base, ...over };
}

function baked(over: Partial<BakedOptions> = {}): BakedOptions {
	const base: BakedOptions = {
		border: null,
		packages: {},
		libraries: '',
		preamble: '',
		depHashes: [],
		wrap: 'auto',
		twoPass: false,
	};
	return { ...base, ...over };
}

const CLEAN = `\\usepackage{tikz}
\\usetikzlibrary{arrows,calc,patterns}
\\begin{document}
\\begin{tikzpicture}
  \\foreach \\x in {1,...,4} {
    % a comment mentioning \\documentclass and \\usepackage{siunitx}
    \\draw[->] (\\x,0) -- (\\x,1) node[above] {$x_\\x$};
  }
\\end{tikzpicture}
\\end{document}`;

describe('preflight', () => {
	it('says nothing about a clean source', () => {
		expect(preflight(CLEAN, baked(), caps())).toEqual([]);
	});

	it('never blocks: every diagnostic is a warning and every one is actionable', () => {
		const source = `\\documentclass{standalone}
\\usepackage{siunitx}
\\usetikzlibrary{arrows.meta}
\\pgfplotsset{compat=1.18}
\\pgfmathsetmacro{\\epsilon}{0.2}
\\node {ζ};`;
		const found = preflight(source, baked(), caps());

		expect(found.length).toBe(6);
		for (const d of found) {
			expect(d.kind).toBe('warning');
			expect(d.hint).toBeTruthy();
		}
		// Sorted by position, so the strip reads in source order rather than rule order.
		expect(found.map((d) => d.line)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('counts lines the same way in a CRLF vault, where a comment ends at the \\r', () => {
		const source = '\\usepackage{tikz}\r\n% \\usepackage{chemfig}\r\n\\usepackage{siunitx}\r\n';
		const found = preflight(source, baked(), caps());
		expect(found).toHaveLength(1);
		expect(found[0]?.message).toContain('siunitx.sty');
		expect(found[0]?.line).toBe(3);
	});

	it('gives the same answer when called twice — the rule regexes are module-level and global', () => {
		const source = '\\usepackage{siunitx}\n\\usetikzlibrary{arrows.meta}\n\\def\\pi{3}';
		const first = preflight(source, baked(), caps());
		expect(first).toHaveLength(3);
		expect(preflight(source, baked(), caps())).toEqual(first);
	});

	describe('\\documentclass (#52)', () => {
		it('fires, because the format dump has already run one', () => {
			const found = preflight('\\documentclass[tikz]{standalone}\n\\begin{document}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('\\documentclass');
			expect(found[0]?.line).toBe(1);
		});

		it('stays silent on the shape every existing vault block already has', () => {
			const source =
				'\\begin{document}\n\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}\n\\end{document}';
			expect(preflight(source, baked(), caps())).toEqual([]);
		});

		it('ignores one that is commented out', () => {
			expect(preflight('% \\documentclass{article}\n\\draw (0,0);', baked(), caps())).toEqual([]);
		});

		it('still sees one after an escaped percent sign, which does not start a comment', () => {
			const found = preflight('\\node {100\\%}; \\documentclass{article}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('\\documentclass');
		});
	});

	describe('\\usepackage (#17 #34 #40 #56 #88 #92 #99)', () => {
		it('fires on a package with no .sty in the bundle', () => {
			const found = preflight('\\usepackage{siunitx}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('siunitx.sty is not bundled');
		});

		it('stays silent on a bundled package, options and all', () => {
			expect(preflight('\\usepackage[siunitx]{circuitikz}', baked(), caps())).toEqual([]);
		});

		it('splits a comma list and reports only the missing member', () => {
			const found = preflight('\\usepackage{tikz,mathtools,pgfplots}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('mathtools.sty');
		});

		it('checks a packages= directive too, and gives it no line', () => {
			const found = preflight('\\begin{document}', baked({ packages: { chemfig: '' } }), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('chemfig.sty');
			expect(found[0]?.line).toBeUndefined();
		});

		it('trusts the generated version table when a .sty ships under a bundle name', () => {
			const engine = caps({ files: new Set<string>(), packages: { circuitikz: '1.0' } });
			expect(preflight('\\usepackage{circuitikz}', baked(), engine)).toEqual([]);
		});

		it('reports a package only once however many times it is loaded', () => {
			expect(preflight('\\usepackage{siunitx}\n\\usepackage{siunitx}', baked(), caps())).toHaveLength(
				1,
			);
		});

		it('warns on a package the generated table records as absent, under either keying', () => {
			// scripts/engine-assets.mjs writes the literal string `absent` for a name kpsewhich could
			// not resolve, and keys the table by FILE name — engine-build/out/tex-versions.txt reads
			// `siunitx.sty            absent`. A presence test that only asks whether the key exists
			// reads the build's own record of "this is missing" as "this is bundled", which silences
			// the rule on exactly the packages it exists for.
			const byFile = caps({ files: new Set(['tikz.sty']), packages: { 'siunitx.sty': 'absent' } });
			expect(preflight('\\usepackage{siunitx}', baked(), byFile)).toHaveLength(1);

			const byName = caps({ files: new Set(['tikz.sty']), packages: { siunitx: 'absent' } });
			expect(preflight('\\usepackage{siunitx}', baked(), byName)).toHaveLength(1);
		});

		it('trusts a version table keyed by file name, which is what the generator writes', () => {
			const engine = caps({ files: new Set(['tikz.sty']), packages: { 'chemfig.sty': 'unknown' } });
			expect(preflight('\\usepackage{chemfig}', baked(), engine)).toEqual([]);
		});

		it('does not let Object.prototype answer for a package', () => {
			expect(preflight('\\usepackage{constructor}', baked(), caps())).toHaveLength(1);
		});

		it('stays silent rather than naming a package made out of the diagram', () => {
			// An unbalanced brace: `\{[^}]*\}` runs past the newline and swallows TeX, so the rule
			// used to report `tikz\n\draw (0.sty is not bundled` — precisely the unreadable
			// diagnostic this module exists to replace.
			expect(preflight('\\usepackage{tikz\n\\draw (0,0);\n}', baked(), caps())).toEqual([]);
			expect(preflight('\\usetikzlibrary{arrows\n\\draw (0,0);\n}', baked(), caps())).toEqual([]);
		});

		it('still splits a multi-line list, which is legal and common', () => {
			const found = preflight('\\usepackage{\n  tikz,\n  siunitx\n}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('siunitx.sty');
		});

		it('recognises a TikZ library loaded as if it were a package', () => {
			const found = preflight('\\usepackage{calc}', baked(), caps());
			expect(found[0]?.hint).toContain('\\usetikzlibrary{calc}');
		});

		it('does not repeat the stale "LaTeX3 is impossible here" advice on an expl3 engine', () => {
			const withExpl3 = preflight('\\usepackage{siunitx}', baked(), caps())[0]?.hint ?? '';
			const without =
				preflight('\\usepackage{siunitx}', baked(), caps({ expl3: false }))[0]?.hint ?? '';
			expect(withExpl3).toContain('does provide expl3');
			expect(without).toContain('no expl3');
		});
	});

	describe('\\usetikzlibrary', () => {
		it('does not warn when only the pgf flavour is present — that is the normal case', () => {
			expect(preflight('\\usetikzlibrary{patterns}', baked(), caps())).toEqual([]);
			expect(preflight('\\usetikzlibrary{plothandlers}', baked(), caps())).toEqual([]);
		});

		it('does not warn when only the tikz flavour is present', () => {
			expect(preflight('\\usetikzlibrary{positioning}', baked(), caps())).toEqual([]);
		});

		it('warns only when both flavours are absent', () => {
			const found = preflight('\\usetikzlibrary{decorations.text}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('tikzlibrarydecorations.text.code.tex');
			expect(found[0]?.message).toContain('pgflibrarydecorations.text.code.tex');
		});

		it('points arrows.meta at the older arrows library it actually has', () => {
			const found = preflight('\\usetikzlibrary{arrows.meta}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.hint).toContain('\\usetikzlibrary{arrows}');
		});

		it('checks a libraries= directive, and each name in a comma list separately', () => {
			const found = preflight('', baked({ libraries: 'calc, fadings ,arrows' }), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('fadings');
		});
	});

	describe('pgfplots compat (#110)', () => {
		it('fires above the bundled version', () => {
			const found = preflight('\\pgfplotsset{compat=1.18}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('newer than the bundled pgfplots 1.16');
			expect(found[0]?.hint).toContain('compat=1.16');
		});

		it('compares numerically, so 1.9 is below 1.16', () => {
			expect(preflight('\\pgfplotsset{compat=1.9}', baked(), caps())).toEqual([]);
			expect(preflight('\\pgfplotsset{compat=1.16}', baked(), caps())).toEqual([]);
		});

		it('accepts compat=newest, which resolves to whatever is installed', () => {
			expect(preflight('\\pgfplotsset{compat=newest}', baked(), caps())).toEqual([]);
		});

		it('sees the key past a nested group and as a package option', () => {
			const nested = '\\pgfplotsset{every axis/.append style={line width=1pt}, compat=1.18}';
			expect(preflight(nested, baked(), caps())).toHaveLength(1);
			expect(preflight('\\usepackage[compat=1.18]{pgfplots}', baked(), caps())).toHaveLength(1);
		});

		it('reads the version table the generator actually writes, keyed by file name', () => {
			// engine-build/out/tex-versions.txt names `pgfplots.sty`, never `pgfplots`, and
			// worker-host.ts hands that record through to `caps.packages` verbatim. Looking only at
			// the bare name made this rule dead code against the engine we ship.
			const engine = caps({ packages: { 'pgfplots.sty': '1.16' } });
			const found = preflight('\\pgfplotsset{compat=1.18}', baked(), engine);
			expect(found).toHaveLength(1);
			expect(found[0]?.hint).toContain('compat=1.16');
		});

		it('takes the version out of a \\ProvidesPackage line, not the date in front of it', () => {
			const engine = caps({ packages: { 'pgfplots.sty': '2021/05/04 v1.16 Data Visualization' } });
			const found = preflight('\\pgfplotsset{compat=1.18}', baked(), engine);
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('bundled pgfplots 1.16');
			// 2021 must not be read as the version, which would make every compat level "older".
			expect(preflight('\\pgfplotsset{compat=1.9}', baked(), engine)).toEqual([]);
		});

		it('says nothing when the table records no comparable version', () => {
			// `unknown` and `absent` are the generator's own sentinels, and pgfplots really does come
			// out as `unknown` on this build (its \ProvidesPackage argument is itself a macro). An
			// empty string must not compare as 0 either — that produced "newer than the bundled
			// pgfplots ." and a hint reading "Use compat=,".
			for (const recorded of ['unknown', 'absent', '']) {
				const engine = caps({ packages: { 'pgfplots.sty': recorded } });
				expect(preflight('\\pgfplotsset{compat=1.18}', baked(), engine)).toEqual([]);
			}
		});

		it('says nothing when the engine has no pgfplots — rule 2 already said more', () => {
			const engine = caps({ packages: {}, files: new Set(['tikz.sty']) });
			const found = preflight('\\pgfplotsset{compat=1.18}', baked(), engine);
			expect(found.map((d) => d.message)).toEqual([]);
		});
	});

	describe('non-Latin-1 codepoints (#19 #36 #53)', () => {
		it('reports the offending characters and where they start', () => {
			const found = preflight('\\begin{document}\n\\node {Ω and →};', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.line).toBe(2);
			expect(found[0]?.message).toContain('U+03A9');
			expect(found[0]?.message).toContain('U+2192');
		});

		it('leaves Latin-1 alone: the engine is 8-bit, not 7-bit', () => {
			expect(preflight('\\node {caf\u00e9 \u00b0C};', baked(), caps())).toEqual([]);
		});

		it('counts an astral character once, not as two surrogate halves', () => {
			const found = preflight('\\node {\u{1F600}};', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('U+1F600');
			expect(found[0]?.message).not.toContain('U+D83D');
		});

		it('ignores characters inside a comment, which TeX discards', () => {
			expect(preflight('% résumé — αβγ\n\\draw (0,0);', baked(), caps())).toEqual([]);
		});

		it('offers inputenc only when inputenc.sty is actually bundled', () => {
			const bare = preflight('\\node {α};', baked(), caps())[0]?.hint ?? '';
			expect(bare).not.toContain('inputenc');

			const withInputenc = caps({ files: new Set(['inputenc.sty']) });
			const hint = preflight('\\node {α};', baked(), withInputenc)[0]?.hint ?? '';
			expect(hint).toContain('inputenc');
		});
	});

	describe('redefining a built-in (#96)', () => {
		it('catches \\pgfmathsetmacro over a math symbol', () => {
			const found = preflight('\\pgfmathsetmacro{\\epsilon}{0.15}', baked(), caps());
			expect(found).toHaveLength(1);
			expect(found[0]?.message).toContain('\\epsilon');
			expect(found[0]?.hint).toContain('\\myepsilon');
		});

		it('catches \\def and \\newcommand over a TeX parameter or primitive', () => {
			expect(preflight('\\def\\time{3}', baked(), caps())).toHaveLength(1);
			expect(preflight('\\newcommand{\\output}{x}', baked(), caps())).toHaveLength(1);
			expect(preflight('\\renewcommand*\\day{7}', baked(), caps())).toHaveLength(1);
			expect(preflight('\\edef\\input{x}', baked(), caps())).toHaveLength(1);
			expect(preflight('\\let\\node\\relax', baked(), caps())).toHaveLength(1);
		});

		it('leaves an author-namespaced macro alone', () => {
			const source = '\\def\\myepsilon{0.15}\n\\newcommand{\\timeStep}{2}\n\\pgfmathsetmacro{\\r}{1.5}';
			expect(preflight(source, baked(), caps())).toEqual([]);
		});

		it('does not fire on \\foreach variables, which are the idiom', () => {
			expect(preflight('\\foreach \\x/\\y in {1/2} { \\draw (\\x,\\y); }', baked(), caps())).toEqual(
				[],
			);
		});

		it('does not fire on \\providecommand, which cannot overwrite anything', () => {
			expect(preflight('\\providecommand{\\epsilon}{x}', baked(), caps())).toEqual([]);
		});

		it('does not fire on a name that merely starts with a built-in', () => {
			expect(preflight('\\def\\pird{3}\n\\newcommand{\\endpoint}{a}', baked(), caps())).toEqual([]);
		});

		it('reports each redefined name once', () => {
			expect(preflight('\\def\\pi{3}\n\\def\\pi{4}', baked(), caps())).toHaveLength(1);
		});
	});
});

describe('rule 3b - usepgfplotslibrary (upstream #28, #79)', () => {
	it('warns when neither flavour of the library file is bundled', () => {
		const out = preflight('\\usepgfplotslibrary{groupplots}', baked(), caps());
		const hit = out.find((d) => d.message.includes('groupplots'));
		expect(hit).toBeDefined();
		// The hint must explain why this is worse than a missing tikz library: the fallback
		// \input targets a name that exists in no TeX distribution, so the diagram dies rather
		// than the library being skipped.
		expect(hit?.hint).toContain('fatal');
	});

	it('stays silent when the tikz flavour is bundled', () => {
		const withLib = caps({
			files: new Set([...caps().files, 'tikzlibrarypgfplots.fillbetween.code.tex']),
		});
		expect(preflight('\\usepgfplotslibrary{fillbetween}', baked(), withLib)).toHaveLength(0);
	});

	it('reports each missing library once, however often it is loaded', () => {
		const src = '\\usepgfplotslibrary{polar}\n\\usepgfplotslibrary{polar}';
		const hits = preflight(src, baked(), caps()).filter((d) => d.message.includes('polar'));
		expect(hits).toHaveLength(1);
	});

	it('handles a comma list', () => {
		const out = preflight('\\usepgfplotslibrary{groupplots,polar}', baked(), caps());
		expect(out.filter((d) => d.kind === 'warning').length).toBeGreaterThanOrEqual(2);
	});
});
