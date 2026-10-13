import type { MarkdownSectionInformation } from 'obsidian';

/**
 * A `tikz` block where people put one — in a list item, a blockquote, a callout — and what
 * Obsidian 1.14.4 hands the code-block processor for it in each view.
 *
 * `reading` is the code node's value from the app's own Reading view parser, remark-parse 8 taken
 * out of the 1.14.4 bundle and run over `note` (options `{ commonmark: true, breaks: true }`, as
 * the app sets them): the code element's text is that and a newline, and the processor is handed
 * it less the newline. A PDF export renders the same way.
 *
 * `livePreview` is how Live Preview shows the block:
 *  - `lines`: a code-block widget, which slices the editor's lines between the two fences and
 *    hands them over as they stand, the list's indentation and all (`livePreviewWidget`);
 *  - `reading`: a callout is drawn whole by a widget that renders its text through the Reading
 *    view parser, so the block arrives as `reading`, and getSectionInfo answers null;
 *  - `none`: a fence in a plain blockquote never opens a code block in Live Preview's markdown
 *    mode, so it is shown as quoted text and nothing is rendered.
 */
export interface ObsidianBlock {
	name: string;
	note: string;
	/** Text inside the block's body, unique in the note: where a test puts the cursor. */
	marker: string;
	reading: string;
	livePreview: 'lines' | 'reading' | 'none';
}

export const BLOCKS: readonly ObsidianBlock[] = [
	{
		name: 'a bullet list item',
		note:
			'# Proof\n\n- The square:\n  ```tikz\n  \\begin{tikzpicture}\n' +
			'    \\draw (0,0) rectangle (2,2);\n  \\end{tikzpicture}\n  ```\n- Next step.\n',
		marker: 'rectangle',
		reading: '\\begin{tikzpicture}\n  \\draw (0,0) rectangle (2,2);\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
	{
		// Obsidian indents a list item's continuation with a tab unless told otherwise.
		name: 'a list item indented with tabs',
		note:
			'- The circle:\n\t```tikz\n\t\\begin{tikzpicture}\n\t\t\\draw (0,0) circle (1);\n' +
			'\t\\end{tikzpicture}\n\t```\n- Next.\n',
		marker: 'circle (1)',
		reading: '\\begin{tikzpicture}\n\t\\draw (0,0) circle (1);\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
	{
		name: 'a numbered list item',
		note:
			'1. First.\n2. Then the axis:\n   ```tikz\n   %!tikz border=2pt\n   \\begin{tikzpicture}\n' +
			'     \\draw[->] (0,0) -- (3,0);\n   \\end{tikzpicture}\n   ```\n3. Last.\n',
		marker: '(3,0)',
		reading: '%!tikz border=2pt\n\\begin{tikzpicture}\n  \\draw[->] (0,0) -- (3,0);\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
	{
		name: 'a list item nested two deep',
		note:
			'- Outer\n  - Inner:\n    ```tikz\n    \\begin{tikzpicture}\n      \\node[draw] {A};\n' +
			'    \\end{tikzpicture}\n    ```\n  - Sibling\n',
		marker: '{A}',
		reading: '\\begin{tikzpicture}\n  \\node[draw] {A};\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
	{
		name: "a fence on its list item's marker line",
		note:
			'1. ```tikz\n   \\begin{tikzpicture}\n     \\draw (0,0) -- (1,1);\n   \\end{tikzpicture}\n' +
			'   ```\n2. After.\n',
		marker: '(1,1)',
		reading: '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
	{
		// Both views take the checkbox off before they look for a fence, and the lines below lose
		// the item's two columns only.
		name: "a fence on a task item's marker line",
		note:
			'- [ ] ```tikz\n  \\begin{tikzpicture}\n    \\draw (0,0) -- (1,0);\n  \\end{tikzpicture}\n' +
			'  ```\n- [x] Done.\n',
		marker: '(1,0)',
		reading: '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,0);\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
	{
		name: 'a blockquote',
		note:
			'> A quoted diagram:\n>\n> ```tikz\n> \\begin{tikzpicture}\n' +
			'>   \\draw (0,0) -- (1,0) -- (0,1) -- cycle;\n> \\end{tikzpicture}\n> ```\n',
		marker: '(0,1)',
		reading: '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,0) -- (0,1) -- cycle;\n\\end{tikzpicture}',
		livePreview: 'none',
	},
	{
		name: 'a callout',
		note:
			'> [!example] A triangle\n> ```tikz\n> \\begin{tikzpicture}\n' +
			'>   \\draw (0,0) -- (2,0) -- (1,1.5) -- cycle;\n> \\end{tikzpicture}\n> ```\n\nAfter.\n',
		marker: '(1,1.5)',
		reading: '\\begin{tikzpicture}\n  \\draw (0,0) -- (2,0) -- (1,1.5) -- cycle;\n\\end{tikzpicture}',
		livePreview: 'reading',
	},
	{
		name: 'the top level of the note',
		note: 'Text.\n\n```tikz\n\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n```\n',
		marker: '\\draw',
		reading: '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}',
		livePreview: 'lines',
	},
];

/**
 * What Live Preview's code-block widget hands the processor for the first `tikz` fence in `note`,
 * and what its getSectionInfo answers (both read in the 1.14.4 bundle): the editor's text from the
 * start of the line after the opening fence to the end of the line before the closing one, and
 * the whole document with the two fence lines, 0-based.
 */
export function livePreviewWidget(note: string): { source: string; section: MarkdownSectionInformation } {
	const lines = note.split('\n');
	const open = lines.findIndex((line) => line.includes('```tikz'));
	let close = open + 1;
	while (close < lines.length && !/^[ \t]*```[ \t]*$/.test(lines[close] ?? '')) close++;
	return {
		source: lines.slice(open + 1, close).join('\n'),
		section: { text: note, lineStart: open, lineEnd: close },
	};
}
