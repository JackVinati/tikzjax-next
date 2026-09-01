import type { TFile } from 'obsidian';
import { MarkdownView, Notice, type App, type Editor, type Plugin } from 'obsidian';
import { findTikzBlocks, finalizeBlock, unfinalizeBlock, type TikzBlockSpan } from '../note/finalize';
import { freezeSvg } from '../svg/freeze';
import { ZoomModal } from './zoom';
import { STRINGS } from '../ui/strings';

/**
 * Commands. Upstream #21, #33, #95, #97, #104.
 *
 * "Get the diagram out" is the most-asked-for thing on the tracker after rendering itself, and it
 * is also the only answer to Obsidian Publish (#37, #47), which runs no community plugins at all —
 * a committed attachment is the one thing a visitor can ever see.
 */

export interface CommandDeps {
	app: App;
	/** The finished markup for a block's source, or null if it has not been rendered yet. */
	markupFor(source: string, notePath: string): Promise<string | null>;
	/** Render every block in a note and resolve once they have all settled. */
	warmNote(file: TFile): Promise<{ ok: number; failed: number }>;
	fontCss(): string;
	openDebugView(): Promise<void>;
}

/** Ink and paper for an exported file: always black on white, whatever the app theme is. */
const EXPORT_INK = '#000000';
const EXPORT_PAPER = '#ffffff';

export function registerCommands(plugin: Plugin, deps: CommandDeps): void {
	const { app } = deps;

	const blockAtCursor = (editor: Editor): TikzBlockSpan | null => {
		const text = editor.getValue();
		const offset = editor.posToOffset(editor.getCursor());
		return findTikzBlocks(text).find((b) => offset >= b.start && offset <= b.end) ?? null;
	};

	const frozenFor = async (
		span: TikzBlockSpan,
		notePath: string,
		opaque: boolean,
	): Promise<string | null> => {
		const markup = await deps.markupFor(span.source, notePath);
		if (markup === null) return null;
		return freezeSvg(markup, {
			ink: EXPORT_INK,
			paper: EXPORT_PAPER,
			opaque,
			fontCss: deps.fontCss(),
		});
	};

	plugin.addCommand({
		id: 'copy-svg',
		name: 'Copy the diagram at the cursor as SVG',
		editorCallback: (editor, view) => {
			void (async () => {
				const span = blockAtCursor(editor);
				if (!span) return void new Notice('The cursor is not inside a TikZ block.');
				const svg = await frozenFor(span, view.file?.path ?? '', false);
				if (svg === null) return void new Notice('That diagram has not been rendered yet.');
				await navigator.clipboard.writeText(svg);
				new Notice('Diagram copied as SVG.');
			})();
		},
	});

	plugin.addCommand({
		id: 'save-svg',
		name: 'Save the diagram at the cursor as an SVG file',
		editorCallback: (editor, view) => {
			void (async () => {
				const file = view.file;
				const span = blockAtCursor(editor);
				if (!span || !file) return void new Notice('The cursor is not inside a TikZ block.');

				const svg = await frozenFor(span, file.path, true);
				if (svg === null) return void new Notice('That diagram has not been rendered yet.');

				const path = await app.fileManager.getAvailablePathForAttachment(
					`${file.basename}-diagram.svg`,
					file.path,
				);
				await app.vault.create(path, svg);
				new Notice(`Saved ${path}`);
			})();
		},
	});

	plugin.addCommand({
		id: 'finalize-note',
		name: 'Finalize the diagrams in this note',
		editorCallback: (_editor, view) => {
			void (async () => {
				const file = view.file;
				if (!file) return;
				await finalizeNote(app, file, deps);
			})();
		},
	});

	plugin.addCommand({
		id: 'unfinalize-note',
		name: 'Un-finalize the diagrams in this note',
		editorCallback: (_editor, view) => {
			void (async () => {
				const file = view.file;
				if (!file) return;
				let count = 0;
				await app.vault.process(file, (text) => {
					// Back to front, so an earlier rewrite cannot invalidate a later span's offsets.
					const spans = findTikzBlocks(text).filter((b) => b.finalized);
					count = spans.length;
					let out = text;
					for (const span of spans.reverse()) out = unfinalizeBlock(out, span);
					return out;
				});
				new Notice(count ? `Restored ${count} diagram source(s).` : 'Nothing to un-finalize here.');
			})();
		},
	});

	plugin.addCommand({
		id: 'render-note',
		name: 'Render all diagrams in this note',
		callback: () => {
			void (async () => {
				const file = app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return void new Notice('No note is open.');
				const notice = new Notice('Rendering diagrams…', 0);
				try {
					const { ok, failed } = await deps.warmNote(file);
					notice.hide();
					new Notice(failed ? `Rendered ${ok}, ${failed} failed.` : `Rendered ${ok} diagram(s).`);
				} catch (error) {
					notice.hide();
					new Notice(`Rendering failed: ${String(error)}`);
				}
			})();
		},
	});

	plugin.addCommand({
		id: 'zoom-diagram',
		name: 'Open the diagram at the cursor in a zoom view',
		editorCallback: (editor, view) => {
			void (async () => {
				const span = blockAtCursor(editor);
				if (!span) return void new Notice('The cursor is not inside a TikZ block.');
				const markup = await deps.markupFor(span.source, view.file?.path ?? '');
				if (markup === null) return void new Notice('That diagram has not been rendered yet.');
				new ZoomModal(app, markup).open();
			})();
		},
	});

	plugin.addCommand({
		id: 'open-diagnostics',
		name: 'Open TikZ diagnostics',
		callback: () => void deps.openDebugView(),
	});
}

