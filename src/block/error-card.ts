import { Notice } from 'obsidian';
import type { Diagnostic } from '../types';

/**
 * What a failed diagram looks like. See docs/DESIGN.md §7.6.
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
	log: string[];
	onRetry?: (() => void) | undefined;
}

export function renderErrorCard(container: HTMLElement, options: ErrorCardOptions): void {
	const { diagnostic, source, log, onRetry } = options;

	container.empty();
	const card = container.createDiv({ cls: 'tikzjax-error' });
	card.setAttribute('role', 'group');
	card.setAttribute('aria-label', 'TikZ error');

	card.createDiv({ cls: 'tikzjax-error-message', text: diagnostic.message });

	if (diagnostic.hint) {
		card.createDiv({ cls: 'tikzjax-error-hint', text: diagnostic.hint });
	}

	// The offending line with a caret. TeX's `l.NN` is 1-based and counts the assembled input,
	// which begins with our preamble on line 1 — so the number is offset by one relative to what
	// the user wrote. Showing the text rather than only the number sidesteps the ambiguity.
	if (diagnostic.line !== undefined) {
		const lines = source.split('\n');
		const index = Math.min(Math.max(diagnostic.line - 2, 0), lines.length - 1);
		const text = lines[index];
		if (text !== undefined) {
			const block = card.createDiv({ cls: 'tikzjax-error-source' });
			block.createSpan({ text: `${index + 1} | ${text}\n` });
			block.createSpan({
				cls: 'tikzjax-error-caret',
				text: `${' '.repeat(String(index + 1).length + 3)}^`,
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
