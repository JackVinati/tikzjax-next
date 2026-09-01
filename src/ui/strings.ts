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
	warnSanitized: 'Removed active content from this diagram.',
	warnRecovered: (error: string) => `TeX reported: ${error}`,

	// Failures.
	errTimeout: (seconds: number) => `Timed out after ${seconds} s. The engine was restarted.`,
	errPoisoned: 'This diagram timed out earlier. Reload Obsidian to try it again.',
	errEmptyOutput: 'TeX produced no output.',
	errEngineUnavailable: 'The TeX engine could not start.',

	// Coexistence with the plugin this one forks from.
	legacyPluginTitle: 'Two TikZ plugins are enabled',
	legacyPluginBody:
		'The original TikZJax plugin is also enabled. Both register the same code block, so every ' +
		'diagram would be rendered twice. Disable one of them.',

	// Cache.
	cacheStats: (count: number, mb: string) => `${count} diagrams, ${mb}`,
	cacheCleared: 'Cleared the diagram cache.',
	legacyImported: (count: number, mb: string) =>
		`Imported ${count} diagrams (${mb}) from the previous plugin.`,
} as const;
