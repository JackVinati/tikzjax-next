import type { BootTimings, HandOverCounts, JitProbe, JitState } from '../../engine-src/protocol';
import type { StoreRefusal } from '../cache/runs';
import type { EngineStop } from '../engine/worker-host';
import type { BlockEdit, EditSource, StoredNotSent } from '../types';
import { compareVersions } from '../platform/version';
import type { WebViewFeatures } from '../platform/device';

/**
 * Every user-visible string, in one place.
 *
 * Obsidian exposes no plugin translation API and no locale-bundle convention, so we do not ship
 * translations and do not pretend to. What this file buys is that a future contributor can add a
 * locale map without touching render logic: no sentence is assembled by concatenation, and no
 * English word order is baked into a template.
 *
 * TeX's own output is passed through untranslated — it is the transcript, not our prose.
 */

/** Why an engine stopped, as the diagnostics view says it (engine/worker-host.ts EngineStop). */
const STOPPED: Record<EngineStop, string> = {
	idle: 'stopped after it had nothing to do',
	background: 'stopped when the app went to the background',
	timeout: 'stopped when a diagram ran out of time in it',
	restart: 'stopped by Restart the TeX engine',
	settings: 'stopped when the second engine was turned off',
	error: 'stopped by an error',
	unload: 'stopped when the plugin was unloaded',
};

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/** What reported an edit of a block's note, as the waited step says it (block/edits.ts). */
const EDITED: Record<EditSource, string> = {
	editor: 'the note was edited',
	unnamed: 'an editor that named no note was edited',
	modify: "the note's file changed",
};

/**
 * The waited step: from seen to asked, and the edit of the block's note that made it wait for the
 * debounce, or one reported after the block was made, which did not count (internal/DECISIONS.md D39).
 */
const waited = (ms: number, edit?: BlockEdit): string =>
	edit === undefined
		? `waited ${ms} ms`
		: edit.at === 'with'
			? `waited ${ms} ms: ${EDITED[edit.source]} as the block was made`
			: edit.at === 'before'
				? `waited ${ms} ms: ${EDITED[edit.source]} ${edit.ms} ms before the block was made`
				: `waited ${ms} ms; ${EDITED[edit.source]} ${edit.ms} ms after the block was made, which did not count`;

/** What storage refused this session, for the line on stored preambles; nothing when it refused nothing. */
const storageErrors = (errors: number): string =>
	errors === 0 ? '' : errors === 1 ? ', 1 storage error' : `, ${errors} storage errors`;

/**
 * Why a run stored for a diagram's preamble was not sent with it (engine/worker-host.ts), so that the
 * diagram compiled its preamble (internal/DECISIONS.md D39).
 */
const NOT_SENT: Record<StoredNotSent, string> = {
	slow: 'storage was slow to answer',
	unsendable: 'it could not be put back earlier for want of memory',
	'not-worth': 'putting it back looked dearer than its preamble',
	'read-failed': 'reading it failed',
	held: 'an engine held it when the diagram came',
	late: 'it was stored after the diagram came',
};

/** Why the store refused a run handed to it (cache/runs.ts), in the order the line lists them. */
const REFUSED: Record<StoreRefusal, string> = {
	'not-worth': 'not worth putting back',
	'too-large': 'larger than the budget',
	'goes-first': 'would have gone first',
	full: 'storage full',
	cleared: 'cleared meanwhile',
	failed: 'not written',
	unavailable: 'storage unavailable',
};

/**
 * What the store kept and refused this session, and why, for the line on stored preambles; nothing
 * before it was handed a run (D39).
 */
const storeSession = (kept: number, refused: Partial<Record<StoreRefusal, number>>): string => {
	const reasons = (Object.keys(REFUSED) as StoreRefusal[]).flatMap((why) => {
		const n = refused[why] ?? 0;
		return n > 0 ? [`${n} ${REFUSED[why]}`] : [];
	});
	const total = Object.values(refused).reduce((sum, n) => sum + (n ?? 0), 0);
	if (kept === 0 && total === 0) return '';
	return `; this session ${kept} kept` + (total === 0 ? '' : `, ${total} refused: ${reasons.join(', ')}`);
};

