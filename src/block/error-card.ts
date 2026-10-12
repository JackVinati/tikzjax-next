import { Notice } from 'obsidian';
import type { Diagnostic } from '../types';
import type { PreambleLine } from '../preamble/resolve';

/**
 * What a failed diagram looks like. See internal/DESIGN.md §7.6.
 *
 * Today a failure is `<img src='//invalid.site/img-not-found.png'>` — a broken-image icon, plus an
 * outbound DNS lookup and HTTP request from a plugin whose headline feature is offline operation.
 * Upstream #81 asks for error reporting; a third of the tracker is untriageable without it, because
 * reporters cannot tell a bad diagram from a broken plugin.
 *
 * Built with DOM calls, never innerHTML: the community-store guidelines forbid the assignment, and
 * the content here includes a TeX transcript, which is user-influenced text.
 */

export interface ErrorCardOptions {
	diagnostic: Diagnostic;
	/** The block's own source, so the offending line can be shown in context. */
	source: string;
	/**
	 * What TeX was given ahead of the block — the preamble files, expanded — and where each of its
	 * lines was written (preamble/resolve.ts), for an error TeX met before it reached the block.
	 * The files' text alone, one line to each entry of `lines`: not the `\standaloneconfig` a
	 * `border=` adds after it, which the worker's line holds with the rest of what it writes.
	 */
	preamble?: { text: string; lines: readonly PreambleLine[] } | undefined;
	log: string[];
	onRetry?: (() => void) | undefined;
}

/** Where the line an error names is, in what the user wrote. */
type Place =
	| { in: 'block'; line: number; text: string }
	| { in: 'preamble'; path: string | null; line: number; text: string }
	/** The one line the worker writes itself: the block's packages and libraries, \begin{document}. */
	| { in: 'head' }
	/** `\begin{document}` on a line of its own, below a preamble that ends in a newline. */
	| { in: 'begin' };

/**
 * `line` is numbered as the block's own lines are, from 1 — pre-flight numbers them that way, and
 * the host turns TeX's `l.NN` into that (engine/worker-host.ts). Counting on upwards, 0 is the line
 * just above the block, which is the preamble's last, -1 the one above it, and so on: the worker
 * writes the preamble's lines immediately before the block, and everything of its own ahead of them
 * on their first line (engine-src/document.ts). Past the block's last line is the `\end{document}`
 * it was wrapped in, and the last line is the nearest thing the user wrote.
 *
 * The worker's `\begin{document}` goes on the end of the preamble's last line. A preamble that ends
 * in a newline — a saved file usually does — has an empty last line, so there the line is the
 * worker's alone, and an error on it is in something run as the document starts, an
 * `\AtBeginDocument` hook. It used to be shown as that empty line, numbered past the file's end.
 */
function place(line: number, source: string, preamble: ErrorCardOptions['preamble']): Place {
	if (line >= 1) {
		const lines = source.split('\n');
		const index = Math.min(line, lines.length) - 1;
		return { in: 'block', line: index + 1, text: lines[index] ?? '' };
	}

	const text = preamble?.text ?? '';
	if (text === '') return { in: 'head' };
	const lines = text.split('\n');
	const index = lines.length + line - 1;
	if (index < 0) return { in: 'head' };
	if (line === 0 && text.endsWith('\n')) return { in: 'begin' };
	const origin = preamble?.lines[index];
	return {
		in: 'preamble',
		path: origin?.path ?? null,
		line: origin?.line ?? index + 1,
		text: lines[index] ?? '',
	};
}

export function renderErrorCard(container: HTMLElement, options: ErrorCardOptions): void {
	const { diagnostic, source, preamble, log, onRetry } = options;

	container.empty();
	const card = container.createDiv({ cls: 'tikzjax-error' });
	card.setAttribute('role', 'group');
	card.setAttribute('aria-label', 'TikZ error');

	card.createDiv({ cls: 'tikzjax-error-message', text: diagnostic.message });

	if (diagnostic.hint) {
		card.createDiv({ cls: 'tikzjax-error-hint', text: diagnostic.hint });
	}

	// The offending line with a caret, and its text as well as its number: the number alone is easy
	// to misread against a block whose `%!tikz` lines were taken out before TeX saw it. A line in
	// the preamble is shown from the file it was written in, at that file's own line — TeX's number
	// for it counts every preamble file before it, and the block's lines are no help at all.
	if (diagnostic.line !== undefined) {
		const at = place(diagnostic.line, source, preamble);
		if (at.in === 'head') {
			card.createDiv({
				cls: 'tikzjax-error-where',
				text: 'TeX stopped before reaching the diagram, on the line that loads its packages and libraries.',
			});
		} else if (at.in === 'begin') {
			card.createDiv({
				cls: 'tikzjax-error-where',
				text: 'TeX stopped before reaching the diagram, at \\begin{document}: in something a package or the preamble runs as the document starts.',
			});
		} else {
			if (at.in === 'preamble') {
				card.createDiv({
					cls: 'tikzjax-error-where',
					text:
						at.path === null
							? `In the preamble, line ${at.line}`
							: `In the preamble: ${at.path}, line ${at.line}`,
				});
			}
			const block = card.createDiv({ cls: 'tikzjax-error-source' });
			block.createSpan({ text: `${at.line} | ${at.text}\n` });
			block.createSpan({
				cls: 'tikzjax-error-caret',
				text: `${' '.repeat(String(at.line).length + 3)}^`,
			});
		}
	}

	const actions = card.createDiv({ cls: 'tikzjax-error-actions' });

	if (onRetry) {
		const retry = actions.createEl('button', { text: 'Retry' });
		retry.addEventListener('click', onRetry);
	}

	if (log.length) {
		const copy = actions.createEl('button', { text: 'Copy log' });
		copy.addEventListener('click', () => {
			void navigator.clipboard.writeText(log.join('\n')).then(
				() => new Notice('TeX log copied to the clipboard.'),
				() => new Notice('Could not copy the log.'),
			);
		});

		const toggle = actions.createEl('button', { text: 'Show log' });
		const pre = card.createEl('pre', { cls: 'tikzjax-error-log' });
		pre.hidden = true;
		pre.setText(log.join('\n'));
		toggle.addEventListener('click', () => {
			pre.hidden = !pre.hidden;
			toggle.setText(pre.hidden ? 'Show log' : 'Hide log');
		});
	}
}

/**
 * The diagram rendered, but something is worth saying.
 *
 * Three causes, and the third is new: a pipeline stage was skipped, the sanitizer removed active
 * content, or TeX reported an error and recovered. That last case only exists because we inject
 * \nonstopmode — before that, an error meant no output at all. A diagram that renders with a piece
 * silently missing is exactly the failure a user cannot diagnose alone.
 */
export function renderWarningChip(container: HTMLElement, message: string): void {
	const chip = container.createDiv({ cls: 'tikzjax-warning-chip', text: message });
	chip.setAttribute('title', message);
}
