import { Notice, Platform, Plugin } from 'obsidian';
import { COLD_FONT_CSS } from 'virtual:fonts';
import { ENGINE_ID } from 'virtual:engine';

import { TexError, type Budgets, type TexResult } from './types';
import type { BootTimings, EngineInventory } from '../engine-src/protocol';
import { WorkerHost } from './engine/worker-host';
import { budgetsFor, engineCount, snapshotBytes, storedRunBytes } from './platform/budgets';
import { ensureFonts } from './platform/context';
import { device, webViewFeatures } from './platform/device';
import { BUILT_VERSION } from './platform/version';
import { DiagramCache } from './cache';
import { RunStore } from './cache/runs';
import { RenderQueue } from './queue/queue';
import { ViewportGate } from './block/viewport';
import { editedNote, RecentEdits } from './block/edits';
import {
	BlockTally,
	createProcessor,
	OFFSCREEN_CLASS,
	renderedMarkup,
	rendersDifferently,
} from './block/processor';
import type { BlockOutcome, TexJobSpec } from './block/render-child';
import { DEFAULT_SETTINGS, migrateSettings, type TikzSettings } from './settings/schema';
import { PreambleService } from './preamble/vault';
import { registerCommands } from './ui/commands';
import { DebugView, DEBUG_VIEW_TYPE, type RenderRecord } from './ui/debug-view';
import { sha256Hex } from './cache/sha256';
import { OUTPUT_REVISION } from './cache/key';
import { Component, MarkdownRenderer, TFile, type WorkspaceLeaf } from 'obsidian';
import { TikzSettingTab } from './settings/tab';
import { noJitNotice, outOfStepNotice } from './ui/notices';
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
	/** A copy of the settings the open notes were last processed with. */
	private shownSettings: TikzSettings = { ...DEFAULT_SETTINGS };

	cache: DiagramCache | null = null;
	/** Saved preambles kept across the engine's stops (cache/runs.ts, internal/DECISIONS.md D36). */
	private runs: RunStore | null = null;
	/** Whether saved preambles were on when the settings were last applied, to see them turned off. */
	private preamblesOn = true;

	private host: WorkerHost | null = null;
	private queue: RenderQueue<TexJobSpec, TexResult> | null = null;
	private viewport: ViewportGate | null = null;
	private budgets: Budgets = budgetsFor(false);
	private readonly touchedDocuments = new Set<Document>();
	private preamble: PreambleService | null = null;

	/** A bounded ring for the diagnostics view. Never persisted. */
	private readonly records: RenderRecord[] = [];
	/** The "Render all diagrams in this note" runs under way, each counting its own blocks. */
	private readonly tallies = new Set<BlockTally>();
	/**
	 * How many engine starts this session found the JIT on, and how many off (warnIfNoJit). One whose
	 * probe was unclear counts as neither.
	 */
	private readonly jitStarts = { on: 0, off: 0 };

	get engineInventory(): EngineInventory | null {
		return this.host?.engineInventory ?? null;
	}

	override async onload(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());
		this.shownSettings = { ...this.settings };
		this.warnIfOutOfStep();

		if (this.legacyPluginEnabled()) {
			// Registering anyway would render every diagram in the vault twice. Refusing loudly is
			// better than a mystery — and this only exists because this is a fork with its own id.
			new Notice(`${STRINGS.legacyPluginTitle}. ${STRINGS.legacyPluginBody}`, 15_000);
			return;
		}

		// The time limit is not folded in here any more. The processor reads it per block, so a change
		// applies to the next diagram rather than after a restart, and a limit set back to 0 falls back
		// to this budget rather than to the value it had at load.
		this.budgets = budgetsFor(Platform.isMobile);

		const timers = {
			setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
			clearTimeout: (id: number) => window.clearTimeout(id),
		};

		// As many workers as jobs the queue runs at once, each running one job at a time: two on a
		// computer, one on a phone, one where the second engine is off or memory is short
		// (platform/budgets.ts `engineCount`), and one after a worker failed to start, which the
		// host tells the queue. A job the queue starts beyond the workers would wait in the host on
		// its startup allowance, behind someone else's diagram.
		const engines = this.engineCount();
		// `appId` is real but undocumented, so it is not on the public App type. It is what keeps each
		// vault's stores separate: every vault on a desktop install shares one origin, and Obsidian
		// namespaces its own stores exactly this way.
		const appId = (this.app as unknown as { appId?: string }).appId ?? 'default';
		// Saved preambles outlive the engine that saved them, in this device's IndexedDB, never in the
		// vault (D36); none are kept while saved preambles are off, and what was is deleted.
		this.runs = new RunStore({
			appId,
			engineId: ENGINE_ID,
			budget: () => storedRunBytes(this.budgets, webViewFeatures()),
			now: () => Date.now(),
		});
		this.preamblesOn = this.settings.preambleSnapshots;
		if (!this.preamblesOn) void this.runs.discard();
		this.host = new WorkerHost({
			idleTeardownMs: this.budgets.idleTeardownMs,
			timers,
			poolSize: engines,
			onSize: (size) => this.queue?.setConcurrency(size),
			// Saved preambles (internal/DECISIONS.md D32), read for each diagram, so that turning them
			// off applies to the next one, also when the change arrives through Sync. A phone's budget
			// on a computer short of memory (platform/budgets.ts snapshotBytes).
			snapshotBudget: () =>
				this.settings.preambleSnapshots ? snapshotBytes(this.budgets, webViewFeatures()) : 0,
			// Whether TeX runs without the JIT, which on an iPhone or iPad is said once (D33).
			onStarted: (boot) => this.warnIfNoJit(boot),
			runs: this.runs,
		});
		this.preamble = new PreambleService(this.app, sha256Hex);
		this.cache = new DiagramCache({
			appId,
			l1: { entries: this.budgets.l1Entries, bytes: this.budgets.l1Bytes },
			l2Bytes: this.budgets.l2Bytes,
			importLegacy: () => this.settings.importLegacyCache,
			now: () => Date.now(),
			// Clearing the diagram cache clears the saved preambles kept beside it too.
			runs: this.runs,
		});

		this.queue = new RenderQueue<TexJobSpec, TexResult>({
			concurrency: engines,
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

		// Which notes are being typed in, in any pane, so that only their blocks debounce and every
		// other diagram goes to the queue as soon as it is seen (block/edits.ts). A change no editor
		// made comes in through `modify`, below.
		const edits = new RecentEdits(this.budgets.editWindowMs, () => Date.now());
		this.registerEvent(
			this.app.workspace.on('editor-change', (_editor, info) => edits.changed(editedNote(info))),
		);

		this.registerMarkdownCodeBlockProcessor(
			'tikz',
			createProcessor({
				app: this.app,
				settings: () => this.settings,
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
					// Only the documents still open are worth keeping for the unload sweep. Every PDF
					// export's popup used to stay here, with the fonts injected into it, until the
					// plugin unloaded — the one thing platform/context.ts says this must not do.
					for (const touched of this.touchedDocuments) {
						const view = touched.defaultView;
						if (!view || view.closed) this.touchedDocuments.delete(touched);
					}
					this.touchedDocuments.add(doc);
					ensureFonts(doc, COLD_FONT_CSS);
				},
				now: () => Date.now(),
				timers,
				preamble: this.preamble,
				editing: (notePath) => edits.editing(notePath),
				// At the first diagram that is not cached, never at load: a session that only shows
				// cached diagrams never pays for an engine. Never in the background either, where the
				// mobile teardown has just stopped one and paused the queue so that none starts. The
				// block's own document, not the main window's: on a desktop the main window may be
				// minimized while a pop-out window shows the note.
				startEngine: (doc) => {
					if (doc.visibilityState === 'hidden') return;
					this.host?.ready().catch(() => undefined);
				},
				onBlock: (spec, el) => {
					const record: RenderRecord = {
						key: spec.key,
						sourcePreview: spec.source.replace(/\s+/g, ' ').slice(0, 80),
						state: 'rendering',
						at: Date.now(),
					};
					this.remember(record);
					const watchers: ((outcome: BlockOutcome) => void)[] = [];
					for (const tally of this.tallies) {
						const watch = tally.watch(el);
						if (watch) watchers.push(watch);
					}
					// The record is updated in place: the view reads the ring every second, and a
					// record already pushed out of it is simply no longer shown.
					return (outcome) => {
						record.state = outcome.state;
						record.tier = outcome.tier;
						record.reason = outcome.reason;
						record.durationMs = outcome.durationMs;
						record.timings = outcome.timings;
						record.message = outcome.message;
						record.log = outcome.log;
						for (const watch of watchers) watch(outcome);
					};
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
					storedRuns: () =>
						this.runs === null
							? null
							: { ...this.runs.stats(), off: !this.settings.preambleSnapshots },
					queueDepth: () => this.queue?.size() ?? 0,
					engine: () =>
						this.host?.report() ?? { starts: 0, lives: [], lastStop: null, poolSize: 1 },
					about: () => ({
						...device(),
						plugin: this.manifest.version,
						built: BUILT_VERSION,
						engineId: this.host?.id ?? '',
						outputRevision: OUTPUT_REVISION,
					}),
				}),
		);

		const preamble = this.preamble;
		const cache = this.cache;
		const host = this.host;
		registerCommands(this, {
			app: this.app,
			markupFor: (source, notePath) =>
				renderedMarkup(source, notePath, {
					settings: () => this.settings,
					budgets: this.budgets,
					host,
					preamble,
					cache,
				}),
			warmNote: (file, signal) => this.warmNote(file, signal),
			fontCss: () => COLD_FONT_CSS,
			openDebugView: () => this.openDebugView(),
		});

		// A preamble file changing must invalidate exactly the diagrams built from it. This is the
		// limitation PR #77's author conceded openly: edit the preamble and nothing notices, because
		// the key was derived from the block source alone.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				// A note rewritten by a sync or collaboration plugin, or by another program, is
				// redrawn in a Reading view without any editor saying so; its blocks debounce like
				// those of a note being typed in, so that changes coming in quickly compile once.
				edits.changed(file.path);
				const affected = this.preamble?.invalidate(file.path) ?? [];
				for (const key of affected) void this.cache?.forget(key);
				if (affected.length) this.rerenderOpenViews();
			}),
		);

		this.addSettingTab(new TikzSettingTab(this.app, this));
		this.registerCommands();
		this.registerTeardown();
	}

	/**
	 * Say, once for each pair of versions, that the main.js this device runs is not the version its
	 * manifest.json says, and how to put that right (platform/version.ts, internal/DECISIONS.md D34):
	 * Obsidian Sync Standard copies a new manifest.json and leaves the old main.js, over its 5 MB
	 * limit. Until it is tapped, since it is shown once; the diagnostics view says it as long as it
	 * holds.
	 */
	private warnIfOutOfStep(): void {
		const notice = outOfStepNotice(
			BUILT_VERSION,
			this.manifest.version,
			this.settings.outOfStepNoticeShown,
		);
		if (notice === null) return;
		new Notice(notice.message, 0);
		this.settings.outOfStepNoticeShown = notice.pair;
		void this.saveData(this.settings);
	}

	/**
	 * Say, once, on an iPhone or iPad, that TeX seems to run without the JIT there, which Lockdown Mode
	 * is the likely cause of (engine-src/jit.ts, internal/DECISIONS.md D33), once two of this
	 * session's engine starts have found it off and none on. Until it is tapped, since it is shown
	 * once; the diagnostics view says it whenever it is opened.
	 */
	private warnIfNoJit(boot: BootTimings | null): void {
		const state = boot?.jit?.state;
		if (state === 'on' || state === 'off') this.jitStarts[state]++;
		const message = noJitNotice(this.jitStarts, device().os, this.settings.jitNoticeShown);
		if (message === null) return;
		new Notice(message, 0);
		this.settings.jitNoticeShown = true;
		void this.saveData(this.settings);
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
	private async warmNote(file: TFile, signal: AbortSignal): Promise<{ ok: number; failed: number }> {
		const text = await this.app.vault.cachedRead(file);
		// The processor renders whatever is in here eagerly, whatever its lazy mode: no viewport
		// will ever see it.
		const holder = createDiv({ cls: OFFSCREEN_CLASS });
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

		// This run's own count, of the blocks in its own holder — not a slice of the diagnostics ring.
		const tally = new BlockTally(holder);
		this.tallies.add(tally);
		try {
			// Stopping does not wait for the run to wind down: unloading the owner below settles
			// every block at once, except one compiling, which finishes under its own timeout and
			// still caches its diagram.
			const stopped = new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener('abort', () => resolve(), { once: true });
			});
			await Promise.race([MarkdownRenderer.render(this.app, text, holder, file.path, owner), stopped]);
			return tally.counts();
		} finally {
			this.tallies.delete(tally);
			owner.unload();
			holder.remove();
		}
	}

	/**
	 * Rebuild the blocks of every open note, in Live Preview as well as in Reading view.
	 *
	 * `previewMode.rerender` reaches Reading view only. Live Preview keeps a code block's widget for
	 * as long as the block's text is unchanged, so after a preamble edit it went on showing the
	 * diagram built from the old preamble until the note was reopened. `post-processor-change` is
	 * the event Obsidian fires itself when a plugin registers or unregisters a code-block processor —
	 * it is how a newly enabled plugin's blocks appear in notes already open — and both views
	 * rebuild on it: Reading view rerenders, and the editor drops its cached widgets (read in the
	 * 1.14.4 bundle). A block whose key did not change is an L1 hit, so this costs no compile.
	 */
	private rerenderOpenViews(): void {
		this.app.workspace.trigger('post-processor-change');
	}

	override onunload(): void {
		this.preamble?.clear();
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
		this.runs?.close();
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
		this.applyEngineCount();
		this.applySavedPreambles();
		this.showSettings();
		await this.saveData(this.settings);
	}

	/**
	 * Sync, iCloud, Syncthing or git rewrote data.json. Obsidian calls this when the file is newer
	 * than what the plugin last loaded.
	 *
	 * L1 is not dropped, as it used to be: every setting that changes a stored artifact is in its
	 * key (settings/schema.ts `artifactRevision`, the preamble text), so an artifact built under
	 * the old settings cannot be served for the new ones, and the rest are applied at mount.
	 */
	override onExternalSettingsChange(): void {
		void this.loadData().then((raw) => {
			this.settings = migrateSettings(raw);
			this.queue?.clearPoison();
			this.applyEngineCount();
			this.applySavedPreambles();
			this.showSettings();
		});
	}

	/**
	 * Whether this device runs a second engine when the setting lets it: not a phone or a tablet, nor
	 * a computer that reports too little memory or too few cores (platform/budgets.ts `engineCount`).
	 * The settings tab says so where it does not.
	 */
	get secondEngineAvailable(): boolean {
		return engineCount(this.budgets, true, webViewFeatures()) > 1;
	}

	/** How many engines run at once on this device, under the settings now in force. */
	private engineCount(): number {
		return engineCount(this.budgets, this.settings.secondEngine, webViewFeatures());
	}

	/**
	 * The second engine was turned on or off: the host runs that many workers from now on, and tells
	 * the queue how many jobs to run at once (`onSize`), which is one while a worker that failed to
	 * start keeps the pool at one. A worker no longer wanted goes when it has finished its job.
	 */
	private applyEngineCount(): void {
		this.host?.setPoolSize(this.engineCount());
	}

	/**
	 * Saved preambles were turned off, here or through Sync: the stored ones are deleted (D36). The
	 * engines let theirs go at their next diagram, which the host sends a budget of 0 (worker-host.ts).
	 */
	private applySavedPreambles(): void {
		const on = this.settings.preambleSnapshots;
		if (this.preamblesOn && !on) void this.runs?.clear();
		this.preamblesOn = on;
	}

	/**
	 * Process the open notes again if the settings now in force would build their blocks
	 * differently. Neither a change in the tab nor one from Sync used to show until a note was
	 * reopened: a mounted diagram keeps the colours, the lazy mode and the key it was built with.
	 */
	private showSettings(): void {
		if (!rendersDifferently(this.shownSettings, this.settings)) return;
		this.shownSettings = { ...this.settings };
		this.rerenderOpenViews();
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * One TeX job. The queue owns the slot, the clock and the abort; the host owns the worker.
	 *
	 * A timeout still terminates the worker rather than merely abandoning the wait, because that is
	 * the only thing that actually stops a TeX run: it is synchronous inside the worker, and one that
	 * loops never yields. The host does it, on the abort, and only to the worker that job is in —
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
				this.host?.kill('restart');
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
			this.host?.kill('background');
			this.cache?.dropMemory();
		});
	}
}
