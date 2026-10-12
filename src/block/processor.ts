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
import { standaloneMarkup } from './mount';
import { asProcessorSource } from '../note/finalize';
import type { RenderQueue } from '../queue/queue';
import type { DiagramCache } from '../cache';
import type { Budgets } from '../types';
import type { PreambleService } from '../preamble/vault';

/**
 * The code-block processor. See internal/DESIGN.md §3.2.
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
	/**
	 * Read once per block, never held. The plugin REPLACES its settings object when Sync or another
	 * device rewrites data.json, and the settings tab writes into whichever object is current; a
	 * processor handed the object at load went on rendering with the old one, and with nothing the
	 * tab changed after that, until Obsidian restarted.
	 */
	settings: () => TikzSettings;
	budgets: Budgets;
	cache: DiagramCache;
	queue: RenderQueue<TexJobSpec, TexResult>;
	host: TexHost;
	svgo: BlockDeps['svgo'];
	observe: BlockDeps['observe'];
	unobserve: BlockDeps['unobserve'];
	ensureFonts: BlockDeps['ensureFonts'];
	now: () => number;
	preamble: PreambleService;
	/** Notified so the debug view can list what happened without the child knowing about it. */
	onBlock?: ((spec: TexJobSpec) => void) | undefined;
}

export function createProcessor(deps: ProcessorDeps) {
	return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
		const prepared = prepare(source, deps, ctx.sourcePath, isExportContext(deps.app, el));

		// The common case — no preamble configured anywhere — stays SYNCHRONOUS, and that is not an
		// optimisation. A cached diagram is only painted in the same frame as the text around it if
		// the child is created before this function yields; one `await` on a resolution that had
		// nothing to resolve would put every cache hit a microtask late and bring the placeholder
		// back. A vault that does configure a preamble opts into the async path.
		if (prepared instanceof Promise) {
			return prepared.then((spec) => attach(spec, el, ctx, deps));
		}
		return attach(prepared, el, ctx, deps);
	};
}

function attach(
	spec: TexJobSpec,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	deps: ProcessorDeps,
): Promise<void> {
	deps.onBlock?.(spec);
	{
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
	}
}

/** What deriving a block's key needs — everything but the block's place on the page. */
export type KeyDeps = Pick<ProcessorDeps, 'settings' | 'budgets' | 'host' | 'preamble'>;

/**
 * The cache key a block with this source has in this note: the processor's own derivation, run
 * without a block.
 *
 * For the commands, which find a diagram by scanning the note's markdown. They used to look the
 * key up in a map the processor filled, keyed on the source text — which only knew blocks a view
 * had already processed this session (never one in Source mode, nor one the cursor was resting in
 * when the note opened), grew with every edit, and was keyed on a form of the text the scanner does
 * not produce. Deriving it here, from `asProcessorSource` of the scanned text, cannot drift from the
 * processor, because it is the processor.
 */
export function keyFor(source: string, notePath: string, deps: KeyDeps): string | Promise<string> {
	const prepared = prepare(source, deps, notePath, false);
	return prepared instanceof Promise ? prepared.then((spec) => spec.key) : prepared.key;
}

/**
 * The finished markup of a block found by scanning a note, or null when it has not been rendered on
 * this device.
 *
 * L1 first, then L2: memory is empty after a restart, after the phone was backgrounded, and for any
 * diagram it evicted, and the commands used to say such a diagram had never been rendered. Never
 * L3 — a legacy record has not been through the pipeline, so it is not something to hand out.
 */
export async function renderedMarkup(
	scanned: string,
	notePath: string,
	deps: KeyDeps & { cache: DiagramCache },
): Promise<string | null> {
	const key = await keyFor(asProcessorSource(scanned), notePath, deps);
	let artifact = deps.cache.peek(key);
	if (!artifact) {
		try {
			artifact = (await deps.cache.lookup(key, null))?.artifact;
		} catch {
			artifact = undefined;
		}
	}
	return artifact ? standaloneMarkup(artifact) : null;
}

/**
 * Whether a block on screen would be built differently under `next` than under `previous` — so
 * whether the open notes have to be processed again to show a settings change.
 *
 * Every setting the processor reads into a block's key, its presentation or its warnings. Not the
 * time limit, the log capture or the legacy import: they only change what the NEXT compile or
 * lookup does, and the time limit is a text field — each keystroke is a save.
 */
