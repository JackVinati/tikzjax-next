import type { JitState } from '../../engine-src/protocol';
import type { BlockOutcome } from '../block/render-child';
import type { StoredRunStats } from '../cache/runs';
import type { EngineReport } from '../engine/worker-host';
import type { WebViewFeatures } from '../platform/device';
import type { CompileTimings } from '../types';
import { STRINGS } from './strings';

/**
 * What the diagnostics view knows, and the text its Copy button puts on the clipboard.
 *
 * Kept apart from the view so that what leaves the device is a pure function of what goes in, and
 * a test can hold it to the one rule that matters: the text is for a bug report, posted where
 * anyone can read it, so it carries no diagram source, no error message (an error quotes the
 * source, and names a preamble file by its path), no transcript and no note. A render is named by
 * its place in the list and the first eight characters of its cache key: a prefix of a hash, from
 * which the diagram cannot be read back, though someone who has the same diagram, with the same
 * settings, could tell that it is the one. It tells two renders of the same diagram apart.
 */

/** One block, from when it was processed: `rendering` until it reports how it came to rest. */
export interface RenderRecord {
	key: string;
	/** Shown in the view, on the device. Never copied. */
	sourcePreview: string;
	state: 'rendering' | BlockOutcome['state'];
	tier?: BlockOutcome['tier'];
	/** Why it failed, as a kind: `tex-error`, `timeout` and the like. */
	reason?: BlockOutcome['reason'];
	durationMs?: number | undefined;
	/** Where the time went, for a diagram compiled this time. */
	timings?: CompileTimings | undefined;
	/** Shown in the view, on the device. Never copied. */
	message?: string | undefined;
	/** Never copied. */
	log?: string[] | undefined;
	/** When it was processed, by the wall clock. */
	at: number;
}

/** The device and the plugin, as a bug report needs them. */
export interface About {
	/** The version manifest.json says, which is the one Obsidian shows. */
	plugin: string;
	/**
	 * The version main.js was built as (src/platform/version.ts): the same, but where Sync left an
	 * old main.js beside a new manifest.json. Null for a build without it.
	 */
	built: string | null;
	/** Obsidian's `apiVersion`. */
	obsidian: string;
	/** `desktop`, `phone` or `tablet`. */
	platform: string;
	/** `Windows`, `macOS`, `Linux`, `iOS` or `Android`, from Obsidian's Platform; `unknown` else. */
	os: string;
	/** In place of `navigator.userAgent`, which the store's rules keep plugins from reading. */
	webView: WebViewFeatures;
	engineId: string;
	outputRevision: string;
}

export interface DiagnosticsSnapshot {
	about: About;
	engine: EngineReport;
	memory: { entries: number; bytes: number };
	/** Null when IndexedDB could not say. */
	stored: { entries: number; bytes: number } | null;
	/** Saved preambles kept across the engine's stops (cache/runs.ts); absent or null where none are kept. */
	preambles?: StoredRunStats | null | undefined;
	queueDepth: number;
	records: readonly RenderRecord[];
	/** The wall clock now, for how long ago each render was. */
	now: number;
}

/**
 * Where a compile's time went, a step to an entry, in the order the steps happen: seen and waiting
 * to be asked for, behind other diagrams, waiting for the engine to start, setting up TeX's memory
 * (its own, reset, or a new one), TeX, and whether it resumed from a saved preamble or saved its
 * own, and in how long, DVI to SVG, the SVG pipeline, drawing it in the note, and the whole of it. A
 * step nobody timed is left out.
 */
export function timingSteps(timings: CompileTimings): string[] {
	const steps = [
		timings.waitedMs === undefined ? null : STRINGS.timingWaited(timings.waitedMs),
		STRINGS.timingQueue(timings.queueMs),
		timings.startMs === undefined ? null : STRINGS.timingStart(timings.startMs),
		timings.resetMs === undefined
			? null
			: (timings.newMemory ?? 0) > 0
				? STRINGS.timingNewMemory(timings.resetMs)
				: STRINGS.timingReset(timings.resetMs),
		timings.texMs === undefined ? null : STRINGS.timingTex(timings.texMs, timings.passes ?? 1),
		timings.resumed !== true
			? timings.restoreMs === undefined
				? null
				: STRINGS.timingRestoreFailed(timings.restoreMs)
			: timings.restored === true
				? STRINGS.timingRestored(timings.fetchMs, timings.restoreMs)
				: STRINGS.timingResumed,
		timings.saveMs === undefined
			? null
			: timings.saveNotKept === true
				? STRINGS.timingSaveNotKept(timings.saveMs)
				: STRINGS.timingSaved(timings.saveMs),
		timings.saveFailed === true ? STRINGS.timingSaveFailed : null,
		timings.svgMs === undefined ? null : STRINGS.timingSvg(timings.svgMs),
		STRINGS.timingPost(timings.postMs),
		timings.mountMs === undefined ? null : STRINGS.timingMount(timings.mountMs),
		timings.totalMs === undefined ? null : STRINGS.timingTotal(timings.totalMs),
	];
	return steps.filter((step): step is string => step !== null);
}

