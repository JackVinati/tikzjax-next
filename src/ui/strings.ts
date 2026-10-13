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
	timingQueue: (ms: number) => `queue ${ms} ms`,
	timingStart: (ms: number) => `engine start ${ms} ms`,
	timingReset: (ms: number) => `memory reset ${ms} ms`,
	timingTex: (ms: number, passes: number) =>
		passes > 1 ? `TeX ${ms} ms, ${passes} passes` : `TeX ${ms} ms`,
	timingSvg: (ms: number) => `DVI to SVG ${ms} ms`,
	timingPost: (ms: number) => `SVG pipeline ${ms} ms`,

	// Cache.
	cacheStats: (count: number, mb: string) => `${count} diagrams, ${mb}`,
	cacheCleared: 'Cleared the diagram cache.',
	legacyImported: (count: number, mb: string) =>
		`Imported ${count} diagrams (${mb}) from the previous plugin.`,
} as const;