/**
 * What an engine handed over to be stored, and what of that was dropped for room or failed on the
 * way, for its line; nothing where it handed over none (D39).
 */
const handedOver = (counts: HandOverCounts | undefined): string =>
	counts === undefined || counts.sent + counts.dropped + counts.failed === 0
		? ''
		: `; ${counts.sent} handed over to be stored` +
			(counts.dropped === 0 ? '' : `, ${counts.dropped} dropped for room`) +
			(counts.failed === 0 ? '' : `, ${counts.failed} failed`);

/** The README's answers, which the hints below link to (README.md, Questions). */
const README = 'https://github.com/JackVinati/tikzjax-next';
/** "Diagrams are very slow on my iPhone or iPad": Lockdown Mode. */
export const README_LOCKDOWN = `${README}#lockdown-mode`;
/** "After an update, another device shows the new version but nothing changed": Sync Standard. */
export const README_OUT_OF_STEP = `${README}#out-of-step`;

/**
 * What the probe of the JIT found (engine-src/jit.ts), as the diagnostics say it: it is a guess, and
 * `unclear` where the loop was slow and so was the rest of the start, or nothing native was there to
 * weigh it against; `checking` for the second a start that did not find it on waits to take it again.
 */
const jitState = (state: JitState | 'checking' | null): string =>
	state === null
		? 'not measured yet'
		: state === 'on'
			? 'on (probably)'
			: state === 'off'
				? 'off (probably)'
				: state === 'checking'
					? 'checking again'
					: 'unclear';

/**
 * What a probe took, and when its first attempt was slow, what a step of its loop took and what a
 * byte of the platform's inflate took in the start, which it was weighed against.
 */
const probeFigures = (jit: JitProbe): string =>
	`${jit.spentMs} ms` +
	(jit.nsPerStep === undefined
		? ''
		: ` (${jit.nsPerStep} ns a step` +
			(jit.inflateNsPerByte === undefined ? '' : `, inflate ${jit.inflateNsPerByte} ns a byte`) +
			')');

/** The probe at the start, and the one taken again a second later where there was one (D38). */
const jitProbe = (jit: JitProbe): string =>
	`JIT probe ${probeFigures(jit)}` +
	(jit.again === undefined ? '' : `, again a second later ${probeFigures(jit.again)}`);

/**
 * main.js and manifest.json of different versions, and what to do about it (src/platform/version.ts):
 * what can have left them so depends on which is the newer.
 */
const outOfStep = (built: string, manifest: string): string =>
	compareVersions(built, manifest) > 0
		? `This device runs main.js from version ${built}, while its manifest.json says ${manifest}, ` +
			`an older one: something brought back the old manifest.json, a sync service or a backup. ` +
			`Reinstall the plugin on this device: with BRAT, its "Choose a single plugin to reinstall"; ` +
			`from the community store, uninstall it and install it again.`
		: `This device runs main.js from version ${built}, while its manifest.json says ${manifest}. ` +
			`Obsidian Sync Standard can leave the plugin like this: it copies a new manifest.json and ` +
			`not main.js, which is over its 5 MB limit. Reinstall the plugin on this device: with BRAT, ` +
			`its "Choose a single plugin to reinstall"; from the community store, uninstall it and ` +
			`install it again. With Sync Standard, turn off "Installed community plugins" in Sync's ` +
			`settings.`;

