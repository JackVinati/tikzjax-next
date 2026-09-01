/**
 * Refuses to ship a bundle containing syntax or APIs that iOS cannot run.
 *
 *   node scripts/check-mobile.mjs [main.js]
 *
 * This exists because of a single regex. `src/svg/freeze.ts` matched `currentColor` with a
 * lookbehind, `(?<![-\w])`, which JavaScriptCore rejects before Safari 16.4 — and a rejected regex
 * literal is a SYNTAX error, so the whole 11 MB bundle failed to parse and Obsidian on an iPhone
 * said only "failed to load plugin". No test could have caught it: every test runs in Node, where
 * the regex is fine, and the module it lived in is one most notes never reach.
 *
 * esbuild does not catch this either. Its `target` covers syntax it can transpile; it neither
 * rewrites a lookbehind nor warns about `Array.prototype.at`, because that is a library method and
 * a bundler does not polyfill. So the check is here, against the built artifact, where the answer
 * is a fact rather than an inference about which code path ran.
 *
 * The floor is Safari 15 — Obsidian's own iOS minimum at the time of writing. Anything below the
 * floor is an error, not a warning: a warning in a build nobody reads is the state that shipped
 * 0.1.0.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Each pattern is written to be findable in MINIFIED output, which rules out anything that depends
 * on whitespace or identifier names. False positives cost a build; a false negative costs a user
 * who cannot enable the plugin and has no way to find out why.
 */
const HAZARDS = [
	{
		name: 'regular expression lookbehind',
		since: 'Safari 16.4',
		fatal: 'parse',
		// Not `(?<name>`, which is a named CAPTURE group and has been fine since Safari 11.
		pattern: /\(\?<[=!]/g,
		fix: 'Capture the preceding character instead and put it back in the replacer.',
	},
	// The regex `v` flag (Safari 17) belongs on this list and is not on it: telling a flags cluster
	// from a division inside minified code needs a parser, not a pattern, and the first attempt
	// matched `/svg.` in `match(/<\/svg.*>/g)` — a false positive fails every build, which is worse
	// than the risk it covers. Nothing in the dependency set uses it, and es2022 predates it.
	{
		name: 'class static initialisation block',
		since: 'Safari 16.4',
		fatal: 'parse',
		pattern: /\bstatic\s*\{/g,
		fix: 'Move the initialisation into a module-level constant.',
	},
	{
		name: 'Array.prototype.at / String.prototype.at',
		since: 'Safari 15.4',
		fatal: 'runtime',
		pattern: /\.at\(-/g,
		fix: 'Index with .length - 1.',
	},
	{
		name: 'Object.hasOwn',
		since: 'Safari 15.4',
		fatal: 'runtime',
		pattern: /\bObject\.hasOwn\(/g,
		fix: 'Object.prototype.hasOwnProperty.call.',
	},
	{
		name: 'Object.groupBy',
		since: 'Safari 17.4',
		fatal: 'runtime',
		pattern: /\bObject\.groupBy\(/g,
		fix: 'Build the map with a loop.',
	},
	{
		name: 'Promise.withResolvers',
		since: 'Safari 17.4',
		fatal: 'runtime',
		pattern: /\.withResolvers\(/g,
		fix: 'Hold the resolve/reject from the executor.',
	},
	{
		name: 'Array.prototype.findLast',
		since: 'Safari 15.4',
		fatal: 'runtime',
		pattern: /\.findLast(Index)?\(/g,
		fix: 'Loop backwards.',
	},
	{
		name: 'Array.prototype.toSorted / toReversed / toSpliced',
		since: 'Safari 16',
		fatal: 'runtime',
		pattern: /\.to(Sorted|Reversed|Spliced)\(/g,
		fix: 'Copy with slice() first.',
	},
	{
		name: 'structuredClone',
		since: 'Safari 15.4',
		fatal: 'runtime',
		pattern: /\bstructuredClone\(/g,
		fix: 'Clone explicitly.',
	},
	{
		name: 'RegExp.escape',
		since: 'Safari 26',
		fatal: 'runtime',
		pattern: /\bRegExp\.escape\(/g,
		fix: 'Escape with a replace().',
	},
];

/** A window of the bundle around a hit, enough to recognise the code without dumping minified soup. */
function excerpt(code, index) {
	return code.slice(Math.max(0, index - 70), index + 70).replace(/\s+/g, ' ');
}

export function findMobileHazards(code) {
	const found = [];
	for (const hazard of HAZARDS) {
		hazard.pattern.lastIndex = 0;
		const match = hazard.pattern.exec(code);
		if (!match) continue;
		hazard.pattern.lastIndex = 0;
		const count = (code.match(hazard.pattern) ?? []).length;
		found.push({ ...hazard, count, where: excerpt(code, match.index) });
	}
	return found;
}

export function assertMobileSafe(code, label = 'the bundle') {
	const found = findMobileHazards(code);
	if (found.length === 0) return;

	console.error(`\n${label} cannot run on iOS:\n`);
	for (const h of found) {
		console.error(`  ${h.name} — ${h.since}, ${h.count} occurrence(s)`);
		console.error(
			h.fatal === 'parse'
				? '    This is a PARSE error below that version: nothing in the plugin runs, and Obsidian'
				: '    This throws when the code path runs.',
		);
		if (h.fatal === 'parse') console.error('    reports only "failed to load plugin".');
		console.error(`    ${h.fix}`);
		console.error(`    ...${h.where}...\n`);
	}
	throw new Error(`${found.length} hazard(s) that iOS cannot run — see above`);
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
	const file = process.argv[2] ?? join(process.cwd(), 'main.js');
	try {
		assertMobileSafe(readFileSync(file, 'utf8'), file);
		console.log(`${file}: nothing that iOS cannot run`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
