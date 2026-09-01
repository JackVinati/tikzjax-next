import { describe, expect, it } from 'vitest';
import { findTikzBlocks, finalizeBlock, unfinalizeBlock, type TikzBlockSpan } from '../src/note/finalize';

// Notes are written as line arrays and joined with an explicit terminator, so every test says out
// loud which line ending it is about. A trailing '' element is a trailing newline — the thing a
// round-trip assertion is most likely to lose and least likely to be noticed losing.
function note(lines: string[], eol = '\n'): string {
	return lines.join(eol);
}

/** The one thing a caller can never be allowed to get wrong: what the offsets actually select. */
function sliceOf(text: string, span: TikzBlockSpan): string {
	return text.slice(span.start, span.end);
}

function only(spans: TikzBlockSpan[]): TikzBlockSpan {
	expect(spans).toHaveLength(1);
	return spans[0] as TikzBlockSpan;
}

// -------------------------------------------------------------------------------------------

describe('findTikzBlocks: the fence itself', () => {
	it('selects the whole fence, backticks included, and nothing around it', () => {
		const text = note(['# Heading', '', '```tikz', '\\draw (0,0) -- (1,1);', '```', '', 'after', '']);
		const span = only(findTikzBlocks(text));

		expect(sliceOf(text, span)).toBe(note(['```tikz', '\\draw (0,0) -- (1,1);', '```']));
		expect(span.source).toBe('\\draw (0,0) -- (1,1);\n');
		expect(span.info).toBe('tikz');
		expect(span.finalized).toBe(false);
	});

	it('does not close a four-backtick fence on a three-backtick line inside a \\node', () => {
		// The reason the closing fence has to match the opening LENGTH rather than just be a fence:
		// a tikz label can legitimately contain a run of backticks, and a scanner that stopped at
		// the first ``` would cut the block in half and finalize a fragment.
		const text = note(['````tikz', '\\node {```};', '\\draw (0,0);', '````', '']);
		const span = only(findTikzBlocks(text));

		expect(span.source).toBe(note(['\\node {```};', '\\draw (0,0);', '']));
		expect(sliceOf(text, span).endsWith('````')).toBe(true);
	});

	it('accepts a closing fence longer than its opener', () => {
		const text = note(['```tikz', '\\draw (0,0);', '``````', '']);
		expect(only(findTikzBlocks(text)).source).toBe('\\draw (0,0);\n');
	});

	it('reads tilde fences', () => {
		const text = note(['~~~tikz', '\\draw (0,0);', '~~~', '']);
		const span = only(findTikzBlocks(text));

		expect(span.source).toBe('\\draw (0,0);\n');
		expect(sliceOf(text, span)).toBe(note(['~~~tikz', '\\draw (0,0);', '~~~']));
	});

	it('does not close a tilde fence with backticks, or the reverse', () => {
		const text = note(['~~~tikz', '```', '\\draw (0,0);', '~~~', '']);
		expect(only(findTikzBlocks(text)).source).toBe(note(['```', '\\draw (0,0);', '']));
	});

	it('ignores fences in other languages, and matches the language case-insensitively', () => {
		const text = note(['```js', 'const tikz = 1;', '```', '', '```TikZ', '\\draw (0,0);', '```', '']);
		const span = only(findTikzBlocks(text));

		expect(span.info).toBe('TikZ');
		expect(span.source).toBe('\\draw (0,0);\n');
	});

	it('does not treat ```tikzcd as a tikz block', () => {
		// The registry is keyed on the whole first token; `tikzcd` is a different processor (and may
		// belong to another plugin entirely). Finalizing someone else's block would be vandalism.
		const text = note(['```tikzcd', 'A \\to B', '```', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});

	it('does not see a tikz fence nested inside a larger markdown block', () => {
		// A tutorial note quoting the plugin's own syntax inside a ````markdown block must not have
		// its example silently replaced by an attachment.
		const text = note(['````markdown', '```tikz', '\\draw (0,0);', '```', '````', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});
});

describe('findTikzBlocks: indentation', () => {
	it('keeps a list item indentation in the offsets and strips it from the source', () => {
		const text = note(['- item', '  ```tikz', '  \\draw (0,0);', '  ```', '', 'tail', '']);
		const span = only(findTikzBlocks(text));

		expect(sliceOf(text, span)).toBe(note(['  ```tikz', '  \\draw (0,0);', '  ```']));
		// Dedented by the opener's indentation, the way CommonMark dedents fenced content — the
		// source that reaches TeX must not carry the list's two spaces.
		expect(span.source).toBe('\\draw (0,0);\n');
	});

	it('accepts a closing fence indented differently from its opener', () => {
		const text = note(['- item', '  ```tikz', '  \\draw (0,0);', '    ```', '']);
		const span = only(findTikzBlocks(text));

		expect(sliceOf(text, span).endsWith('    ```')).toBe(true);
		expect(span.source).toBe('\\draw (0,0);\n');
	});

	it('never dedents past the opener indentation', () => {
		const text = note(['  ```tikz', '      \\draw (0,0);', '  ```', '']);
		expect(only(findTikzBlocks(text)).source).toBe('    \\draw (0,0);\n');
	});
});

describe('findTikzBlocks: an unterminated fence', () => {
	it('ends the block at the end of the note instead of throwing', () => {
		const text = note(['prose', '```tikz', '\\draw (0,0);', '']);
		const span = only(findTikzBlocks(text));

		expect(span.end).toBeLessThanOrEqual(text.length);
		expect(sliceOf(text, span)).toBe(note(['```tikz', '\\draw (0,0);']));
		expect(span.source).toBe('\\draw (0,0);\n');
	});

	it('terminates on a lone opening fence as the last line of the note', () => {
		const text = note(['prose', '```tikz']);
		const span = only(findTikzBlocks(text));

		expect(span.source).toBe('');
		expect(sliceOf(text, span)).toBe('```tikz');
	});

	it('does not throw or hang on an empty note, whitespace, or a bare fence character run', () => {
		expect(findTikzBlocks('')).toEqual([]);
		expect(findTikzBlocks('\n\n\n')).toEqual([]);
		expect(findTikzBlocks('```')).toEqual([]);
		expect(findTikzBlocks('~~~~~~')).toEqual([]);
	});
});

describe('findTikzBlocks: %% comments', () => {
	it('does not report a tikz fence that is inside a plain %% comment', () => {
		// A commented-out block does not render, so there is nothing to finalize. Reporting it would
		// mean writing an attachment for a diagram the reader never sees.
		const text = note(['%%', '```tikz', '\\draw (0,0);', '```', '%%', '', 'tail', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});

	it('resumes scanning after the comment closes', () => {
		const text = note(['%%', 'a note to self', '%%', '', '```tikz', '\\draw (0,0);', '```', '']);
		expect(only(findTikzBlocks(text)).source).toBe('\\draw (0,0);\n');
	});

	it('is not confused by %% lines inside a tikz body', () => {
		// `%` is TeX's comment character, so `%%` is ordinary source. A scanner that treated it as a
		// comment delimiter would end the block in the middle of the diagram.
		const text = note(['```tikz', '%% a TeX section rule', '\\draw (0,0);', '%%', '```', '']);
		const span = only(findTikzBlocks(text));

		expect(span.source).toBe(note(['%% a TeX section rule', '\\draw (0,0);', '%%', '']));
	});

	it('is not confused by %% lines inside a fence that is itself inside a comment', () => {
		const text = note(['%%', '```tex', '%%', '```', '%%', '', '```tikz', '\\draw (0,0);', '```', '']);
		expect(only(findTikzBlocks(text)).source).toBe('\\draw (0,0);\n');
	});

	it('treats an unclosed %% as commenting the rest of the note', () => {
		// Documented divergence, and it matches what Obsidian renders: a block after a stray `%%`
		// does not render, so it has nothing to finalize.
		const text = note(['%%', 'forgot to close this', '', '```tikz', '\\draw (0,0);', '```', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});
});

describe('findTikzBlocks: recognising a finalized block', () => {
	const finalized = note([
		'intro',
		'',
		'![[Diagram 1.svg]]',
		'%%',
		'```tikz',
		'\\draw (0,0);',
		'```',
		'%%',
		'',
		'tail',
		'',
	]);

	it('covers the embed, the wrapper and the fence, and reports the preserved source', () => {
		const span = only(findTikzBlocks(finalized));

		expect(span.finalized).toBe(true);
		expect(sliceOf(finalized, span)).toBe(note(['![[Diagram 1.svg]]', '%%', '```tikz', '\\draw (0,0);', '```', '%%']));
		expect(span.source).toBe('\\draw (0,0);\n');
		expect(span.info).toBe('tikz');
	});

	it('keeps scanning after a finalized block', () => {
		const text = finalized + note(['```tikz', '\\draw (1,1);', '```', '']);
		const spans = findTikzBlocks(text);

		expect(spans.map((s) => s.finalized)).toEqual([true, false]);
		expect(spans[1]?.source).toBe('\\draw (1,1);\n');
	});

	it('does not call a commented-out fence finalized when no embed precedes it', () => {
		const text = note(['%%', '```tikz', '\\draw (0,0);', '```', '%%', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});

	it('does not call it finalized when the embed is separated by a blank line', () => {
		// Adjacency is the whole signal. If a blank line counted, un-finalize would delete an embed
		// that belongs to the paragraph above it.
		const text = note(['![[a.svg]]', '', '%%', '```tikz', '\\draw (0,0);', '```', '%%', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});

	it('does not call it finalized when the commented fence is another language', () => {
		const text = note(['![[a.svg]]', '%%', '```js', 'x', '```', '%%', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});
});

// -------------------------------------------------------------------------------------------

describe('finalizeBlock', () => {
	it('writes the embed and preserves the fence verbatim inside a comment', () => {
		const text = note(['# Note', '', '```tikz', '\\draw (0,0) -- (1,1);', '```', '', 'tail', '']);
		const out = finalizeBlock(text, only(findTikzBlocks(text)), 'Note diagram.svg');

		expect(out).toBe(
			note([
				'# Note',
				'',
				'![[Note diagram.svg]]',
				'%%',
				'```tikz',
				'\\draw (0,0) -- (1,1);',
				'```',
				'%%',
				'',
				'tail',
				'',
			]),
		);
	});

	it('keeps the region inside the list item the diagram lived in', () => {
		const text = note(['- item', '  ```tikz', '  \\draw (0,0);', '  ```', '']);
		const out = finalizeBlock(text, only(findTikzBlocks(text)), 'd.svg');

		expect(out).toBe(note(['- item', '  ![[d.svg]]', '  %%', '  ```tikz', '  \\draw (0,0);', '  ```', '  %%', '']));
	});

	it('re-finalizing swaps the embed and leaves the preserved source untouched', () => {
		const text = note(['![[old.svg]]', '%%', '```tikz', '\\draw (0,0);', '```', '%%', '']);
		const out = finalizeBlock(text, only(findTikzBlocks(text)), 'new.svg');

		expect(out).toBe(note(['![[new.svg]]', '%%', '```tikz', '\\draw (0,0);', '```', '%%', '']));
	});

	it('refuses an unterminated fence rather than writing something it cannot undo', () => {
		const text = note(['```tikz', '\\draw (0,0);', '']);
		const span = only(findTikzBlocks(text));

		expect(() => finalizeBlock(text, span, 'd.svg')).toThrow(/unterminated/);
	});

	it('refuses an attachment name that would break the embed', () => {
		const text = note(['```tikz', '\\draw (0,0);', '```', '']);
		const span = only(findTikzBlocks(text));

		expect(() => finalizeBlock(text, span, '')).toThrow();
		expect(() => finalizeBlock(text, span, '   ')).toThrow();
		expect(() => finalizeBlock(text, span, 'a]]b.svg')).toThrow();
		expect(() => finalizeBlock(text, span, 'a\nb.svg')).toThrow();
		// A subfolder and an alias are both legitimate and must still work.
		expect(finalizeBlock(text, span, 'attachments/d.svg|300')).toContain('![[attachments/d.svg|300]]');
	});

	it('never writes a region its own scanner cannot find again', () => {
		// The requirement finalize exists to keep: it is not a one-way door. Whatever name the
		// caller hands us, the result must either be refused outright or come back from
		// `findTikzBlocks` as a finalized span — otherwise the preserved TeX is sealed inside a
		// comment that nothing can reopen, and the user's source is gone from the plugin's view.
		//
		// A single `]` was the hole: it closes the embed early, so `![[a]b.svg]]` is neither a
		// wiki-link Obsidian resolves nor a line this module recognises.
		const text = note(['```tikz', '\\draw (0,0);', '```', '']);
		const names = [
			'd.svg',
			'My Note 1.svg',
			'attachments/My Note.svg',
			'attachments/d.svg|300',
			'ä — diagram.svg',
			'a-b_c (1).svg',
			'a]b.svg',
			'a[b.svg',
			'a]]b.svg',
		];

		for (const name of names) {
			let out: string;
			try {
				out = finalizeBlock(text, only(findTikzBlocks(text)), name);
			} catch {
				continue; // A refusal is a safe outcome; a silently unrecoverable note is not.
			}
			const spans = findTikzBlocks(out);
			expect(spans, `name ${JSON.stringify(name)} produced ${JSON.stringify(out)}`).toHaveLength(1);
			expect(spans[0]?.finalized, `name ${JSON.stringify(name)}`).toBe(true);
			expect(unfinalizeBlock(out, spans[0] as TikzBlockSpan)).toBe(text);
		}
	});

	it('refuses a span that no longer describes the note', () => {
		const text = note(['```tikz', '\\draw (0,0);', '```', '']);
		const stale = { ...only(findTikzBlocks(text)), start: 2 };

		expect(() => finalizeBlock(text, stale, 'd.svg')).toThrow();
		expect(() => finalizeBlock('short', { ...stale, start: 0, end: 900 }, 'd.svg')).toThrow(/out of range/);
	});
});

describe('unfinalizeBlock', () => {
	it('round-trips byte for byte, surrounding content and trailing newline included', () => {
		const original = note(['# Note', '', 'before', '', '```tikz', '\\draw (0,0) -- (1,1);', '```', '', 'after', '']);
		const finalized = finalizeBlock(original, only(findTikzBlocks(original)), 'd.svg');

		expect(unfinalizeBlock(finalized, only(findTikzBlocks(finalized)))).toBe(original);
	});

	it('round-trips a note that does not end with a newline', () => {
		const original = note(['```tikz', '\\draw (0,0);', '```']);
		const finalized = finalizeBlock(original, only(findTikzBlocks(original)), 'd.svg');

		expect(finalized.endsWith('%%')).toBe(true);
		expect(unfinalizeBlock(finalized, only(findTikzBlocks(finalized)))).toBe(original);
	});

	it('round-trips a block whose body contains %% and backtick runs', () => {
		const original = note(['````tikz', '%% TeX comment', '\\node {```};', '', '\\draw (0,0);', '````', '']);
		const finalized = finalizeBlock(original, only(findTikzBlocks(original)), 'd.svg');

		expect(unfinalizeBlock(finalized, only(findTikzBlocks(finalized)))).toBe(original);
	});

	it('round-trips an indented block in a list item', () => {
		const original = note(['1. step', '   ```tikz', '   \\draw (0,0);', '   ```', '2. step', '']);
		const finalized = finalizeBlock(original, only(findTikzBlocks(original)), 'd.svg');

		expect(unfinalizeBlock(finalized, only(findTikzBlocks(finalized)))).toBe(original);
	});

	it('leaves the note alone when the span is not finalized', () => {
		const text = note(['```tikz', '\\draw (0,0);', '```', '']);
		expect(unfinalizeBlock(text, only(findTikzBlocks(text)))).toBe(text);
	});

	it('refuses a span that claims to be finalized but is not', () => {
		const text = note(['```tikz', '\\draw (0,0);', '```', '']);
		const lying = { ...only(findTikzBlocks(text)), finalized: true };

		expect(() => unfinalizeBlock(text, lying)).toThrow();
	});
});

describe('several blocks in one note', () => {
	const original = note([
		'# Two diagrams',
		'',
		'```tikz',
		'\\draw (0,0) -- (1,0);',
		'```',
		'',
		'between',
		'',
		'~~~tikz',
		'\\draw (0,0) -- (0,1);',
		'~~~',
		'',
		'end',
		'',
	]);

	it('finalizing the second leaves the first byte for byte where it was', () => {
		const blocks = findTikzBlocks(original);
		expect(blocks).toHaveLength(2);

		const out = finalizeBlock(original, blocks[1] as TikzBlockSpan, 'second.svg');

		// Everything up to the second block is untouched, which is the property that lets a caller
		// walk the array back-to-front without re-scanning.
		expect(out.slice(0, (blocks[1] as TikzBlockSpan).start)).toBe(original.slice(0, (blocks[1] as TikzBlockSpan).start));
		expect(out).toContain('```tikz\n\\draw (0,0) -- (1,0);\n```');
		expect(out).toContain('![[second.svg]]');
	});

	it('finalizes both back-to-front and un-finalizes back to the original', () => {
		let text = original;
		const blocks = findTikzBlocks(text);
		for (let i = blocks.length - 1; i >= 0; i--) {
			text = finalizeBlock(text, blocks[i] as TikzBlockSpan, `d${i}.svg`);
		}

		const finalizedSpans = findTikzBlocks(text);
		expect(finalizedSpans.map((s) => s.finalized)).toEqual([true, true]);
		expect(text).toContain('![[d0.svg]]');
		expect(text).toContain('![[d1.svg]]');

		for (let i = finalizedSpans.length - 1; i >= 0; i--) {
			text = unfinalizeBlock(text, finalizedSpans[i] as TikzBlockSpan);
		}
		expect(text).toBe(original);
	});

	it('re-scanning after each edit is equivalent to walking back-to-front', () => {
		let text = original;
		for (;;) {
			const next = findTikzBlocks(text).find((s) => !s.finalized);
			if (!next) break;
			text = finalizeBlock(text, next, 'd.svg');
		}

		expect(findTikzBlocks(text).map((s) => s.finalized)).toEqual([true, true]);
	});
});

describe('CRLF', () => {
	const crlf = note(['# Note', '', '```tikz', '\\draw (0,0) -- (1,1);', '```', '', 'tail', ''], '\r\n');

	it('keeps offsets exact and carries the terminators into the source', () => {
		const span = only(findTikzBlocks(crlf));

		expect(sliceOf(crlf, span)).toBe('```tikz\r\n\\draw (0,0) -- (1,1);\r\n```');
		expect(span.source).toBe('\\draw (0,0) -- (1,1);\r\n');
	});

	it('writes CRLF into the region it inserts and round-trips byte for byte', () => {
		const finalized = finalizeBlock(crlf, only(findTikzBlocks(crlf)), 'd.svg');

		expect(finalized).toBe(
			note(['# Note', '', '![[d.svg]]', '%%', '```tikz', '\\draw (0,0) -- (1,1);', '```', '%%', '', 'tail', ''], '\r\n'),
		);
		expect(unfinalizeBlock(finalized, only(findTikzBlocks(finalized)))).toBe(crlf);
	});

	it('follows the block being edited when a note mixes endings', () => {
		// A synced vault or a `core.autocrlf` checkout produces exactly this: LF prose around a
		// CRLF block, or the reverse. Splicing the note-wide majority would leave a stray \r or a
		// lone \n in the middle of the region.
		const mixed = '# Note\n\n```tikz\r\n\\draw (0,0);\r\n```\n\ntail\n';
		const out = finalizeBlock(mixed, only(findTikzBlocks(mixed)), 'd.svg');

		expect(out).toContain('![[d.svg]]\r\n%%\r\n```tikz');
		expect(unfinalizeBlock(out, only(findTikzBlocks(out)))).toBe(mixed);
	});
});

// -------------------------------------------------------------------------------------------

describe('documented divergences', () => {
	it('does not report a fence inside a blockquote', () => {
		// Deliberate, and worth pinning: recognising `> ```tikz` means reproducing lazy
		// continuation to know where the quote ends, and a wrong answer writes the embed OUTSIDE
		// the quote it belongs to. Finding nothing is the safe failure; if this ever starts
		// returning a span, the offsets have to be proven against the quote first.
		const text = note(['> ```tikz', '> \draw (0,0);', '> ```', '']);
		expect(findTikzBlocks(text)).toEqual([]);
	});
});

describe('round trip over generated notes', () => {
	// The scanner's hard cases are combinations, not single lines: a comment that opens just
	// before a fence, a fence that closes on the line a comment wanted, a CRLF note with no
	// trailing newline. Enumerating them by hand misses the one nobody thought of, so the
	// requirement is asserted directly over a generated corpus: finalize every block, re-scan,
	// un-finalize every block, get the original bytes back.
	const VOCAB = [
		'prose',
		'',
		'# heading',
		'%%',
		'%% note to self',
		'![[a.svg]]',
		'![[b.svg|300]]',
		'```tikz',
		'```',
		'````tikz',
		'````',
		'~~~tikz',
		'~~~',
		'```js',
		'  ```tikz',
		'  ```',
		'\draw (0,0);',
		'\node {```};',
		'> ```tikz',
		'- item',
		'%%  ',
	];

	/** A seeded LCG: the corpus has to be the same on every machine and every run. */
	function lcg(seed: number): () => number {
		let s = seed >>> 0;
		return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
	}

	it('finalizing every block and un-finalizing every block is the identity', () => {
		const rand = lcg(20240607);
		let exercised = 0;

		for (let n = 0; n < 3000; n++) {
			const lineCount = 1 + Math.floor(rand() * 12);
			const lines: string[] = [];
			for (let k = 0; k < lineCount; k++) lines.push(VOCAB[Math.floor(rand() * VOCAB.length)] as string);
			const eol = rand() < 0.25 ? '\r\n' : '\n';
			const original = lines.join(eol) + (rand() < 0.5 ? eol : '');

			const blocks = findTikzBlocks(original);
			if (blocks.length === 0 || blocks.some((s) => s.finalized)) continue;

			let text = original;
			let refused = false;
			for (let i = blocks.length - 1; i >= 0; i--) {
				try {
					text = finalizeBlock(text, blocks[i] as TikzBlockSpan, `d${i}.svg`);
				} catch {
					refused = true; // An unterminated fence is refused by design.
					break;
				}
			}
			if (refused) continue;

			const finalizedSpans = findTikzBlocks(text);
			expect(finalizedSpans.map((s) => s.finalized), JSON.stringify(original)).toEqual(blocks.map(() => true));

			for (let i = finalizedSpans.length - 1; i >= 0; i--) {
				text = unfinalizeBlock(text, finalizedSpans[i] as TikzBlockSpan);
			}
			expect(text, JSON.stringify(original)).toBe(original);
			exercised++;
		}

		// Guard against the corpus silently degenerating to notes with no blocks in them.
		expect(exercised).toBeGreaterThan(200);
	});

	it('reports spans that are ordered, non-overlapping and inside the note', () => {
		const rand = lcg(31337);
		for (let n = 0; n < 3000; n++) {
			const lineCount = 1 + Math.floor(rand() * 12);
			const lines: string[] = [];
			for (let k = 0; k < lineCount; k++) lines.push(VOCAB[Math.floor(rand() * VOCAB.length)] as string);
			const text = lines.join(rand() < 0.25 ? '\r\n' : '\n');

			let prevEnd = 0;
			for (const span of findTikzBlocks(text)) {
				expect(span.start, JSON.stringify(text)).toBeGreaterThanOrEqual(prevEnd);
				expect(span.start).toBeLessThan(span.end);
				expect(span.end).toBeLessThanOrEqual(text.length);
				prevEnd = span.end;
			}
		}
	});
});
