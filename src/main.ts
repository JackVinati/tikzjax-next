import { Notice, Platform, Plugin } from 'obsidian';
import { COLD_FONT_CSS } from 'virtual:fonts';

import { TexError, type Budgets, type TexResult } from './types';
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
import { Component, MarkdownRenderer, MarkdownView, TFile, type WorkspaceLeaf } from 'obsidian';
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
	private budgets: Budgets = budgetsFor(false);
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

		// `settings.concurrency` is deliberately not read: there is one worker, and it runs one job at
		// a time, so a second slot would only queue a job inside the worker with its clock running.
		// See DESKTOP.concurrency in platform/budgets.ts.
		this.budgets = budgetsFor(Platform.isMobile);
		if (this.settings.timeoutSeconds > 0) {
			this.budgets = { ...this.budgets, timeoutMs: this.settings.timeoutSeconds * 1000 };
		}

		const timers = {
			setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			clearTimeout: (id: number) => window.clearTimeout(id),
		};

		this.host = new WorkerHost({ idleTeardownMs: this.budgets.idleTeardownMs, timers });
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
			run: (job, signal, running) => this.runJob(job, signal, running),
			timers,
			// A job's own timeout starts when the worker takes it; until then it is waiting on the
			// boot, which gets this long.
			startupMs: this.budgets.firstJobGraceMs,
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
					this.preamble?.track(
						spec.key,
						spec.options.baked.depHashes.map((d) => d.split(':')[0] ?? ''),
					);
					this.remember({
						key: spec.key,
						sourcePreview: spec.source.replace(/\s+/g, ' ').slice(0, 80),
						state: 'rendering',
						at: Date.now(),
					});
				},
			}),
		);

		this.registerView(
			DEBUG_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new DebugView(leaf, {
					records: () => this.records,
					inventory: () => this.host?.engineInventory ?? null,
					cacheStats: () => this.cache?.stats() ?? Promise.resolve({ entries: 0, bytes: 0 }),
					memoryStats: () => this.cache?.memoryStats() ?? { entries: 0, bytes: 0 },
					queueDepth: () => this.queue?.size() ?? 0,
				}),
		);

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
		const holder = createDiv({ cls: 'tikzjax-offscreen' });
		document.body.appendChild(holder);

		// A throwaway Component, NOT `this`.
		//
		// MarkdownRenderer.render registers every child it creates against the component it is
		// given, and unloads them when that component unloads. Handing it the plugin means the
		// blocks from every warmed note stay registered until the plugin itself is disabled —
		// a leak that grows with use, and precisely what obsidianmd/no-plugin-as-component exists
		// to catch. Unloading the owner in the `finally` is what makes warming free afterwards.
		const owner = new Component();
		owner.load();

		const before = this.records.length;
		try {
			await MarkdownRenderer.render(this.app, text, holder, file.path, owner);
			const produced = this.records.slice(before);
			return {
				ok: produced.filter((r) => r.state !== 'error').length,
				failed: produced.filter((r) => r.state === 'error').length,
			};
		} finally {
			owner.unload();
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
		// The queue is closed BEFORE the host goes. Disposing interrupts the running job, its slot
		// is freed in a `finally` that starts the next one, and a host still reachable from
		// `runJob` would boot a worker for it that nothing would ever terminate. Obsidian rebuilds
		// Live Preview widgets ~10 ms after the processor is unregistered, so there is usually a
		// next one.
		this.queue?.close();
		this.queue?.clearPoison();
		const host = this.host;
		this.host = null;
		host?.dispose();
		this.cache?.dispose();
		for (const doc of this.touchedDocuments) doc.getElementById('tikzjax-fonts')?.remove();
		this.touchedDocuments.clear();
	}

	/**
	 * Every change in the settings tab comes through here, and each one gives the diagrams that
	 * timed out this session another chance: a longer timeout is exactly what one may have needed,
	 * and it applies to every block rendered from now on. The poison set is what kept refusing them.
	 */
	async saveSettings(): Promise<void> {
		this.queue?.clearPoison();
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
	 * One TeX job. The queue owns the slot, the clock and the abort; the host owns the worker.
	 *
	 * A timeout still terminates the worker rather than merely abandoning the wait, because that is
	 * the only thing that actually stops a TeX run: an asyncify continuation that has suspended
	 * cannot be resumed. The host does it, on the abort, and only to the worker that job is in —
	 * this used to kill whichever worker was current, interrupting jobs that had nothing to do with
	 * the timeout and, after a kill during boot, the next job's fresh worker.
	 */
	private runJob(job: TexJobSpec, signal: AbortSignal, running: () => void): Promise<TexResult> {
		const host = this.host;
		if (!host) {
			return Promise.reject(
				new TexError('engine-unavailable', [], undefined, undefined, 'the plugin was unloaded'),
			);
		}
		return host.render(
			{ key: job.key, source: job.source, options: job.texOptions, timeoutMs: job.timeoutMs },
			signal,
			running,
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
	 *
	 * A diagram compiling at that moment is interrupted, not failed: its block puts it back in the
	 * queue. The queue is paused first so that nothing — that job above all — boots a new worker
	 * while the app is still in the background, and resumed when it comes back.
	 */
	private registerTeardown(): void {
		if (!Platform.isMobile) return;
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState !== 'hidden') {
				this.queue?.resume();
				return;
			}
			this.queue?.pause();
			this.host?.kill('the app was backgrounded');
			this.cache?.dropMemory();
		});
	}
}
