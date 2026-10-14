import type { BootTimings } from '../../engine-src/protocol';
import type { EngineStop } from '../engine/worker-host';
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

/** The README's answers, which the hints below link to (README.md, Questions). */
const README = 'https://github.com/JackVinati/tikzjax-next';
/** "Diagrams are very slow on my iPhone or iPad": Lockdown Mode. */
export const README_LOCKDOWN = `${README}#lockdown-mode`;
/** "After an update, another device shows the new version but nothing changed": Sync Standard. */
export const README_OUT_OF_STEP = `${README}#out-of-step`;

/** What the probe of the JIT found (engine-src/jit.ts), as the diagnostics say it: it is a guess. */
const jitState = (on: boolean | null): string =>
	on === null ? 'not measured yet' : on ? 'on (probably)' : 'off (probably)';

/** main.js and manifest.json of different versions, and what to do about it (src/platform/version.ts). */
const outOfStep = (built: string, manifest: string): string =>
	`This device runs main.js from version ${built}, while its manifest.json says ${manifest}. ` +
	`Obsidian Sync Standard leaves the plugin like this: it copies a new manifest.json and not ` +
	`main.js, which is over its 5 MB limit. Reinstall the plugin on this device: with BRAT, its ` +
	`"Choose a single plugin to reinstall"; from the community store, uninstall it and install it ` +
	`again. With Sync Standard, turn off "Installed community plugins" in Sync's settings.`;

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
	// happen. Each is a label and a number of milliseconds, never part of a sentence.
	timingWaited: (ms: number) => `waited ${ms} ms`,
	timingQueue: (ms: number) => `queue ${ms} ms`,
	timingStart: (ms: number) => `engine start ${ms} ms`,
	timingReset: (ms: number) => `memory reset ${ms} ms`,
	/** The same step, when the engine took a new memory for the diagram rather than resetting its own. */
	timingNewMemory: (ms: number) => `new memory ${ms} ms`,
	timingTex: (ms: number, passes: number) =>
		passes > 1 ? `TeX ${ms} ms, ${passes} passes` : `TeX ${ms} ms`,
	/** The diagram's TeX started from a run an earlier diagram with the same preamble saved. */
	timingResumed: 'resumed from a saved preamble',
	/** The diagram's run was saved at the end of its \begin{document}, for later ones. */
	timingSaved: (ms: number) => `preamble saved in ${ms} ms`,
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
	 * what its probe found of the JIT and took to find it.
	 */
	engineStartedWith: (ms: number, boot: BootTimings) =>
		`started in ${ms} ms (in the worker ${boot.totalMs} ms: decode ${boot.decodeMs} ms, ` +
		`inflate ${boot.inflateMs} ms, compile ${boot.compileMs} ms` +
		(boot.jit === undefined ? '' : `, JIT probe ${boot.jit.spentMs} ms`) +
		`; native gzip ${yesNo(boot.nativeInflate)}, native base64 ${yesNo(boot.nativeBase64)}` +
		(boot.jit === undefined ? '' : `; JIT ${jitState(boot.jit.on)}`) +
		')',
	engineNeverStarted: 'never finished starting',
	/** What an engine held of saved preambles after its last diagram, and its saves that failed. */
	engineSaved: (start: string, runs: number, mb: string, failures: number) =>
		`${start}; ${runs === 1 ? '1 saved preamble' : `${runs} saved preambles`}, ${mb}` +
		(failures === 0 ? '' : failures === 1 ? ', 1 save failed' : `, ${failures} saves failed`),
	engineRunning: (start: string) => `${start}, running`,
	engineStopped: (start: string, why: EngineStop) => `${start}, ${STOPPED[why]}`,
	engineLastStop: (why: EngineStop) => `Last stopped: ${STOPPED[why]}.`,
	enginePool: (count: number) =>
		count === 1 ? 'One engine compiles at a time.' : `Up to ${count} engines compile at once.`,

	// Whether WebAssembly runs with a JIT here (engine-src/jit.ts, internal/DECISIONS.md D33), as
	// the latest engine to start found, and, on an iPhone or iPad without one, what to do about it.
	jitFact: 'JIT',
	jitState,
	/** Shown in the view on iOS and iPadOS when the JIT is off, before the link to the README. */
	jitHint:
		'TeX runs without the JIT compiler on this device, which makes diagrams about twenty times ' +
		'slower. Lockdown Mode is the usual cause. It can stay on with Obsidian excluded: Settings → ' +
		'Privacy & Security → Lockdown Mode → Configure Web Browsing, then restart Obsidian.',
	jitHintLink: 'Lockdown Mode in the README',
	/** Shown once, the first time an engine starts without the JIT on iOS or iPadOS. */
	jitNotice:
		'TikZJax Next: TeX runs without the JIT compiler on this device, which makes diagrams about ' +
		'twenty times slower. Lockdown Mode is the usual cause. It can stay on with Obsidian excluded: ' +
		'Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing, then restart Obsidian. ' +
		'This notice is shown once; "Open TikZ diagnostics" says it again.',
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
	reportJit: (on: boolean | null) => `JIT: ${jitState(on)}`,
	reportObsidian: (version: string) => `Obsidian: ${version}`,
	reportPlatform: (platform: string, os: string) => `Platform: ${platform}, ${os}`,
	reportWebView: (features: WebViewFeatures) =>
		`WebView: DecompressionStream ${yesNo(features.decompressionStream)}, ` +
		`Uint8Array.fromBase64 ${yesNo(features.fromBase64)}, ` +
		`${features.cores === null ? 'cores unknown' : `${features.cores} cores`}, ` +
		`deviceMemory ${features.memoryGiB === null ? 'unknown' : `${features.memoryGiB} GiB`}`,
	reportEngine: (id: string) => `Engine: ${id}`,
	reportOutputRevision: (revision: string) => `Output revision: ${revision}`,
	reportMemory: (count: number, mb: string) => `In memory: ${count} diagrams, ${mb}`,
	reportStored: (count: number, mb: string) => `On disk: ${count} diagrams, ${mb}`,
	reportStoredUnknown: 'On disk: unavailable',
	reportQueue: (depth: number) => `Queue depth: ${depth}`,
	reportRenders: (count: number) => `Recent renders, newest first: ${count}`,
	reportTier: (tier: string) => `from ${tier}`,
	reportAgo: (seconds: number) => `${seconds} s ago`,

	// Cache.
	cacheStats: (count: number, mb: string) => `${count} diagrams, ${mb}`,
	cacheCleared: 'Cleared the diagram cache.',
	legacyImported: (count: number, mb: string) =>
		`Imported ${count} diagrams (${mb}) from the previous plugin.`,
} as const;
