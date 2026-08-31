import type { App } from 'obsidian';

/**
 * Telling apart the contexts a code block can be rendered in. See docs/DESIGN.md §7.9.
 *
 * Export is the one that matters. Verified in the Obsidian 1.13.7 bundle: `printToPdf` opens
 * `window.open("about:blank", "_blank", "popup,hide=true")` — NOT a WorkspaceWindow, so
 * `workspace.on('window-open')` never fires for it — clones every <style> and <link> from the main
 * head but NOT <script>, forces `theme-light`, renders into `div.print`, then awaits
 * `Promise.all(ctx.promises)` and a hard-coded 200 ms sleep before sending print-to-pdf.
 *
 * The shipped plugin's processor returns void, so that 200 ms is the only wait there is. PDFs
 * therefore contain whichever diagrams happened to be cached already, which is exactly why #45's
 * reporters describe "the first 3 or 4 export" and why clearing the cache makes it worse.
 */

/**
 * Fails OPEN: an unrecognised context is treated as an export and rendered eagerly.
 *
 * Deliberately not `el.doc !== activeDocument`. `activeDocument` follows focus, so a pop-out window
 * in the background would be misclassified as an export. Failing open costs a little extra
 * compilation; failing closed costs blank PDFs.
 *
 * Takes `app` as a parameter because Obsidian's guidelines and eslint-plugin-obsidianmd both
 * forbid the global `app`.
 */
export function isExportContext(app: App, el: HTMLElement): boolean {
	if (el.closest('.print')) return true;
	try {
		return el.doc !== app.workspace.containerEl.doc;
	} catch {
		return true;
	}
}

/**
 * Documents we have already injected the cold font faces into.
 *
 * A WeakMap so a closed pop-out or a finished export popup is not kept alive by our bookkeeping.
 */
const fontedDocuments = new WeakSet<Document>();

/**
 * Inject the cold TeX faces into a document, once.
 *
 * Called from MOUNT, not from render. The distinction is load-bearing: a cache hit mounts without
 * rendering at all, and a PDF export mounts cached diagrams almost exclusively — so keying this on
 * "first render" would ship PDFs with fallback glyphs, which is a wrong diagram rather than an
 * ugly one.
 */
export function ensureFonts(doc: Document, css: string): void {
	if (!css || fontedDocuments.has(doc)) return;
	fontedDocuments.add(doc);
	const style = doc.createElement('style');
	style.id = 'tikzjax-fonts';
	style.textContent = css;
	(doc.head ?? doc.documentElement).appendChild(style);
}

/** Undo ensureFonts across every document we touched. Called on plugin unload. */
export function removeFonts(docs: Iterable<Document>): void {
	for (const doc of docs) {
		doc.getElementById('tikzjax-fonts')?.remove();
		fontedDocuments.delete(doc);
	}
}
