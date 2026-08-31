import { Plugin } from 'obsidian';
import { COLD_FONT_CSS } from 'virtual:fonts';

import { WorkerHost } from './engine/worker-host';
import { ensureFonts, isExportContext } from './platform/context';
import { budgetsFor } from './platform/budgets';
import { normalizeSource } from './source/normalize';
import { parseSvg, serializeSvg } from './svg/serialize';
import { sanitizeSvg } from './svg/sanitize';
import { remapSoftHyphens } from './svg/entities';
import { placeholderIds, stampIds } from './svg/ids';
import { applyColorModel } from './svg/colors';
import { renderPlaceholder } from './block/placeholder';
import { renderErrorCard, renderWarningChip } from './block/error-card';
import { explain } from './engine/hints';
import { STRINGS } from './ui/strings';
import { DEFAULT_SETTINGS, migrateSettings, type TikzSettings } from './settings/schema';
import { TexError } from './types';

/**
 * SMOKE BUILD.
 *
 * This is deliberately the shortest path from a ```tikz fence to pixels: normalize, compile,
 * sanitize, recolour, insert. There is no cache, no queue, no viewport gating, no state machine
 * and no settings UI — those are written and tested, and get wired in next.
 *
 * It exists to answer the questions that no amount of Node testing can, and that would change the
 * design if any of them answered badly:
 *   - does `new Worker(blob:)` start inside Obsidian's Electron renderer, and inside iOS WKWebView?
 *   - does an 11 MB main.js load in acceptable time?
 *   - do the WOFF2 faces actually resolve, in light and dark, in reading view and live preview?
 *   - does iOS survive a worker holding a 156 MiB core dump?
 *
 * Because it renders every visible block eagerly and serially with no cache, it is also the WORST
 * case for performance. Do not read it as representative of the finished plugin; read it as
 * "does the platform accept this at all".
 */
export default class TikzjaxNextPlugin extends Plugin {
	/**
	 * `override` is not decoration. Obsidian 1.13 added `settings?: unknown` to `Plugin`, and under
	 * `useDefineForClassFields` a plain redeclaration would [[Define]] the field at construction —
	 * a silent runtime break rather than a type error. TypeScript flags the missing modifier, which
	 * is the only warning anyone gets.
	 */
	override settings: TikzSettings = { ...DEFAULT_SETTINGS };

	private host: WorkerHost | null = null;
	private instance = 0;
	private readonly touchedDocuments = new Set<Document>();

	override async onload(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());

		this.host = new WorkerHost();
		// Registered for teardown rather than left to onunload's ordering, per the plugin guidelines.
		this.register(() => this.host?.dispose());

		this.registerMarkdownCodeBlockProcessor('tikz', (source, el) => {
			// Returning the promise is the whole reason PDF export can work: Obsidian pushes every
			// value a code block processor returns into ctx.promises and awaits them before taking
			// the print snapshot. The shipped plugin returns void, so the only wait is a hard-coded
			// 200 ms sleep — which is why exported PDFs contain whichever diagrams happened to be
			// cached already (upstream #45, #114).
			return this.renderBlock(source, el, isExportContext(this.app, el));
		});

		console.log(`TikZJax Next: engine ${this.host.id.slice(0, 12)}`);
	}

	override onunload(): void {
		for (const doc of this.touchedDocuments) doc.getElementById('tikzjax-fonts')?.remove();
		this.touchedDocuments.clear();
	}

	private async renderBlock(source: string, el: HTMLElement, isExport: boolean): Promise<void> {
		el.addClass('tikzjax-figure');
		const wrapper = el.createDiv({ cls: 'tikzjax-figure-wrapper' });
		const placeholder = renderPlaceholder(wrapper, undefined);

		const host = this.host;
		if (!host) return;

		const budgets = budgetsFor(false, navigator.hardwareConcurrency || 4);
		const controller = new AbortController();
		const timeoutMs = isExport ? budgets.exportBlockTimeoutMs : budgets.timeoutMs + budgets.firstJobGraceMs;
		const timer = window.setTimeout(() => controller.abort(), timeoutMs);

		try {
			const normalized = normalizeSource(source);
			if (!normalized.trim()) {
				placeholder.remove();
				renderErrorCard(wrapper, {
					diagnostic: { kind: 'empty-output', message: 'This TikZ block is empty.' },
					source,
					log: [],
				});
				return;
			}

			const result = await host.render(
				{ key: 'smoke', source: normalized, options: { captureLog: true }, timeoutMs },
				controller.signal,
			);

			// The pipeline, in the order docs/DESIGN.md §7.2 fixes: sanitize first and always,
			// ids always, colour after. Fonts are injected at MOUNT — a cache hit and an export
			// popup both mount without rendering, so keying it on render would ship PDFs with
			// fallback glyphs.
			ensureFonts(el.doc, COLD_FONT_CSS);
			this.touchedDocuments.add(el.doc);

			const doc = parseSvg(result.svg);
			const removed = sanitizeSvg(doc);
			remapSoftHyphens(doc);
			placeholderIds(doc);
			applyColorModel(doc, this.settings.colors);

			const template = serializeSvg(doc);
			// stampIds prefixes the nonce itself, so passing `t1_` here would produce `tt1__0`.
			// Harmless — mounts stay disjoint — but it does not match the shape DESIGN §7.2 step 7
			// describes, and a later reader would misread the counter.
			const stamped = stampIds(template, String(++this.instance));

			placeholder.remove();
			const fragment = el.doc.createRange().createContextualFragment(stamped);
			wrapper.appendChild(fragment);

			if (removed.length) renderWarningChip(wrapper, STRINGS.warnSanitized);
			if (result.firstError) renderWarningChip(wrapper, STRINGS.warnRecovered(result.firstError));
		} catch (error) {
			placeholder.remove();
			const texError =
				error instanceof TexError
					? error
					: new TexError('engine-unavailable', [], undefined, undefined, String(error));
			renderErrorCard(wrapper, {
				diagnostic: explain(
					{
						kind: texError.kind,
						message: texError.message,
						firstError: texError.firstError,
						line: texError.line,
					},
					host.capabilities,
				),
				source,
				log: texError.log,
			});
		} finally {
			window.clearTimeout(timer);
		}
	}
}