/**
 * What a render is called in the view and in the copied text: its place in the list, oldest first,
 * and the first eight characters of its cache key, so a line of a report can be matched to a row on
 * the screen.
 */
export function renderName(record: RenderRecord, index: number): string {
	return `#${index + 1} ${record.key.slice(0, 8)}`;
}

/**
 * One engine's life, as a line: how long it took to start, where that went inside the worker and
 * whether it had the platform's own gzip and base64 (which iOS has from 16.4 and 18.2), what it held
 * of saved preambles after its last diagram, how many saves failed in it, and how it ended.
 */
export function engineLife(life: EngineReport['lives'][number]): string {
	const started =
		life.startMs === null
			? STRINGS.engineNeverStarted
			: life.boot === null
				? STRINGS.engineStartedIn(life.startMs)
				: STRINGS.engineStartedWith(life.startMs, life.boot);
	const saved = life.snapshots;
	const start =
		saved === null ? started : STRINGS.engineSaved(started, saved.runs, mb(saved.bytes), saved.failures);
	return life.stop === null ? STRINGS.engineRunning(start) : STRINGS.engineStopped(start, life.stop);
}

function mb(bytes: number): string {
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Whether WebAssembly runs with a JIT, probably, as the latest engine to say found it
 * (engine-src/jit.ts): null until an engine that times it has started.
 */
export function jitOf(engine: EngineReport): JitState | null {
	for (let i = engine.lives.length - 1; i >= 0; i--) {
		const jit = engine.lives[i]?.boot?.jit;
		if (jit !== undefined) return jit.state;
	}
	return null;
}

/** What is stored of saved preambles, as a line of the view and of the copied text. */
export function preamblesLine(stats: StoredRunStats): string {
	// Off, nothing is read: the store is never read that session, and would say "not read yet".
	if (stats.off === true) return STRINGS.reportPreamblesOff;
	if (!stats.available) return STRINGS.reportPreamblesUnavailable(stats.errors);
	return stats.read
		? STRINGS.reportPreambles(stats.runs, mb(stats.bytes), stats.errors)
		: STRINGS.reportPreamblesUnread;
}

/** The whole view as plain text, for a bug report. See the top of this file for what it leaves out. */
export function diagnosticsText(s: DiagnosticsSnapshot): string {
	const { about, engine } = s;
	const lines = [
		STRINGS.reportTitle,
		STRINGS.reportPlugin(about.plugin, about.built),
		STRINGS.reportObsidian(about.obsidian),
		STRINGS.reportPlatform(about.platform, about.os),
		STRINGS.reportWebView(about.webView),
		STRINGS.reportJit(
			about.webView.webAssembly ? STRINGS.jitState(jitOf(engine)) : STRINGS.jitNoWebAssembly,
		),
		STRINGS.reportEngine(about.engineId),
		STRINGS.reportOutputRevision(about.outputRevision),
		'',
		STRINGS.engineStarts(engine.starts),
	];
	const first = engine.starts - engine.lives.length + 1;
	engine.lives.forEach((life, i) => lines.push(`  ${first + i}. ${engineLife(life)}`));
	if (engine.lastStop !== null) lines.push(STRINGS.engineLastStop(engine.lastStop));
	lines.push(STRINGS.enginePool(engine.poolSize));

	lines.push(
		'',
		STRINGS.reportMemory(s.memory.entries, mb(s.memory.bytes)),
		s.stored === null
			? STRINGS.reportStoredUnknown
			: STRINGS.reportStored(s.stored.entries, mb(s.stored.bytes)),
		...(s.preambles === null || s.preambles === undefined ? [] : [preamblesLine(s.preambles)]),
		STRINGS.reportQueue(s.queueDepth),
		'',
		STRINGS.reportRenders(s.records.length),
	);

	// Newest first, as the view lists them, numbered from the oldest still in the list.
	for (let i = s.records.length - 1; i >= 0; i--) {
		const record = s.records[i];
		if (record === undefined) continue;
		const ago = Math.max(0, Math.round((s.now - record.at) / 1000));
		const what = [
			record.state,
			record.tier ? STRINGS.reportTier(record.tier) : null,
			record.reason ? `(${record.reason})` : null,
		]
			.filter(Boolean)
			.join(' ');
		const steps = record.timings ? timingSteps(record.timings) : [];
		lines.push([`${renderName(record, i)}, ${STRINGS.reportAgo(ago)}: ${what}`, ...steps].join(' · '));
	}
	return `${lines.join('\n')}\n`;
}