export function rendersDifferently(previous: TikzSettings, next: TikzSettings): boolean {
	return (
		previous.colors !== next.colors ||
		previous.lazy !== next.lazy ||
		previous.svgo !== next.svgo ||
		previous.fast !== next.fast ||
		previous.sourceHandling !== next.sourceHandling ||
		previous.preamblePath !== next.preamblePath ||
		previous.autoPreambleName !== next.autoPreambleName ||
		previous.preflight !== next.preflight
	);
}

/** Returns the spec directly when nothing has to be read from the vault, a promise when it does. */
function prepare(
	source: string,
	deps: KeyDeps,
	notePath: string,
	isExport: boolean,
): TexJobSpec | Promise<TexJobSpec> {
	// Once, so a block whose preamble resolves after a settings change is still built from one
	// set of settings rather than half of each.
	const settings = deps.settings();
	const parsed = parseDirectives(source, defaultOptions(settings, deps.budgets));

	const needsPreamble =
		parsed.preamblePath !== null ||
		parsed.inputs.length > 0 ||
		settings.preamblePath !== '' ||
		settings.autoPreambleName !== '';

	if (!needsPreamble) return buildSpec(parsed, settings, deps, isExport, null);

	return deps.preamble
		.resolve({
			globalPath: settings.preamblePath || null,
			walkUpName: settings.autoPreambleName,
			blockPath: parsed.preamblePath,
			inputs: parsed.inputs,
			notePath,
		})
		.then((resolved) => buildSpec(parsed, settings, deps, isExport, resolved));
}

function buildSpec(
	parsed: ReturnType<typeof parseDirectives>,
	settings: TikzSettings,
	deps: KeyDeps,
	isExport: boolean,
	resolved: Awaited<ReturnType<PreambleService['resolve']>> | null,
): TexJobSpec {
	const { budgets } = deps;
	const options = parsed.options;

	if (resolved) {
		options.baked.preamble = resolved.text;
		options.baked.depHashes = resolved.depHashes;
	}

	const normalized =
		settings.sourceHandling === 'legacy'
			? legacyTidyTikzSource(parsed.body)
			: normalizeSource(parsed.body);

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
			...(options.baked.twoPass ? { twoPass: true } : {}),
		},
		legacySource: legacySourceFor(parsed.body, options.baked, settings),
		timeoutMs,
		isExport,
		preflight: [
			// A missing preamble file or an include cycle is a diagnostic in its own right, shown
			// beside the diagram. PR #77's author conceded that theirs spliced an empty string and
			// said nothing; not repeating that is the point of the resolver.
			...(resolved?.diagnostics ?? []),
			...(settings.preflight && !options.fast
				? preflight(normalized, options.baked, deps.host.capabilities)
				: []),
		],
	};
}

function preambleFor(baked: BakedOptions): string {
	const border = baked.border === null ? '' : `\\standaloneconfig{border=${baked.border}}`;
	return `${baked.preamble}${border}`;
}

/**
 * The L3 gate, stated precisely (internal/DESIGN.md §8.3).
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
	if (baked.twoPass) return null;
	if (baked.border !== null) return null;
	if (baked.preamble !== '') return null;
	if (baked.libraries !== '') return null;
	if (Object.keys(baked.packages).length > 0) return null;
	if (settings.preamblePath !== '') return null;
	return body;
}

/** What a block gets before its own `%!tikz` lines are read: the settings, under the budgets. */
function defaultOptions(settings: TikzSettings, budgets: Budgets): BlockOptions {
	const timeoutMs = settingTimeoutMs(settings, budgets);
	return {
		baked: {
			border: null,
			packages: {},
			libraries: '',
			preamble: '',
			depHashes: [],
			wrap: 'auto',
			twoPass: false,
		},
		presentation: {
			colors: settings.colors,
			lazy: settings.lazy,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		},
		raw: false,
		nocache: false,
		fast: settings.fast,
		warnings: [],
	};
}

/** The time limit setting in ms, capped where the platform caps it; undefined for the budget's own. */
function settingTimeoutMs(settings: TikzSettings, budgets: Budgets): number | undefined {
	if (!(settings.timeoutSeconds > 0)) return undefined;
	const ms = settings.timeoutSeconds * 1000;
	return budgets.timeoutSettingCapMs === null ? ms : Math.min(ms, budgets.timeoutSettingCapMs);
}
