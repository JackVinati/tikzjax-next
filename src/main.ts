import { Notice, Platform, Plugin } from 'obsidian';
import { COLD_FONT_CSS } from 'virtual:fonts';

import type { Budgets, TexResult } from './types';
import type { EngineInventory } from '../engine-src/protocol';
import { WorkerHost } from './engine/worker-host';
import { budgetsFor } from './platform/budgets';
import { ensureFonts } from './platform/context';
import { DiagramCache } from './cache';
import { RenderQueue } from './queue/queue';
import { ViewportGate } from './block/viewport';
import { createProcessor } from './block/processor';
import type { TexJobSpec } from './block/render-child';
import { DEFAULT_SETTINGS, migrateSettings, type TikzSettings } from './settings/schema';
import { PreambleService } from './preamble/vault';
import { registerCommands } from './ui/commands';
import { DebugView, DEBUG_VIEW_TYPE, type RenderRecord } from './ui/debug-view';
import { sha256Hex } from './cache/sha256';
import { MarkdownRenderer, MarkdownView, TFile, type WorkspaceLeaf } from 'obsidian';
import { TikzSettingTab } from './settings/tab';
import { STRINGS } from './ui/strings';

/** The plugin this one forks from. Both register `tikz`, so both cannot run at once. */
const LEGACY_PLUGIN_ID = 'obsidian-tikzjax';

export default class TikzjaxNextPlugin extends Plugin {
	/**
	 * `override` is not decoration. Obsidian 1.13 added `settings?: unknown` to `Plugin`, and under
	 * `useDefineForClassFields` a plain redeclaration would [[Define]] the field at construction —
	 * a silent runtime break rather than a type error. The missing modifier is the only warning
	 * anyone gets.
	 */
	override settings: TikzSettings = { ...DEFAULT_SETTINGS };

	cache: DiagramCache | null = null;

	private host: WorkerHost | null = null;
	private queue: RenderQueue<TexJobSpec, TexResult> | null = null;
	private viewport: ViewportGate | null = null;
	private budgets: Budgets = budgetsFor(false, 4);
	private readonly touchedDocuments = new Set<Document>();
	private preamble: PreambleService | null = null;

	/** raw block source -> cache key, filled as blocks are processed. See TexJobSpec.rawSource. */
	private readonly keysBySource = new Map<string, string>();
	/** A bounded ring for the diagnostics view. Never persisted. */
	private readonly records: RenderRecord[] = [];

	get engineInventory(): EngineInventory | null {
		return this.host?.engineInventory ?? null;
	}

	override async onload(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());

		if (this.legacyPluginEnabled()) {
			// Registering anyway would render every diagram in the vault twice. Refusing loudly is
			// better than a mystery — and this only exists because this is a fork with its own id.
			new Notice(`${STRINGS.legacyPluginTitle}. ${STRINGS.legacyPluginBody}`, 15_000);
			return;
		}

		this.budgets = budgetsFor(Platform.isMobile, navigator.hardwareConcurrency || 4);
		if (this.settings.concurrency > 0 && !Platform.isMobile) {
			this.budgets = { ...this.budgets, concurrency: this.settings.concurrency };
		}
		if (this.settings.timeoutSeconds > 0) {
			this.budgets = { ...this.budgets, timeoutMs: this.settings.timeoutSeconds * 1000 };
		}

		this.host = new WorkerHost();
		this.preamble = new PreambleService(this.app, sha256Hex);
		this.cache = new DiagramCache({
			// `appId` is real but undocumented, so it is not on the public App type. It is what
			// keeps each vault's store separate: every vault on a desktop install shares one
			// origin, and Obsidian namespaces its own stores exactly this way.
			appId: (this.app as unknown as { appId?: string }).appId ?? 'default',
			l1: { entries: this.budgets.l1Entries, bytes: this.budgets.l1Bytes },
			l2Bytes: this.budgets.l2Bytes,
			importLegacy: this.settings.importLegacyCache,
			now: () => Date.now(),
		});

		this.queue = new RenderQueue<TexJobSpec, TexResult>({
			concurrency: this.budgets.concurrency,
			depthCap: this.budgets.queueDepthCap,
			run: (job, signal) => this.runJob(job, signal),
			timers: {
				setTimeout: (fn, ms) => window.setTimeout(fn, ms),
				clearTimeout: (id) => window.clearTimeout(id),
			},
		});

		this.viewport = new ViewportGate({
			rootMarginPx: this.budgets.rootMarginPx,
			zeroRecordEscapeMs: this.budgets.zeroRecordEscapeMs,
			setTimeout: (fn, ms) => window.setTimeout(fn, ms),
			clearTimeout: (id) => window.clearTimeout(id),
		});

		this.registerMarkdownCodeBlockProcessor(
			'tikz',
			createProcessor({
				app: this.app,
				settings: this.settings,
				budgets: this.budgets,
				cache: this.cache,
				queue: this.queue,
				host: this.host,
				// SVGO is not bundled: the only documented reason for it is a 2022 mobile
				// text-offset report with no reproducer, and the targeted transform in
				// svg/optimize.ts addresses that mechanism directly for 40 lines instead of
				// 587 KB. If a real device shows otherwise, this is where it plugs back in.
				svgo: null,
				observe: (el, onChange) => this.viewport?.observe(el, onChange),
				unobserve: (el) => this.viewport?.unobserve(el),
				ensureFonts: (doc) => {
					this.touchedDocuments.add(doc);
					ensureFonts(doc, COLD_FONT_CSS);
				},
				now: () => Date.now(),
				preamble: this.preamble,
				onBlock: (spec) => {
					this.keysBySource.set(spec.rawSource, spec.key);
					this.preamble?.track(spec.key, spec.options.baked.depHashes.map((d) => d.split(':')[0] ?? ''));
					this.remember({
						key: spec.key,
						sourcePreview: spec.source.replace(/\s+/g, ' ').slice(0, 80),
						state: 'rendering',
						at: Date.now(),
					});
				},
			}),
		);

