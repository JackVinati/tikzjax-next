// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Command, Editor, MarkdownPostProcessorContext, MarkdownView, Plugin } from 'obsidian';
import { installObsidianDom } from './stubs/obsidian-dom';
import { shownNotices, TFile } from './stubs/obsidian';
import { fakeApp } from './stubs/vault';
import { asProcessorSource, findTikzBlocks, type TikzBlockSpan } from '../src/note/finalize';
import { createProcessor, renderedMarkup, type ProcessorDeps } from '../src/block/processor';
import type { TexJobSpec } from '../src/block/render-child';
import { PreambleService } from '../src/preamble/vault';
import { budgetsFor } from '../src/platform/budgets';
import { DEFAULT_SETTINGS } from '../src/settings/schema';
import { registerCommands } from '../src/ui/commands';
import type { Artifact, EngineCapabilities, TexHost } from '../src/types';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/**
 * Copy SVG, Save SVG, Finalize and the zoom view find a diagram by scanning the note's markdown,
 * and the scan does not see the text the processor saw. These tests run a real note through both
 * sides: Obsidian's convention for what a code-block processor is handed, and findTikzBlocks.
 */

// -------------------------------------------------------------------------------------------
// Obsidian's side, as read in the 1.14.4 bundle

/** The body lines between the fences, from an LF note: what both views start from. */
function bodyLines(note: string, span: TikzBlockSpan): string[] {
	const lines = note.slice(span.start, span.end).split('\r\n').join('\n').split('\n');
	return lines.slice(1, -1);
}

