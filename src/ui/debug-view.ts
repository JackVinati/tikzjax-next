import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { EngineInventory } from '../../engine-src/protocol';

export const DEBUG_VIEW_TYPE = 'tikzjax-debug';

export interface RenderRecord {
	key: string;
	sourcePreview: string;
	state: 'rendering' | 'ok' | 'error' | 'cached';
	tier?: 'l1' | 'l2' | 'l3' | undefined;
	durationMs?: number | undefined;
	message?: string | undefined;
	log?: string[] | undefined;
	at: number;
}

export interface DebugSource {
	records(): readonly RenderRecord[];
	inventory(): EngineInventory | null;
	cacheStats(): Promise<{ entries: number; bytes: number }>;
	memoryStats(): { entries: number; bytes: number };
	queueDepth(): number;
}

/**
 * The panel that makes a rendering problem reportable.
 *
 * Every mobile issue on the original tracker is untriageable for want of this: #82's reporter wrote
 * "I'm not sure if there's an easy way to get debug output from the plugin", and there wasn't. The
 * only diagnostic the old plugin produced was a broken-image icon, so a bad diagram, a missing
 * package and a wedged engine were indistinguishable to the person who had to report them.
 */
export class DebugView extends ItemView {
	private readonly source: DebugSource;
	private timer: number | null = null;

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
		await this.render();
		// Polling rather than an event stream: the records are a plain ring buffer written from the
		// render path, and putting an observer on that path to feed a panel nobody has open would
		// be the wrong trade.
		this.timer = window.setInterval(() => void this.render(), 1000);
		this.register(() => {
			if (this.timer !== null) window.clearInterval(this.timer);
		});
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('tikzjax-debug');

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

		const cache = root.createDiv({ cls: 'tikzjax-debug-section' });
		cache.createEl('h3', { text: 'Cache' });
		const memory = this.source.memoryStats();
		const facts = cache.createDiv({ cls: 'tikzjax-debug-facts' });
		this.fact(facts, 'In memory', `${memory.entries} diagrams, ${mb(memory.bytes)}`);
		this.fact(facts, 'Queue depth', String(this.source.queueDepth()));
		try {
			const stored = await this.source.cacheStats();
			this.fact(facts, 'On disk', `${stored.entries} diagrams, ${mb(stored.bytes)}`);
		} catch {
			this.fact(facts, 'On disk', 'unavailable');
		}

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
			if (record.message) row.createDiv({ cls: 'tikzjax-debug-message', text: record.message });
		}
	}

	private fact(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: 'tikzjax-debug-fact' });
		row.createSpan({ cls: 'tikzjax-debug-label', text: label });
		row.createSpan({ cls: 'tikzjax-debug-value', text: value });
	}
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
