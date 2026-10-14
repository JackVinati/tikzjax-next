/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { README_LOCKDOWN, README_OUT_OF_STEP } from '../src/ui/strings';

/**
 * The README's list of bundled packages and libraries is the answer to the most common question
 * anyone has before installing, and the old one answered it from memory: twelve names, against 42
 * packages and a hundred libraries in the engine. It is written out in the README so it can be read
 * on GitHub, and checked here against the committed engine so it cannot drift from it. After an
 * engine rebuild that adds or drops a file, this fails with the names to add or remove.
 */

// Vite's glob rather than node:fs, like preflight.test.ts: the tests typecheck without Node's types.
const texts = import.meta.glob<string>(['../README.md', '../engine-build/out/tex-versions.txt'], {
	query: '?raw',
	import: 'default',
	eager: true,
});
const texFiles = Object.keys(import.meta.glob('../engine-build/out/dist/tex_files/*.gz'));

const readme = texts['../README.md'] ?? '';

/** The backticked names between `<!-- bundled:<what> -->` and `<!-- /bundled:<what> -->`. */
function listed(what: string): string[] {
	const start = readme.indexOf(`<!-- bundled:${what} -->`);
	const end = readme.indexOf(`<!-- /bundled:${what} -->`);
	if (start === -1 || end === -1 || end < start) return [];
	return [...readme.slice(start, end).matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

function shipped(): { packages: string[]; tikz: string[]; pgfplots: string[] } {
	const files = texFiles.map((path) => path.slice(path.lastIndexOf('/') + 1, -'.gz'.length));
	const packages = files.filter((f) => f.endsWith('.sty')).map((f) => f.slice(0, -'.sty'.length));
	const tikz = new Set<string>();
	const pgfplots = new Set<string>();
	for (const f of files) {
		// \usetikzlibrary{x} loads tikzlibraryx.code.tex, or pgflibraryx.code.tex when TikZ has no
		// file of its own (arrows.meta is one), so a library is bundled if either flavour is.
		const name = /^(?:tikz|pgf)library(.+)\.code\.tex$/.exec(f)?.[1];
		if (name === undefined) continue;
		if (name.startsWith('pgfplots.')) pgfplots.add(name.slice('pgfplots.'.length));
		else tikz.add(name);
	}
	return { packages, tikz: [...tikz], pgfplots: [...pgfplots] };
}

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe('README', () => {
	const engine = shipped();

	it('lists exactly the packages the engine bundles', () => {
		expect(engine.packages.length).toBeGreaterThan(30);
		expect(sorted(listed('packages'))).toEqual(sorted(engine.packages));
	});

	it('lists exactly the TikZ libraries the engine bundles', () => {
		expect(sorted(listed('tikz-libraries'))).toEqual(sorted(engine.tikz));
	});

	it('lists exactly the pgfplots libraries the engine bundles', () => {
		expect(sorted(listed('pgfplots-libraries'))).toEqual(sorted(engine.pgfplots));
	});

	it('quotes the package versions the engine reports', () => {
		const versions = texts['../engine-build/out/tex-versions.txt'] ?? '';
		for (const name of ['pgf.sty', 'pgfplots.sty', 'circuitikz.sty', 'chemfig.sty', 'siunitx.sty']) {
			const version = new RegExp(`^${name.split('.').join('\\.')}\\s+(\\S+)`, 'm').exec(versions)?.[1];
			expect(version, name).toBeDefined();
			expect(readme, `${name} ${version ?? ''}`).toContain(` ${version ?? ''}`);
		}
	});

	// The diagnostics view and the notices link to these answers (src/ui/strings.ts), on a phone where
	// there is nothing else to read: a link to an anchor the README lost would land at its top.
	it('has the answers the plugin links to, where it links to them', () => {
		const answers: [string, string][] = [
			[README_LOCKDOWN, 'Diagrams are very slow on my iPhone or iPad.'],
			[
				README_OUT_OF_STEP,
				'After an update, another device shows the new version but nothing changed.',
			],
		];
		for (const [url, question] of answers) {
			const anchor = url.slice(url.indexOf('#') + 1);
			expect(url).toBe(`https://github.com/JackVinati/tikzjax-next#${anchor}`);
			expect(readme).toContain(`<a id="${anchor}"></a>**${question}**`);
		}
	});
});