/** Reading view: the code element's text, every line terminated, minus ONE trailing "\n" (`Nj`). */
function readingView(note: string, span: TikzBlockSpan): string {
	const text = bodyLines(note, span)
		.map((line) => `${line}\n`)
		.join('');
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Live Preview: `sliceString(line(open + 1).from, line(close - 1).to)` over the editor's LF text. */
function livePreview(note: string, span: TikzBlockSpan): string {
	return bodyLines(note, span).join('\n');
}

// -------------------------------------------------------------------------------------------

const CAPS: EngineCapabilities = { expl3: true, twoPass: false, packages: {}, files: new Set() };

const host: TexHost = {
	id: 'test-engine',
	capabilities: CAPS,
	ready: () => Promise.resolve(),
	render: () => new Promise(() => undefined),
	dispose: () => undefined,
};

function artifact(over: Partial<Artifact> = {}): Artifact {
	return {
		v: 1,
		template:
			'<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt" viewBox="-72 -72 100 50">' +
			'<clipPath id="__TZ__0"><rect width="10" height="10"/></clipPath>' +
			'<g clip-path="url(#__TZ__0)"><rect width="20" height="20"/></g></svg>',
		w: 40,
		h: 20,
		viewBox: '0 0 40 20',
		fonts: [],
		bytes: 200,
		engineId: 'test-engine',
		origin: 'render',
		createdAt: 0,
		lastUsed: 0,
		...over,
	};
}

/** L1 and L2 as two maps, so a test can put an artifact in either. */
function tieredCache() {
	const l1 = new Map<string, Artifact>();
	const l2 = new Map<string, Artifact>();
	const cache = {
		peek: (key: string) => l1.get(key),
		peekSize: () => undefined,
		lookup: (key: string, legacy: string | null) => {
			// The commands must never be handed an L3 record: it has not been through the pipeline.
			expect(legacy).toBeNull();
			const hot = l1.get(key);
			if (hot) return Promise.resolve({ artifact: hot, tier: 'l1' as const });
			const stored = l2.get(key);
			if (!stored) return Promise.resolve(undefined);
			l1.set(key, stored);
			return Promise.resolve({ artifact: stored, tier: 'l2' as const });
		},
		put: (key: string, a: Artifact) => void l1.set(key, a),
	};
	return { l1, l2, cache: cache as unknown as ProcessorDeps['cache'] };
}

function processorDeps(app = fakeApp()) {
	const { l1, l2, cache } = tieredCache();
	const seen: TexJobSpec[] = [];
	const deps: ProcessorDeps = {
		app,
		settings: { ...DEFAULT_SETTINGS },
		budgets: budgetsFor(false),
		cache,
		queue: { submit: () => new Promise(() => undefined), release: () => undefined } as never,
		host,
		svgo: null,
		observe: () => undefined,
		unobserve: () => undefined,
		ensureFonts: () => undefined,
		now: () => 0,
		preamble: new PreambleService(app, (text) => String(text.length)),
		onBlock: (spec) => void seen.push(spec),
	};
	return { deps, seen, l1, l2 };
}

/** Run the real processor over what Obsidian would hand it, and return the key it derived. */
async function processedKey(deps: ProcessorDeps, seen: TexJobSpec[], source: string, path: string) {
	const el = document.body.createDiv();
	const ctx = { sourcePath: path, addChild: () => undefined } as unknown as MarkdownPostProcessorContext;
	void createProcessor(deps)(source, el, ctx);
	// The processor goes async only to resolve a preamble; give it the turns that takes.
	for (let i = 0; i < 10 && seen.length === 0; i++) await Promise.resolve();
	const spec = seen.pop();
	if (!spec) throw new Error('the processor never produced a spec');
	return spec.key;
}

const only = (spans: TikzBlockSpan[]): TikzBlockSpan => {
	expect(spans).toHaveLength(1);
	const span = spans[0];
	if (!span) throw new Error('unreachable');
	return span;
};

// -------------------------------------------------------------------------------------------

describe('the scanner and the processor', () => {
	it('see different text, and asProcessorSource is the difference', () => {
		// The bug in one line: the map the commands looked in was keyed on the processor's text,
		// and they looked up the scanner's, so every lookup missed.
		const note = '# Title\n\n```tikz\n\\draw (0,0) -- (1,1);\n```\n\nAfter.\n';
		const span = only(findTikzBlocks(note));

		expect(span.source).not.toBe(readingView(note, span));
		expect(asProcessorSource(span.source)).toBe(readingView(note, span));
		expect(asProcessorSource(span.source)).toBe(livePreview(note, span));
	});

	it('agree on a body that ends in a blank line: only one terminator goes', () => {
		const note = '```tikz\n\\draw (0,0);\n\n```\n';
		const span = only(findTikzBlocks(note));
		expect(asProcessorSource(span.source)).toBe('\\draw (0,0);\n');
		expect(asProcessorSource(span.source)).toBe(readingView(note, span));
		expect(asProcessorSource(span.source)).toBe(livePreview(note, span));
	});

	it('agree on a note saved with CRLF line endings, which the editor never shows the processor', () => {
		const note = 'Text\r\n\r\n```tikz\r\n%!tikz border=2pt\r\n\\draw (0,0);\r\n```\r\n';
		const span = only(findTikzBlocks(note));
		expect(asProcessorSource(span.source)).toBe('%!tikz border=2pt\n\\draw (0,0);');
	});
});

describe('renderedMarkup', () => {
	const NOTES: ReadonlyArray<readonly [string, string]> = [
		['a plain block', '# Title\n\n```tikz\n\\draw (0,0) -- (1,1);\n```\n\nAfter.\n'],
		['a block with directives', '```tikz\n%!tikz border=2pt scale=2\n\\draw (0,0) circle (1);\n```\n'],
		['a CRLF note with a baked directive', '```tikz\r\n%!tikz border=3pt\r\n\\draw (0,0);\r\n```\r\n'],
		['a block that ends in a blank line', 'Text\n```tikz\n\\draw (0,0);\n\n```\n'],
	];

	for (const [name, note] of NOTES) {
		it(`finds ${name} the processor rendered`, async () => {
			const { deps, seen, l1 } = processorDeps();
			const span = only(findTikzBlocks(note));
			const key = await processedKey(deps, seen, readingView(note, span), 'note.md');
			l1.set(key, artifact());

			await expect(renderedMarkup(span.source, 'note.md', deps)).resolves.not.toBeNull();
		});
	}

	it('finds it through a preamble the note walks up to', async () => {
		const app = fakeApp({ 'tikz-preamble.tex': '\\usetikzlibrary{arrows}' });
		const { deps, seen, l1 } = processorDeps(app);
		const note = '```tikz\n\\draw[->] (0,0) -- (1,0);\n```\n';
		const span = only(findTikzBlocks(note));
		const key = await processedKey(deps, seen, livePreview(note, span), 'note.md');
		l1.set(key, artifact());

		await expect(renderedMarkup(span.source, 'note.md', deps)).resolves.not.toBeNull();
	});

	it('reads L2 when memory has nothing, as after a restart or the phone being backgrounded', async () => {
		const { deps, seen, l2 } = processorDeps();
		const note = '```tikz\n\\draw (0,0);\n```\n';
		const span = only(findTikzBlocks(note));
		const key = await processedKey(deps, seen, readingView(note, span), 'note.md');
		l2.set(key, artifact());

		await expect(renderedMarkup(span.source, 'note.md', deps)).resolves.not.toBeNull();
	});

	it('says null for a diagram rendered nowhere on this device', async () => {
		const { deps } = processorDeps();
		await expect(renderedMarkup('\\draw (0,0);\n', 'note.md', deps)).resolves.toBeNull();
	});

	it('hands out ids of its own and the measured frame, not the stored template', async () => {
		const { deps, seen, l1 } = processorDeps();
		const note = '```tikz\n\\draw (0,0);\n```\n';
		const span = only(findTikzBlocks(note));
		l1.set(await processedKey(deps, seen, readingView(note, span), 'note.md'), artifact());

		const markup = (await renderedMarkup(span.source, 'note.md', deps)) ?? '';
		expect(markup).not.toContain('__TZ__');
		const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
		const id = svg.querySelector('clipPath')?.getAttribute('id') ?? '';
		expect(id).not.toBe('');
		expect(svg.querySelector('g')?.getAttribute('clip-path')).toBe(`url(#${id})`);
		// The engine's frame is an inch short; the stored measurement is what the reader saw.
		expect(svg.getAttribute('viewBox')).toBe('0 0 40 20');
		expect(svg.getAttribute('width')).toBe('40pt');
	});

	it('gives two takes of the same diagram different ids, so two copies on one page cannot collide', async () => {
		const { deps, seen, l1 } = processorDeps();
		const note = '```tikz\n\\draw (0,0);\n```\n';
		const span = only(findTikzBlocks(note));
		l1.set(await processedKey(deps, seen, readingView(note, span), 'note.md'), artifact());

		const first = await renderedMarkup(span.source, 'note.md', deps);
		const second = await renderedMarkup(span.source, 'note.md', deps);
		expect(first).not.toBe(second);
	});
});

// -------------------------------------------------------------------------------------------
// The commands, end to end: a note, the processor's render, and the command at the cursor

/** A note, its rendered blocks in the cache, and the commands registered against both. */
function workspace(note: string) {
	const { deps, seen, l1 } = processorDeps();
	const file = new TFile('folder/note.md');
	const vault = new Map<string, string>([[file.path, note]]);
	const created: string[] = [];
	const app = {
		...deps.app,
		vault: {
			read: () => Promise.resolve(vault.get(file.path) ?? ''),
			create: (path: string, data: string) => {
				created.push(path);
				vault.set(path, data);
				return Promise.resolve(new TFile(path));
			},
			process: (_file: TFile, fn: (text: string) => string) => {
				const next = fn(vault.get(file.path) ?? '');
				vault.set(file.path, next);
				return Promise.resolve(next);
			},
		},
		fileManager: {
			getAvailablePathForAttachment: (name: string) => {
				const dot = name.lastIndexOf('.');
				let path = `folder/${name}`;
				for (let n = 1; vault.has(path); n++)
					path = `folder/${name.slice(0, dot)} ${n}${name.slice(dot)}`;
				return Promise.resolve(path);
			},
		},
	} as unknown as App;

	const commands = new Map<string, Command>();
	const plugin = { addCommand: (c: Command) => void commands.set(c.id, c) } as unknown as Plugin;
	registerCommands(plugin, {
		app,
		// Exactly what main.ts wires.
		markupFor: (source, notePath) => renderedMarkup(source, notePath, deps),
		warmNote: () => Promise.resolve({ ok: 0, failed: 0 }),
		fontCss: () => '',
		openDebugView: () => Promise.resolve(),
	});

	/** Render the block whose body contains `marker`, as a view would have: through the processor. */
	const render = async (marker: string): Promise<void> => {
		const span = findTikzBlocks(vault.get(file.path) ?? '').find((s) => s.source.includes(marker));
		if (!span) throw new Error(`no block containing ${marker}`);
		l1.set(await processedKey(deps, seen, readingView(note, span), file.path), artifact());
	};

	/** Run an editor command with the cursor on the first occurrence of `marker`. */
	const run = (id: string, marker: string): void => {
		const text = vault.get(file.path) ?? '';
		const editor = {
			getValue: () => text,
			getCursor: () => ({ line: 0, ch: 0 }),
			posToOffset: () => text.indexOf(marker),
		} as unknown as Editor;
		const command = commands.get(id);
		if (!command?.editorCallback) throw new Error(`no editor command ${id}`);
		void command.editorCallback(editor, { file } as unknown as MarkdownView);
	};

	return { vault, created, file, render, run };
}

const lastNotice = (): string => String(shownNotices[shownNotices.length - 1]?.message ?? '');

describe('the commands at the cursor', () => {
	const NOTE =
		'# Diagrams\n\n```tikz\n\\draw (0,0) -- (1,1);\n```\n\nAnd another:\n\n```tikz\n\\draw (2,2) circle (1);\n```\n';

	beforeEach(() => {
		shownNotices.length = 0;
	});

	it('Copy SVG copies the diagram on screen', async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const w = workspace(NOTE);
		await w.render('circle');

		w.run('copy-svg', 'circle');
		await vi.waitFor(() => expect(lastNotice()).toBe('Diagram copied as SVG.'));
		const svg = String((writeText.mock.calls[0] as unknown[] | undefined)?.[0] ?? '');
		expect(svg).toContain('<svg');
		expect(svg).not.toContain('__TZ__');
	});

	it('Save SVG writes the diagram next to the note', async () => {
		const w = workspace(NOTE);
		await w.render('circle');

		w.run('save-svg', 'circle');
		await vi.waitFor(() => expect(lastNotice()).toBe('Saved folder/note-diagram.svg'));
		expect(w.vault.get('folder/note-diagram.svg')).toContain('<svg');
	});

	it('says a diagram is not rendered only when it is not', async () => {
		const w = workspace(NOTE);
		await w.render('circle');

		w.run('save-svg', '(1,1)');
		await vi.waitFor(() => expect(lastNotice()).toBe('That diagram has not been rendered yet.'));
		expect(w.created).toEqual([]);
	});

	it('Finalize finalizes every rendered diagram', async () => {
		const w = workspace(NOTE);
		await w.render('(1,1)');
		await w.render('circle');

		w.run('finalize-note', '# Diagrams');
		await vi.waitFor(() => expect(lastNotice()).toBe('Finalized 2 diagram(s).'));
		expect(findTikzBlocks(w.vault.get('folder/note.md') ?? '').every((s) => s.finalized)).toBe(true);
	});
	it('Finalize puts each attachment above its own diagram, and leaves an unrendered one alone', async () => {
		// Attachments used to be paired with blocks by position among the RENDERED ones: with the
		// first diagram unrendered, the second one's picture was embedded above the first.
		const w = workspace(NOTE);
		await w.render('circle');

		w.run('finalize-note', '# Diagrams');
		await vi.waitFor(() =>
			expect(lastNotice()).toBe('Finalized 1 of 2; the rest have not been rendered yet.'),
		);
		const spans = findTikzBlocks(w.vault.get('folder/note.md') ?? '');
		expect(spans.map((s) => [s.finalized, s.source.includes('circle')])).toEqual([
			[false, false],
			[true, true],
		]);
	});
});
