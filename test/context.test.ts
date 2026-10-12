// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { installObsidianDom } from './stubs/obsidian-dom';
import { isExportContext } from '../src/platform/context';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/** A workspace whose leaves live in the main document and in each of `windows`. */
function app(windows: Document[], opts: { throws?: boolean } = {}): App {
	const leaves = [document, ...windows].map((doc) => ({ getContainer: () => ({ doc }) }));
	return {
		workspace: {
			containerEl: document.body,
			iterateAllLeaves: (callback: (leaf: unknown) => void) => {
				if (opts.throws) throw new Error('the workspace is not ready');
				for (const leaf of leaves) callback(leaf);
			},
		},
	} as unknown as App;
}

const blockIn = (doc: Document): HTMLElement => doc.body.appendChild(doc.createElement('div'));

describe('isExportContext', () => {
	it('is an export inside the .print container a PDF export renders into', () => {
		const print = document.body.appendChild(document.createElement('div'));
		print.className = 'print';
		expect(isExportContext(app([]), print.appendChild(document.createElement('div')))).toBe(true);
	});

	it('is not an export in the main window', () => {
		expect(isExportContext(app([]), blockIn(document))).toBe(false);
	});

	/**
	 * Any document other than the main one used to count as an export, and a pop-out window is
	 * one: every block in it rendered at once at the export band, under the export's time limit,
	 * past the session's record of diagrams that timed out — for as long as the window was open.
	 */
	it('is not an export in a pop-out window, which is the workspace’s own', () => {
		const popout = document.implementation.createHTMLDocument('pop-out');
		expect(isExportContext(app([popout]), blockIn(popout))).toBe(false);
	});

	it('fails open in a document the workspace does not know, such as the export popup', () => {
		const popup = document.implementation.createHTMLDocument('print');
		expect(isExportContext(app([]), blockIn(popup))).toBe(true);
	});

	it('fails open when the workspace cannot be asked', () => {
		const popout = document.implementation.createHTMLDocument('pop-out');
		expect(isExportContext(app([popout], { throws: true }), blockIn(popout))).toBe(true);
	});
});
