import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { EngineInventory } from '../../engine-src/protocol';
import type { EngineReport } from '../engine/worker-host';
import type { CompileTimings } from '../types';
import { diagnosticsText, engineLife, timingSteps, type About, type RenderRecord } from './report';
import { STRINGS } from './strings';

export type { RenderRecord } from './report';

export const DEBUG_VIEW_TYPE = 'tikzjax-debug';

export interface DebugSource {
	records(): readonly RenderRecord[];
	inventory(): EngineInventory | null;
	cacheStats(): Promise<{ entries: number; bytes: number }>;
	memoryStats(): { entries: number; bytes: number };
	queueDepth(): number;
	/** How often the engine started this session, and why it last stopped. */
	engine(): EngineReport;
	/** The plugin, Obsidian and the device, for the copied text. */
	about(): About;
	/** The wall clock. Omitted: Date.now(). */
	now?: (() => number) | undefined;
}

/**
 * The panel that makes a rendering problem reportable.
 *
 * Every mobile issue on the original tracker is untriageable for want of this: #82's reporter wrote
 * "I'm not sure if there's an easy way to get debug output from the plugin", and there wasn't. The
 * only diagnostic the old plugin produced was a broken-image icon, so a bad diagram, a missing
 * package and a wedged engine were indistinguishable to the person who had to report them.
 *
 * Its Copy button puts all of it on the clipboard as plain text (ui/report.ts), so a phone, which
 * has no devtools, can report what it saw, and the same procedure can be repeated release after
 * release.
 */
export class DebugView extends ItemView {
	private readonly source: DebugSource;
	private timer: number | null = null;
	/** What the refresh redraws. The Copy button and the text to copy by hand stay put. */
	private live: HTMLElement | null = null;
	private byHand: HTMLElement | null = null;
	/** The last answer IndexedDB gave, so that Copy can build its text inside the click. */
	private stored: { entries: number; bytes: number } | null = null;

	constructor(leaf: WorkspaceLeaf, source: DebugSource) {
		super(leaf);
		this.source = source;
	}

	override getViewType(): string {
		return DEBUG_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return 'TikZ diagnostics';
	}

	override getIcon(): string {
		return 'activity';
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('tikzjax-debug');

		const actions = root.createDiv({ cls: 'tikzjax-debug-actions' });
		const copy = actions.createEl('button', { text: STRINGS.copyDiagnostics });
		copy.addEventListener('click', () => this.copy());
		this.byHand = root.createDiv({ cls: 'tikzjax-debug-by-hand' });
		this.byHand.hidden = true;
		this.live = root.createDiv();

		await this.render();
		// Polling rather than an event stream: the records are a plain ring buffer written from the
		// render path, and putting an observer on that path to feed a panel nobody has open would
		// be the wrong trade.
		this.timer = window.setInterval(() => void this.render(), 1000);
		this.register(() => {
			if (this.timer !== null) window.clearInterval(this.timer);
		});
	}

	/** Everything the view knows, as it is now, for the copied text. */
	private snapshot(): Parameters<typeof diagnosticsText>[0] {
		return {
			about: this.source.about(),
			engine: this.source.engine(),
			memory: this.source.memoryStats(),
			stored: this.stored,
			queueDepth: this.source.queueDepth(),
			records: this.source.records(),
			now: (this.source.now ?? Date.now)(),
		};
	}

	/**
	 * Put the whole view on the clipboard as plain text.
	 *
	 * The text is built and handed to the clipboard inside the click, which is what WebKit asks of a
	 * page writing to it. Where the clipboard is missing or says no — an older iOS WebKit, a
	 * WebView that withholds it — the text is shown below the button, selected, to copy by hand.
	 */
	private copy(): void {
		const text = diagnosticsText(this.snapshot());
		const byHand = (): void => this.showByHand(text);
		let writing: Promise<void>;
		try {
			const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
			if (typeof clipboard?.writeText !== 'function') {
				byHand();
				return;
			}
			writing = clipboard.writeText(text);
		} catch {
			byHand();
			return;
		}
		void writing.then(() => {
			if (this.byHand) this.byHand.hidden = true;
			new Notice(STRINGS.diagnosticsCopied);
		}, byHand);
	}

	private showByHand(text: string): void {
		const box = this.byHand;
		if (!box) return;
		box.empty();
		box.hidden = false;
		box.createDiv({ cls: 'tikzjax-debug-by-hand-hint', text: STRINGS.diagnosticsCopyByHand });
		const area = box.createEl('textarea', { cls: 'tikzjax-debug-by-hand-text' });
		area.readOnly = true;
		area.value = text;
		area.rows = 12;
		try {
			area.focus();
			area.setSelectionRange(0, text.length);
		} catch {
			// Selecting is a convenience: the text is there to select by hand either way.
		}
	}

