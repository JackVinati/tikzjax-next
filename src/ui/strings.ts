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
	timingTex: (ms: number, passes: number) =>
		passes > 1 ? `TeX ${ms} ms, ${passes} passes` : `TeX ${ms} ms`,
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
	engineNeverStarted: 'never finished starting',
	engineRunning: (start: string) => `${start}, running`,
	engineStopped: (start: string, why: EngineStop) => `${start}, ${STOPPED[why]}`,
	engineLastStop: (why: EngineStop) => `Last stopped: ${STOPPED[why]}.`,
	enginePool: (count: number) =>
		count === 1 ? 'One engine compiles at a time.' : `Up to ${count} engines compile at once.`,

	// The diagnostics view's Copy button, and the plain text it copies for a bug report.
	copyDiagnostics: 'Copy',
	diagnosticsCopied: 'Diagnostics copied to the clipboard.',
	diagnosticsCopyByHand: 'This device did not let the plugin copy. Select the text below and copy it.',
	diagnosticsText: 'Diagnostics as text',
	reportTitle: 'TikZJax Next diagnostics',
	reportPlugin: (version: string) => `Plugin: ${version}`,
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