export const STRINGS = {
	rendering: 'Rendering diagram',
	renderDiagram: 'Render diagram',
	retry: 'Retry',
	copyLog: 'Copy log',
	showLog: 'Show log',
	hideLog: 'Hide log',

	logCopied: 'TeX log copied to the clipboard.',
	logCopyFailed: 'Could not copy the log.',

	// Warnings shown beside a diagram that DID render.
	warnDegraded: (stage: string) => `Rendered with the ${stage} step skipped.`,
	/** `removed` names the first few things taken out; `more` counts the rest. */
	warnSanitized: (removed: string, more: number) =>
		more > 0
			? `Removed active content from this diagram: ${removed} and ${more} more.`
			: `Removed active content from this diagram: ${removed}.`,
	warnRecovered: (error: string) => `TeX reported: ${error}`,

	// Failures: the error card's copy is in engine/hints.ts, which words it from the failure and
	// the engine's inventory.

	// Coexistence with the plugin this one forks from.
	legacyPluginTitle: 'Two TikZ plugins are enabled',
	legacyPluginBody:
		'The original TikZJax plugin is also enabled. Both register the same code block, so every ' +
		'diagram would be rendered twice. Disable one of them.',

	// The diagnostics view: where one compile's time went, a step at a time, in the order the steps
	// happen. Each is a label and a number of milliseconds, never part of a sentence, but for the
	// waited step's edit, which says what made a block wait for the debounce.
	timingWaited: waited,
	timingQueue: (ms: number) => `queue ${ms} ms`,
	timingStart: (ms: number) => `engine start ${ms} ms`,
	timingReset: (ms: number) => `memory reset ${ms} ms`,
	/** The same step, when the engine took a new memory for the diagram rather than resetting its own. */
	timingNewMemory: (ms: number) => `new memory ${ms} ms`,
	timingTex: (ms: number, passes: number) =>
		passes > 1 ? `TeX ${ms} ms, ${passes} passes` : `TeX ${ms} ms`,
	/** The diagram's TeX started from a run an earlier diagram with the same preamble saved. */
	timingResumed: 'resumed from a saved preamble',
	/**
	 * The diagram's TeX started from a run kept in storage, which the engine had put back for an
	 * earlier diagram with the same preamble and kept.
	 */
	timingResumedStored: 'resumed from a stored preamble put back for an earlier diagram',
	/**
	 * The block joined a compile of the same diagram already under way, for a block a re-render
	 * replaced or the same diagram in another pane: that compile's TeX, which began before this block
	 * was seen, and not its own.
	 */
	timingJoined: (texMs: number | undefined) =>
		texMs === undefined
			? 'joined a compile already running'
			: `joined a compile already running, whose TeX took ${texMs} ms`,
	/**
	 * The same, from a run kept in storage across the engine's stops (cache/runs.ts, D36), read there
	 * and put back in the engine in this long.
	 */
	timingRestored: (readMs: number | undefined, restoreMs: number | undefined) =>
		'resumed from a stored preamble' +
		(readMs === undefined && restoreMs === undefined
			? ''
			: ` (${[
					readMs === undefined ? null : `read ${readMs} ms`,
					restoreMs === undefined ? null : `put back ${restoreMs} ms`,
				]
					.filter(Boolean)
					.join(', ')})`),
	/** A stored run was sent with the diagram, and could not be started from: it did not read back. */
	timingRestoreFailed: (ms: number) => `stored preamble not used, ${ms} ms`,
	/** A run was stored for the diagram's preamble, and not sent with it, for this (D39). */
	timingStoredNotSent: (why: StoredNotSent) => `stored preamble not sent: ${NOT_SENT[why]}`,
	/**
	 * The diagram's run was saved at the end of its \begin{document}, for later ones; `forStore`, and
	 * handed to the host to store (D36, D39).
	 */
	timingSaved: (ms: number, forStore = false) =>
		`preamble saved in ${ms} ms` + (forStore ? ', sent to be stored' : ''),
	/** The same, when the engine had no room left for it within its budget, and let it go. */
	timingSaveNotKept: (ms: number, forStore = false) =>
		`preamble saved in ${ms} ms, not kept: no room` + (forStore ? ', sent to be stored' : ''),
	timingSaveFailed: 'saving the preamble failed',
	timingSvg: (ms: number) => `DVI to SVG ${ms} ms`,
	timingPost: (ms: number) => `SVG pipeline ${ms} ms`,
	timingMount: (ms: number) => `drawing ${ms} ms`,
	timingTotal: (ms: number) => `seen to drawn ${ms} ms`,

	// The diagnostics view: the engines this session.
	engineStarts: (count: number) =>
		count === 1
			? 'The engine started once this session.'
			: `The engine started ${count} times this session.`,
	engineStartedIn: (ms: number) => `started in ${ms} ms`,
	/**
	 * A start, with where it went once the worker had its payload, which native decoders it had, and
	 * what its probe found of the JIT and took to find it, `jit` being what the start says of it
	 * (report.ts jitOfStart).
	 */
	engineStartedWith: (ms: number, boot: BootTimings, jit: JitState | 'checking' | undefined) =>
		`started in ${ms} ms (in the worker ${boot.totalMs} ms: decode ${boot.decodeMs} ms, ` +
		`inflate ${boot.inflateMs} ms, compile ${boot.compileMs} ms` +
		(boot.jit === undefined ? '' : `, ${jitProbe(boot.jit)}`) +
		`; native gzip ${yesNo(boot.nativeInflate)}, native base64 ${yesNo(boot.nativeBase64)}` +
		(jit === undefined ? '' : `; JIT ${jitState(jit)}`) +
		')',
	engineNeverStarted: 'never finished starting',
	/**
	 * What an engine held of saved preambles after its last diagram, its saves that failed, and what it
	 * handed over to be stored.
	 */
	engineSaved: (start: string, runs: number, mb: string, failures: number, handOvers?: HandOverCounts) =>
		`${start}; ${runs === 1 ? '1 saved preamble' : `${runs} saved preambles`}, ${mb}` +
		(failures === 0 ? '' : failures === 1 ? ', 1 save failed' : `, ${failures} saves failed`) +
		handedOver(handOvers),
	engineRunning: (start: string) => `${start}, running`,
	engineStopped: (start: string, why: EngineStop) => `${start}, ${STOPPED[why]}`,
	engineLastStop: (why: EngineStop) => `Last stopped: ${STOPPED[why]}.`,
	enginePool: (count: number) =>
		count === 1 ? 'One engine compiles at a time.' : `Up to ${count} engines compile at once.`,

	// Whether WebAssembly runs with a JIT here (engine-src/jit.ts, internal/DECISIONS.md D33), as
	// the latest engine to start found, and, on an iPhone or iPad without one, what to do about it.
	jitFact: 'JIT',
	jitState,
	/**
	 * Shown in the view on iOS and iPadOS when the JIT seems off, before the link to the README. A
	 * guess from one short loop, so worded as one, and Lockdown Mode as a cause only if it is on.
	 */
	jitHint:
		'TeX seems to run without the JIT compiler on this device, which makes diagrams about twenty ' +
		'times slower. If Lockdown Mode is on, it is the likely cause, and it can stay on with Obsidian ' +
		'excluded: Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing, then restart ' +
		'Obsidian.',
	jitHintLink: 'Lockdown Mode in the README',
	/** The JIT line where the WebView has no WebAssembly, so that the engine cannot start at all. */
	jitNoWebAssembly: 'no WebAssembly',
	/** Shown in the view on iOS and iPadOS when there is no WebAssembly, before the link to the README. */
	noWebAssemblyHint:
		'This device runs no WebAssembly, which the TeX engine is, so it cannot start. Lockdown Mode ' +
		'turns WebAssembly off on some versions of iOS: it can stay on with Obsidian excluded, under ' +
		'Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing, then restart Obsidian, ' +
		'though on some versions that does not bring WebAssembly back.',
	/** Shown once, when two engine starts of a session on iOS or iPadOS found the JIT off. */
	jitNotice:
		'TikZJax Next: TeX seems to run without the JIT compiler on this device, which makes diagrams ' +
		'about twenty times slower. If Lockdown Mode is on, it is the likely cause, and it can stay on ' +
		'with Obsidian excluded: Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing, ' +
		'then restart Obsidian. This notice is shown once; "Open TikZ diagnostics" says it again.',
	readMore: 'Read more',

	// main.js and manifest.json of different versions (src/platform/version.ts, D34).
	pluginFact: 'Version',
	builtFact: 'main.js built as',
	builtUnknown: 'unknown',
	outOfStep,
	outOfStepNotice: (built: string, manifest: string) => `TikZJax Next: ${outOfStep(built, manifest)}`,

	// The diagnostics view's Copy button, and the plain text it copies for a bug report.
	copyDiagnostics: 'Copy',
	diagnosticsCopied: 'Diagnostics copied to the clipboard.',
	diagnosticsCopyByHand: 'This device did not let the plugin copy. Select the text below and copy it.',
	diagnosticsText: 'Diagnostics as text',
	reportTitle: 'TikZJax Next diagnostics',
	/** manifest.json's version and main.js's, which differ only where Sync left them apart. */
	reportPlugin: (manifest: string, built: string | null) =>
		`Plugin: ${manifest}, main.js ${built ?? 'unknown'}` +
		(built !== null && built !== manifest ? ', out of step: reinstall the plugin on this device' : ''),
	/** The JIT line as it is copied: what the probe found, or that there is no WebAssembly to run. */
	reportJit: (state: string) => `JIT: ${state}`,
	reportObsidian: (version: string) => `Obsidian: ${version}`,
	reportPlatform: (platform: string, os: string) => `Platform: ${platform}, ${os}`,
	reportWebView: (features: WebViewFeatures) =>
		`WebView: WebAssembly ${yesNo(features.webAssembly)}, ` +
		`DecompressionStream ${yesNo(features.decompressionStream)}, ` +
		`Uint8Array.fromBase64 ${yesNo(features.fromBase64)}, ` +
		`${features.cores === null ? 'cores unknown' : `${features.cores} cores`}, ` +
		`deviceMemory ${features.memoryGiB === null ? 'unknown' : `${features.memoryGiB} GiB`}`,
	reportEngine: (id: string) => `Engine: ${id}`,
	reportOutputRevision: (revision: string) => `Output revision: ${revision}`,
	reportMemory: (count: number, mb: string) => `In memory: ${count} diagrams, ${mb}`,
	reportStored: (count: number, mb: string) => `On disk: ${count} diagrams, ${mb}`,
	reportStoredUnknown: 'On disk: unavailable',
	/**
	 * Saved preambles kept across the engine's stops (cache/runs.ts, D36), what storage refused, and
	 * what the store kept and refused of the runs handed to it this session (D39).
	 */
	reportPreambles: (
		runs: number,
		mb: string,
		errors: number,
		kept = 0,
		refused: Partial<Record<StoreRefusal, number>> = {},
	) => `Stored preambles: ${runs}, ${mb}${storageErrors(errors)}${storeSession(kept, refused)}`,
	reportPreamblesUnavailable: (errors: number) => `Stored preambles: unavailable${storageErrors(errors)}`,
	/** Before the engine has first started this session, when what is stored has not been read. */
	reportPreamblesUnread: 'Stored preambles: not read yet, until the engine starts',
	/** Settings → Saved preambles is off: nothing is stored, read or sent. */
	reportPreamblesOff: 'Stored preambles: off',
	reportQueue: (depth: number) => `Queue depth: ${depth}`,
	reportRenders: (count: number) => `Recent renders, newest first: ${count}`,
	reportTier: (tier: string) => `from ${tier}`,
	reportAgo: (seconds: number) => `${seconds} s ago`,

	// Cache.
	/** Clearing deletes the stored preambles too (cache/runs.ts), which the setting says. */
	cacheStats: (count: number, mb: string) =>
		`${count} diagrams, ${mb}. Clearing also deletes the stored preambles.`,
	cacheCleared: 'Cleared the diagram cache and the stored preambles.',
	legacyImported: (count: number, mb: string) =>
		`Imported ${count} diagrams (${mb}) from the previous plugin.`,
} as const;