	private async render(): Promise<void> {
		const root = this.live;
		if (!root) return;

		// Asked first, so that what is drawn below is all of one moment.
		try {
			this.stored = await this.source.cacheStats();
		} catch {
			this.stored = null;
		}
		root.empty();

		const inventory = this.source.inventory();
		const engine = root.createDiv({ cls: 'tikzjax-debug-section' });
		engine.createEl('h3', { text: 'Engine' });
		if (inventory) {
			const dl = engine.createDiv({ cls: 'tikzjax-debug-facts' });
			this.fact(dl, 'Engine', inventory.engine);
			this.fact(dl, 'Id', inventory.engineId.slice(0, 16));
			this.fact(dl, 'TeX files', String(inventory.files.length));
			this.fact(dl, 'expl3', inventory.capabilities.expl3 ? 'available' : 'unavailable');
			for (const [name, version] of Object.entries(inventory.packages)) this.fact(dl, name, version);
		} else {
			engine.createDiv({ text: 'Not started. It boots with the first diagram.' });
		}
		this.starts(engine, this.source.engine());

		const cache = root.createDiv({ cls: 'tikzjax-debug-section' });
		cache.createEl('h3', { text: 'Cache' });
		const memory = this.source.memoryStats();
		const facts = cache.createDiv({ cls: 'tikzjax-debug-facts' });
		this.fact(facts, 'In memory', `${memory.entries} diagrams, ${mb(memory.bytes)}`);
		this.fact(facts, 'Queue depth', String(this.source.queueDepth()));
		this.fact(
			facts,
			'On disk',
			this.stored ? `${this.stored.entries} diagrams, ${mb(this.stored.bytes)}` : 'unavailable',
		);

		const recent = root.createDiv({ cls: 'tikzjax-debug-section' });
		recent.createEl('h3', { text: 'Recent renders' });
		const records = this.source.records();
		if (records.length === 0) {
			recent.createDiv({ text: 'Nothing yet.' });
			return;
		}

		for (const record of records.slice().reverse()) {
			const row = recent.createDiv({ cls: `tikzjax-debug-row is-${record.state}` });
			row.createSpan({ cls: 'tikzjax-debug-state', text: record.state });
			row.createSpan({ cls: 'tikzjax-debug-source', text: record.sourcePreview });
			row.createSpan({
				cls: 'tikzjax-debug-meta',
				text: [
					record.tier ? `from ${record.tier}` : null,
					record.durationMs === undefined ? null : `${record.durationMs} ms`,
				]
					.filter(Boolean)
					.join(' · '),
			});
			if (record.timings) this.timings(row, record.timings);
			if (record.message) row.createDiv({ cls: 'tikzjax-debug-message', text: record.message });
		}
	}

	/**
	 * How often the engine started, how long each start took and why each stopped. On a phone it
	 * stops when it has been idle and whenever the app goes to the background, and each start is
	 * paid by the next diagram that is not cached.
	 */
	private starts(section: HTMLElement, report: EngineReport): void {
		const starts = section.createDiv({ cls: 'tikzjax-debug-starts' });
		starts.createDiv({ text: STRINGS.engineStarts(report.starts) });
		const list = starts.createEl('ol', { cls: 'tikzjax-debug-lives' });
		list.start = report.starts - report.lives.length + 1;
		for (const life of report.lives) list.createEl('li', { text: engineLife(life) });
		if (report.lastStop !== null) starts.createDiv({ text: STRINGS.engineLastStop(report.lastStop) });
		starts.createDiv({ text: STRINGS.enginePool(report.poolSize) });
	}

	/**
	 * Where a compile's time went, a step to a span, in the order the steps happen, so a slow
	 * diagram can be reported with where it was slow: waiting to be asked for, behind other
	 * diagrams, waiting for the engine to start, in TeX, in the SVG work on either side of it, or
	 * being drawn in the note. A step nobody timed is left out.
	 */
	private timings(row: HTMLElement, timings: CompileTimings): void {
		const line = row.createDiv({ cls: 'tikzjax-debug-timings' });
		for (const step of timingSteps(timings)) line.createSpan({ text: step });
	}

	private fact(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: 'tikzjax-debug-fact' });
		row.createSpan({ cls: 'tikzjax-debug-label', text: label });
		row.createSpan({ cls: 'tikzjax-debug-value', text: value });
	}
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