		this.registerView(DEBUG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DebugView(leaf, {
			records: () => this.records,
			inventory: () => this.host?.engineInventory ?? null,
			cacheStats: () => this.cache?.stats() ?? Promise.resolve({ entries: 0, bytes: 0 }),
			memoryStats: () => this.cache?.memoryStats() ?? { entries: 0, bytes: 0 },
			queueDepth: () => this.queue?.size() ?? 0,
		}));

		registerCommands(this, {
			app: this.app,
			markupFor: (source, _notePath) => {
				const key = this.keysBySource.get(source);
				const artifact = key === undefined ? undefined : this.cache?.peek(key);
				return Promise.resolve(artifact?.template ?? null);
			},
			warmNote: (file) => this.warmNote(file),
			fontCss: () => COLD_FONT_CSS,
			openDebugView: () => this.openDebugView(),
		});

		// A preamble file changing must invalidate exactly the diagrams built from it. This is the
		// limitation PR #77's author conceded openly: edit the preamble and nothing notices, because
		// the key was derived from the block source alone.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				const affected = this.preamble?.invalidate(file.path) ?? [];
				for (const key of affected) void this.cache?.forget(key);
				if (affected.length) this.rerenderOpenViews();
			}),
		);

		this.addSettingTab(new TikzSettingTab(this.app, this));
		this.registerCommands();
		this.registerTeardown();
	}

	/** Bounded: the view shows the last hundred, and an unbounded log of a vault scroll is a leak. */
	private remember(record: RenderRecord): void {
		this.records.push(record);
		if (this.records.length > 100) this.records.shift();
	}

	private async openDebugView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(DEBUG_VIEW_TYPE)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: DEBUG_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Render every diagram in a note and wait for them.
	 *
	 * Done by rendering the markdown off-screen rather than by driving the queue directly: that way
	 * the blocks go through the SAME processor, key derivation and cache as a real render, so
	 * warming cannot silently disagree with what a reader will get. It is also what makes an export
	 * predictable — a warmed note exports from cache instead of racing the print snapshot.
	 */
	private async warmNote(file: TFile): Promise<{ ok: number; failed: number }> {
		const text = await this.app.vault.cachedRead(file);
		const holder = createDiv();
		holder.style.position = 'fixed';
		holder.style.left = '-99999px';
		document.body.appendChild(holder);

		const before = this.records.length;
		try {
			await MarkdownRenderer.render(this.app, text, holder, file.path, this);
			const produced = this.records.slice(before);
			return {
				ok: produced.filter((r) => r.state !== 'error').length,
				failed: produced.filter((r) => r.state === 'error').length,
			};
		} finally {
			holder.remove();
		}
	}

	/** Nudge open markdown views so invalidated blocks are rebuilt. */
	private rerenderOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView) view.previewMode?.rerender(true);
		}
	}

	override onunload(): void {
		this.preamble?.clear();
		this.keysBySource.clear();
		this.viewport?.disconnect();
		this.queue?.clearPoison();
		this.host?.dispose();
		this.cache?.dispose();
		for (const doc of this.touchedDocuments) doc.getElementById('tikzjax-fonts')?.remove();
		this.touchedDocuments.clear();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** A Sync-delivered settings change must not serve artifacts built under the old settings. */
	override onExternalSettingsChange(): void {
		void this.loadData().then((raw) => {
			this.settings = migrateSettings(raw);
			this.cache?.dropMemory();
		});
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * One TeX job. The queue owns the slot, the timeout and the abort; this owns the engine call.
	 *
	 * A timeout terminates the worker rather than merely abandoning the wait, because that is the
	 * only thing that actually stops a TeX run: an asyncify continuation that has suspended cannot
	 * be resumed. \nonstopmode makes the case far rarer — it is why a broken diagram now reports a
	 * line number instead of hanging — but it is the optimisation; this is the guarantee.
	 */
	private async runJob(job: TexJobSpec, signal: AbortSignal): Promise<TexResult> {
		job.onStart?.();
		const host = this.host;
		if (!host) throw new Error('engine unavailable');

		signal.addEventListener('abort', () => host.kill(STRINGS.errTimeout(job.timeoutMs / 1000)), {
			once: true,
		});

		return host.render(
			{ key: job.key, source: job.source, options: job.texOptions, timeoutMs: job.timeoutMs },
			signal,
		);
	}

	private legacyPluginEnabled(): boolean {
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
		return plugins?.enabledPlugins?.has(LEGACY_PLUGIN_ID) ?? false;
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'clear-cache',
			name: 'Clear the diagram cache',
			callback: () => {
				void this.cache?.clear().then(() => new Notice(STRINGS.cacheCleared));
			},
		});

		this.addCommand({
			id: 'restart-engine',
			name: 'Restart the TeX engine',
			callback: () => {
				this.host?.kill('restarted from the command palette');
				this.queue?.clearPoison();
				new Notice('TeX engine restarted.');
			},
		});
	}

	/**
	 * Mobile teardown.
	 *
	 * WebKit discards JIT code at 65% memory pressure and reloads the page at 100%, so being near
	 * zero while backgrounded is the difference between surviving and being jetsam-killed. A worker
	 * holding the full core dump is 156 MiB; giving it back the moment the app is hidden is the
	 * cheapest insurance available (#111, #91).
	 */
	private registerTeardown(): void {
		if (!Platform.isMobile) return;
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState !== 'hidden') return;
			this.host?.kill('the app was backgrounded');
			this.cache?.dropMemory();
		});
	}
}