/**
 * Finalize every block in a note: render it, write the attachment, rewrite the note.
 *
 * Note-at-a-time and never automatic. It writes attachments AND rewrites the note body, so running
 * it on two devices at once produces a Sync conflict on the note; and it is undoable precisely
 * because the original fence is preserved verbatim rather than regenerated.
 */
async function finalizeNote(app: App, file: TFile, deps: CommandDeps): Promise<void> {
	const text = await app.vault.read(file);
	const spans = findTikzBlocks(text).filter((b) => !b.finalized);

	if (spans.length === 0) {
		new Notice('No diagrams to finalize in this note.');
		return;
	}

	const notice = new Notice(`Finalizing ${spans.length} diagram(s)…`, 0);
	const written: { span: TikzBlockSpan; name: string }[] = [];

	try {
		for (const span of spans) {
			const markup = await deps.markupFor(span.source, file.path);
			if (markup === null) continue;

			const svg = freezeSvg(markup, {
				ink: EXPORT_INK,
				paper: EXPORT_PAPER,
				opaque: true,
				fontCss: deps.fontCss(),
			});

			const path = await app.fileManager.getAvailablePathForAttachment(
				`${file.basename}-diagram.svg`,
				file.path,
			);
			await app.vault.create(path, svg);
			written.push({ span, name: path.split('/').pop() ?? path });
		}

		if (written.length > 0) {
			await app.vault.process(file, (current) => {
				// Re-scan against the CURRENT text rather than trusting offsets taken before the
				// attachments were written, then rewrite back to front.
				const fresh = findTikzBlocks(current).filter((b) => !b.finalized);
				let out = current;
				for (let i = Math.min(fresh.length, written.length) - 1; i >= 0; i--) {
					const span = fresh[i];
					const entry = written[i];
					if (span && entry) out = finalizeBlock(out, span, entry.name);
				}
				return out;
			});
		}

		notice.hide();
		new Notice(
			written.length === spans.length
				? `Finalized ${written.length} diagram(s).`
				: `Finalized ${written.length} of ${spans.length}; the rest have not been rendered yet.`,
		);
	} catch (error) {
		notice.hide();
		new Notice(`Finalize failed: ${String(error)}`);
	}
}

export { STRINGS };
