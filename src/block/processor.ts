import type { App, MarkdownPostProcessorContext } from 'obsidian';
import type { BakedOptions, BlockOptions, TexHost, TexResult } from '../types';
import { normalizeSource } from '../source/normalize';
import { legacyTidyTikzSource } from '../source/legacy-tidy';
import { parseDirectives } from '../source/directives';
import { preflight } from '../source/preflight';
import { deriveKey } from '../cache/key';
import { isExportContext } from '../platform/context';
import { artifactRevision, type TikzSettings } from '../settings/schema';
import { TikzBlock, type BlockDeps, type TexJobSpec } from './render-child';
import type { RenderQueue } from '../queue/queue';
import type { DiagramCache } from '../cache';
import type { Budgets } from '../types';

/**
 * The code-block processor. See docs/DESIGN.md §3.2.
 *
 * It does three things and hands over: derive the key, probe L1, and register a child. Everything
 * else belongs to the child and the machine.
 *
 * Returning the child's promise is what makes PDF export work at all. Obsidian pushes every value
 * a processor returns into `ctx.promises` and awaits them before taking the print snapshot; the
 * shipped plugin returns `void`, so the only wait is a hard-coded 200 ms sleep and the PDF contains
 * whichever diagrams happened to be cached already (#45, #114).
 */

export interface ProcessorDeps {
	app: App;
	settings: TikzSettings;
	budgets: Budgets;
	cache: DiagramCache;
	queue: RenderQueue<TexJobSpec, TexResult>;
	host: TexHost;
	svgo: BlockDeps['svgo'];
	observe: BlockDeps['observe'];
	unobserve: BlockDeps['unobserve'];
	ensureFonts: BlockDeps['ensureFonts'];
	now: () => number;
	/** Notified so the debug view can list what happened without the child knowing about it. */
	onBlock?: ((spec: TexJobSpec) => void) | undefined;
}

export function createProcessor(deps: ProcessorDeps) {
	return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
		const spec = buildSpec(source, el, deps);
		deps.onBlock?.(spec);

		const child = new TikzBlock(el, spec, {
			cache: deps.cache,
			queue: deps.queue,
			host: deps.host,
			svgo: deps.svgo,
			observe: deps.observe,
			unobserve: deps.unobserve,
			ensureFonts: deps.ensureFonts,
			debounceMs: deps.budgets.debounceMs,
			now: deps.now,
		});

		// Obsidian owns load()/unload() from here, which is what ties cancellation to the block's
		// real lifetime instead of to a guess about when a section went away.
		ctx.addChild(child);
		return child.settled;
	};
}

function buildSpec(source: string, el: HTMLElement, deps: ProcessorDeps): TexJobSpec {
	const { settings, budgets } = deps;

	const defaults = defaultOptions(settings);
	const parsed = parseDirectives(source, defaults);
	const options = parsed.options;

	const normalized =
		settings.sourceHandling === 'legacy'
			? legacyTidyTikzSource(parsed.body)
			: normalizeSource(parsed.body);

	const isExport = isExportContext(deps.app, el);

	const key = deriveKey({
		normalizedSource: normalized,
		baked: options.baked,
		engineId: deps.host.id,
		artifactRevision: artifactRevision(settings),
		pipeline: {
			raw: options.raw,
			fast: options.fast,
			svgo: parsed.svgo ?? settings.svgo,
		},
	});

	const timeoutMs = isExport
		? budgets.exportBlockTimeoutMs
		: (options.presentation.timeoutMs ?? budgets.timeoutMs);

	return {
		key,
		source: normalized,
		options,
		texOptions: {
			...(Object.keys(options.baked.packages).length ? { texPackages: options.baked.packages } : {}),
			...(options.baked.libraries ? { tikzLibraries: options.baked.libraries } : {}),
			...(preambleFor(options.baked) ? { addToPreamble: preambleFor(options.baked) } : {}),
			wrap: options.baked.wrap,
			captureLog: settings.captureLog,
		},
		legacySource: legacySourceFor(parsed.body, options.baked, settings),
		timeoutMs,
		isExport,
		preflight: settings.preflight && !options.fast
			? preflight(normalized, options.baked, deps.host.capabilities)
			: [],
	};
}

function preambleFor(baked: BakedOptions): string {
	const border = baked.border === null ? '' : `\\standaloneconfig{border=${baked.border}}`;
	return `${baked.preamble}${border}`;
}

/**
 * The L3 gate, stated precisely (docs/DESIGN.md §8.3).
 *
 * A legacy record was produced by the OLD engine with NO user preamble at all, so it is only a
 * valid answer for a block that still has none. Returning the source here is what allows the
 * read-through; returning null is what keeps it honest.
 *
 * `border` defaulting to `null` is what keeps this window open at all: injecting
 * `\standaloneconfig{border=2pt}` by default would make the effective preamble non-empty for every
 * block and permanently disable L3 in the same release that promises "upgrading recompiles
 * nothing". The geometry correction happens at mount time from a measured bbox instead, which
 * needs no TeX-side margin.
 */
function legacySourceFor(body: string, baked: BakedOptions, settings: TikzSettings): string | null {
	if (!settings.importLegacyCache) return null;
	if (baked.border !== null) return null;
	if (baked.preamble !== '') return null;
	if (baked.libraries !== '') return null;
	if (Object.keys(baked.packages).length > 0) return null;
	if (settings.preamblePath !== '') return null;
	return body;
}

function defaultOptions(settings: TikzSettings): BlockOptions {
	return {
		baked: {
			border: null,
			packages: {},
			libraries: '',
			preamble: '',
			depHashes: [],
			wrap: 'auto',
		},
		presentation: {
			colors: settings.colors,
			lazy: settings.lazy,
			...(settings.timeoutSeconds > 0 ? { timeoutMs: settings.timeoutSeconds * 1000 } : {}),
		},
		raw: false,
		nocache: false,
		fast: settings.fast,
		warnings: [],
	};
}
