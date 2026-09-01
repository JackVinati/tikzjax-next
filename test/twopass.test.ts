import { buildSync, transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

/*
 * The second-pass decision, tested on the shipped worker's own source.
 *
 * engine-src/worker.ts cannot be imported: it is a worker ENTRY POINT, so importing it compiles
 * 526 KB of WebAssembly, inflates a 156 MiB core dump and installs an `onmessage` handler, and it
 * imports `virtual:engine-assets`, a module that exists only inside the esbuild build. Copying the
 * predicate into this file instead would assert a copy — the one thing a test must never do, since
 * the copy passes forever after the original changes.
 *
 * So the block between the TWOPASS markers is lifted out of the real file, stripped of its types
 * and run. That block is deliberately self-contained (no imports, no references to the rest of the
 * worker) precisely so this works, and the first test below fails loudly if someone moves or
 * renames it rather than letting the suite quietly test nothing.
 */

/** Relative to the project root, which is where vitest runs (vitest.config.ts lives there). */
const WORKER = 'engine-src/worker.ts';
const BEGIN = '/* TWOPASS:BEGIN';
const END = '/* TWOPASS:END */';

interface CarriedFile {
	name: string;
	text: string;
}

/**
 * The worker's source, as text.
 *
 * Read through esbuild rather than `node:fs` because tsconfig sets `"types": []` — a browser
 * plugin must never see Node's globals, so `node:fs` has no declarations in this project at all.
 * esbuild is typed, is already a devDependency, and its `text` loader turns any file into a module
 * whose export is that file's contents.
 */
function readWorker(): string {
	const [built] = buildSync({
		entryPoints: [WORKER],
		loader: { '.ts': 'text' },
		bundle: false,
		write: false,
		format: 'iife',
		globalName: 'RAW',
	}).outputFiles;
	if (!built) throw new Error(`esbuild produced no output for ${WORKER}`);
	return new Function(`${built.text}\nreturn RAW;`)() as string;
}

interface Block {
	source: string;
	secondPassWarranted: (carried: readonly CarriedFile[]) => boolean;
	AUX_BOILERPLATE: RegExp;
	FIRST_JOB: string;
	SECOND_JOB: string;
	CARRIED: readonly string[];
	reportedRange: (
		logLength: number,
		firstEnd: number,
		adoptedSecondPass: boolean,
		firstPassSpoke: boolean,
	) => { from: number; to: number };
}

function extract(): Block {
	const file = readWorker();
	const from = file.indexOf(BEGIN);
	const to = file.indexOf(END);
	if (from < 0 || to < 0) throw new Error(`engine-src/worker.ts no longer marks its two-pass block with ${BEGIN} … ${END}`);

	const block = file.slice(from, to);
	const js = transformSync(block, { loader: 'ts' }).code;
	const exported =
		'return { secondPassWarranted, AUX_BOILERPLATE, FIRST_JOB, SECOND_JOB, CARRIED, reportedRange };';
	return { source: block, ...(new Function(`${js}\n${exported}`)() as Omit<Block, 'source'>) };
}

const { source, secondPassWarranted, AUX_BOILERPLATE, FIRST_JOB, SECOND_JOB, CARRIED, reportedRange } = extract();

const aux = (text: string): CarriedFile[] => [{ name: 'input2.aux', text }];

/**
 * The exact .aux every one of the 21 fixtures in test/fixtures/tex leaves behind — captured from a
 * run, not written from memory. 32 bytes, trailing space after `\relax` and all.
 */
const BOILERPLATE_AUX = '\\relax \n\\gdef \\@abspage@last{1}\n';

describe('secondPassWarranted', () => {
	it('is the block engine-src/worker.ts actually ships', () => {
		expect(BOILERPLATE_AUX.length).toBe(32);
		expect(source).toContain('const secondPassWarranted');
		expect(typeof secondPassWarranted).toBe('function');
		expect(AUX_BOILERPLATE).toBeInstanceOf(RegExp);
	});

	it('refuses a second pass when the first wrote nothing at all', () => {
		// Nothing carried means nothing for a second run to read, so a second run cannot differ
		// from the first — it can only cost twice as long.
		expect(secondPassWarranted([])).toBe(false);
	});

	it('refuses a second pass on the .aux a plain diagram leaves behind', () => {
		// This is the case that keeps `twoPass` free rather than 2x on the diagrams it cannot help.
		// On this engine that includes every \chemmove (#9) and \polymerdelim (#70) block: the
		// pgfsys-ximera driver does not mark positions, so nothing is ever written for a second
		// pass to read back.
		expect(secondPassWarranted(aux(BOILERPLATE_AUX))).toBe(false);
	});

	it('refuses a second pass on an .aux that is only whitespace', () => {
		expect(secondPassWarranted(aux(''))).toBe(false);
		expect(secondPassWarranted(aux('\n\n   \n'))).toBe(false);
	});

	it('runs a second pass when the first wrote a cross-reference', () => {
		// The measured case: `??` on one pass, the real number on two.
		expect(secondPassWarranted(aux('\\relax \n\\newlabel{e}{{1}{1}{}{}{}}\n\\gdef \\@abspage@last{1}\n'))).toBe(true);
	});

	it('runs a second pass when the first wrote picture positions', () => {
		// What `remember picture` writes on a driver that supports position marking. Not this
		// engine's — but the predicate is what a future driver needs to already be right.
		expect(secondPassWarranted(aux('\\relax \n\\pgfsyspdfmark {pgfid1}{3355443}{6710886}\n'))).toBe(true);
	});

	it('looks at every carried file, not just the .aux', () => {
		// A .toc is written by one run and read by the next exactly as an .aux is, so a payload
		// there is as good a reason to re-run.
		expect(
			secondPassWarranted([
				{ name: 'input2.aux', text: BOILERPLATE_AUX },
				{ name: 'input2.toc', text: '\\contentsline {section}{Title}{1}\n' },
			]),
		).toBe(true);
	});

	it('treats the page count as boilerplate whatever the page count is', () => {
		// The count is not fixed at 1: a tall diagram spills onto a second page. Matching only
		// `{1}` would send every one of those into a pointless second compile.
		expect(secondPassWarranted(aux('\\relax \n\\gdef \\@abspage@last{12}\n'))).toBe(false);
	});

	it('does not mistake a longer macro name for the boilerplate one', () => {
		// Anchored, so `\@abspage@lastthing` is payload rather than a near-miss silently ignored.
		expect(secondPassWarranted(aux('\\gdef \\@abspage@lastthing{1}\n'))).toBe(true);
		expect(secondPassWarranted(aux('\\relaxation{1}\n'))).toBe(true);
	});
});

describe('the two runs', () => {
	it('do not share a job name', () => {
		// library.readFileSync() returns the FIRST entry in the run's file table with a matching
		// name, and pass one's `input.dvi` is still in that table when pass two finishes. Two runs
		// under one name therefore hand pass ONE's DVI back and the feature silently renders
		// nothing new — measured: a `\refstepcounter\label` + `\ref` block still logs the
		// second-pass marker, still pays for the second compile, and still returns pass one's
		// 899-byte `??` render instead of the 761-byte resolved one, with no diagnostic anywhere.
		// Nothing downstream can notice, so this is the only place it can be caught.
		expect(SECOND_JOB).not.toBe(FIRST_JOB);
	});

	it('carry the files a run writes for the next run to read, and nothing it only writes', () => {
		// `.aux` is the one that matters (\label/\ref); `.toc` and `.out` are written by one run
		// and read by the next in exactly the same way. `.dvi` and `.log` are outputs — carrying
		// either would put pass one's drawing where pass two's belongs.
		expect([...CARRIED].sort()).toEqual(['aux', 'out', 'toc']);
	});
});

/*
 * Both passes write into one log array, so which run a diagnostic came from is a question about
 * positions in that array. `firstEnd` is where pass one's output stops.
 */
describe('reportedRange', () => {
	const LOG_LENGTH = 10;
	const FIRST_END = 4;
	const passOne = { from: 0, to: FIRST_END };
	const passTwo = { from: FIRST_END, to: LOG_LENGTH };

	it('reports pass one when there was only one pass', () => {
		expect(reportedRange(FIRST_END, FIRST_END, false, false)).toEqual(passOne);
		expect(reportedRange(FIRST_END, FIRST_END, false, true)).toEqual(passOne);
	});

	it('never reports a pass whose diagram was thrown away', () => {
		// THE REGRESSION. A second pass that wrote no DVI is discarded — the diagram on screen is
		// pass one's, which compiled cleanly — but its `!` lines are still sitting in the shared
		// log. Reading them back puts a warning, and an `l.NN` blaming input2.tex, on a diagram
		// that pass one produced without complaint. `OkMessage.firstError` means "TeX complained
		// about the diagram you are looking at"; a discarded run has no standing to say anything.
		//
		// Reproduced on the real engine: `\refstepcounter{equation}\label{e}` +
		// `\@ifundefined{r@e}{}{\errmessage{...}\csname @@end\endcsname}` + a picture reading
		// `\ref{e}` renders the same 899 B on one pass and two (pass two writes no pages) and came
		// back carrying `firstError: 'discarded pass talked.'`, `line: 2`.
		expect(reportedRange(LOG_LENGTH, FIRST_END, false, false)).toEqual(passOne);
	});

	it('reports pass two once pass two is the diagram on screen', () => {
		expect(reportedRange(LOG_LENGTH, FIRST_END, true, false)).toEqual(passTwo);
	});

	it('still prefers pass one when pass one had something to say', () => {
		// Under \nonstopmode the common failure is a diagram that renders with a piece missing.
		// If pass one named the mistyped macro, that is the message the user needs — a second pass
		// blaming a line in its own copy of the same source is noise on top of it.
		expect(reportedRange(LOG_LENGTH, FIRST_END, true, true)).toEqual(passOne);
	});
});
