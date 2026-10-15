import type { App, MarkdownPostProcessorContext } from 'obsidian';
import type { BakedOptions, BlockOptions, ColorMode, TexHost, TexResult } from '../types';
import { normalizeSource } from '../source/normalize';
import { legacyTidyTikzSource } from '../source/legacy-tidy';
import { parseDirectives } from '../source/directives';
import { preflight } from '../source/preflight';
import { deriveKey, OUTPUT_REVISION } from '../cache/key';
import { isExportContext } from '../platform/context';
import { artifactRevision, type TikzSettings } from '../settings/schema';
import { TikzBlock, type BlockDeps, type BlockOutcome, type TexJobSpec } from './render-child';
import type { Making } from './edits';
import { standaloneMarkup } from './mount';
import { asProcessorSource, asReadingView } from '../note/finalize';
import type { QueueTimers, RenderQueue } from '../queue/queue';
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
	/** For the deadline of a PDF export's total budget. */
	timers: QueueTimers;
	preamble: PreambleService;
	/**
	 * Asked as a block of the note at this path is made (block/edits.ts RecentEdits.making): its cache
	 * miss asks whether the block was made by typing in the note, and so waits for the typing to pause
	 * if it is not cached, and which edit that was; its load and unload say when its text is on screen
	 * in the note, and its coming to rest whether the cache holds its diagram. Omitted: no note ever
	 * is typed in.
	 */
	editing?: ((notePath: string) => Making) | undefined;
	/** Start the engine ahead of the first job (BlockDeps.startEngine). Omitted: it starts with the job. */
	startEngine?: ((doc: Document) => void) | undefined;
	/**
	 * Notified of every block, so the debug view can list what happened without the child knowing
	 * about it. What it returns, if anything, is told how the block comes to rest.
	 */
	onBlock?:
		((spec: TexJobSpec, el: HTMLElement) => ((outcome: BlockOutcome) => void) | undefined) | undefined;
}

/**
 * The off-screen container "Render all diagrams in this note" renders a note into. A block inside
 * it is there to be rendered, now: no viewport will ever see it.
 */
export const OFFSCREEN_CLASS = 'tikzjax-offscreen';

/** Where a block is on the page, as far as its spec is concerned. */
interface Place {
	isExport: boolean;
	/** Inside a PDF export, and so under its total budget. */
	budgeted: boolean;
	/** Inside the off-screen container: rendered eagerly, whatever its lazy mode. */
	offscreen: boolean;
}

/**
 * How the blocks rendered inside one container came to rest. "Render all diagrams in this note"
 * counts its own run with one.
 *
 * It used to count the diagnostics ring instead: entries written when each block was processed,
 * before anything had happened to it, so always "rendering" and never a failure — and once the
 * ring was full at a hundred, the slice it counted was empty and every run "rendered 0".
 */
export class BlockTally {
	private readonly container: HTMLElement;
	/** The last word from each block, by the order they were seen; null until it comes to rest. */
	private readonly last: (BlockOutcome['state'] | null)[] = [];

	constructor(container: HTMLElement) {
		this.container = container;
	}

	/** A listener for one block's outcomes, if the block is inside this container. */
	watch(el: HTMLElement): ((outcome: BlockOutcome) => void) | undefined {
		if (!this.container.contains(el)) return undefined;
		const index = this.last.push(null) - 1;
		return (outcome) => {
			this.last[index] = outcome.state;
		};
	}

	/**
	 * Rendered: on screen, compiled or from a cache. Everything else did not — a card, a button,
	 * and a block cancelled before it came to rest.
	 */
	counts(): { ok: number; failed: number } {
		let ok = 0;
		for (const state of this.last) if (state === 'ok' || state === 'cached') ok++;
		return { ok, failed: this.last.length - ok };
	}
}

export function createProcessor(deps: ProcessorDeps) {
	/**
	 * When each PDF export stops waiting, keyed by the export's `.print` container: every block of
	 * one export is rendered into it, and the budget is for the export as a whole.
	 *
	 * Weak, so a finished export's popup is not kept alive by its entry here. Keyed by the
	 * container rather than by the document, which would also catch a pop-out window — open for
	 * hours, and no export at all.
	 */
	const exportDeadlines = new WeakMap<Element, number>();
	/**
	 * The blocks made so far: each block's place in the queue's order inside its band. Obsidian makes
	 * the blocks of a view from the top down, Live Preview's widgets and Reading view's sections alike,
	 * so as a note opens the block made first is the highest; and a block is submitted once its cache
	 * has been read, which takes each block its own time (internal/DECISIONS.md D40). A block made
	 * later, by an edit or by scrolling up, is numbered later, wherever it is.
	 */
	let made = 0;

	return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
		// printToPdf builds its `.print` container and puts the note in it before it runs any
		// processor (read in the 1.14.4 bundle), so this finds it.
		const print = el.closest('.print');
		let deadline: number | undefined;
		if (print) {
			deadline = exportDeadlines.get(print);
			if (deadline === undefined) {
				deadline = deps.now() + deps.budgets.exportTotalBudgetMs;
				exportDeadlines.set(print, deadline);
			}
		}

		const place: Place = {
			isExport: isExportContext(deps.app, el),
			budgeted: print !== null,
			offscreen: el.closest(`.${OFFSCREEN_CLASS}`) !== null,
		};
		// Whether an edit made this block is told by what came before it and in this same run, not by
		// what comes while its cache is read (block/edits.ts): so asked here, before anything yields.
		// Its text is on screen in the note from this run, once it is loaded (D40).
		const editing = deps.editing?.(ctx.sourcePath);
		const order = ++made;
		const prepared = prepare(readingViewSource(source, el, ctx), deps, ctx.sourcePath, place);

		// The common case — no preamble configured anywhere — stays SYNCHRONOUS, and that is not an
		// optimisation. A cached diagram is only painted in the same frame as the text around it if
		// the child is created before this function yields; one `await` on a resolution that had
		// nothing to resolve would put every cache hit a microtask late and bring the placeholder
		// back. A vault that does configure a preamble opts into the async path.
		if (prepared instanceof Promise) {
			return prepared.then((spec) => attach(spec, el, ctx, deps, deadline, editing, order));
		}
		return attach(prepared, el, ctx, deps, deadline, editing, order);
	};
}

/**
 * The block's text as Reading view hands it over, whichever view is rendering it.
 *
 * Live Preview's code-block widget hands the processor the editor's lines between the two fences
 * exactly as they stand, so a block in a list item arrives with the list's indentation on every
 * line. Reading view, a PDF export and a callout hand over the code block's content, which the
 * markdown parser has already taken that indentation off (both read in the 1.14.4 bundle). The
 * source keeps leading whitespace into the key, so the one diagram had a key in each view: it was
 * compiled twice, and the commands, which derive Reading view's, said a diagram on screen in Live
 * Preview had not been rendered.
 *
 * The widget's getSectionInfo answers with the whole note and the two fence lines, and then the
 * lines between them are `source` exactly. Only then is anything taken off, and only what Reading
 * view takes (`asReadingView`), so two blocks that differ in Reading view still differ here. Every
 * other caller has handed over the code block's content already: Reading view's section is the
 * whole list, and an export or an embed has none.
 *
 * TeX sees the same text in both views now. What differs is whitespace at the start of a line,
 * which TeX skips, so a diagram draws as it did; only where a block reads spaces as text, in a
 * verbatim environment, did Live Preview show something Reading view and the PDF did not.
 */
function readingViewSource(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): string {
	// No line starts with a space or a tab, so there is nothing to take off: the usual block,
	// which is spared reading the note.
	if (!/^[ \t]/m.test(source)) return source;
	const section = ctx.getSectionInfo(el);
	if (!section) return source;
	const lines = linesOf(section.text, section.lineStart, section.lineEnd);
	if (lines.length < 2 || lines.slice(1, -1).join('\n') !== source) return source;
	return asReadingView(lines[0] ?? '', source) ?? source;
}

/** Lines `from` to `to` of `text`, both included; fewer when the text ends first. */
function linesOf(text: string, from: number, to: number): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let line = 0; line <= to; line++) {
		const end = text.indexOf('\n', start);
		if (line >= from) lines.push(text.slice(start, end === -1 ? text.length : end));
		if (end === -1) break;
		start = end + 1;
	}
	return lines;
}

function attach(
	spec: TexJobSpec,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	deps: ProcessorDeps,
	deadline: number | undefined,
	editing: Making | undefined,
	order: number,
): Promise<void> {
	const report = deps.onBlock?.(spec, el);
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
			editing: editing === undefined ? undefined : () => editing.by(spec.key),
			shown: editing === undefined ? undefined : () => editing.shown(spec.key),
			rested: editing === undefined ? undefined : (cached) => editing.rested(spec.key, cached),
			startEngine: deps.startEngine,
			place: order,
			now: deps.now,
			report,
		});

		// A change to a preamble file has to reach the blocks built from it — for as long as they
		// are on the page, and no longer. Each entry is `path:hash`, and a path may itself hold a
		// colon, so the hash is what follows the last one.
		const files = spec.options.baked.depHashes.map((d) => d.slice(0, d.lastIndexOf(':')));
		if (files.length > 0) {
			deps.preamble.track(spec.key, files);
			child.register(() => deps.preamble.untrack(spec.key, files));
		}

		// Obsidian owns load()/unload() from here, which is what ties cancellation to the block's
		// real lifetime instead of to a guess about when a section went away.
		ctx.addChild(child);
		if (deadline !== undefined) expireAt(child, deadline, deps);
		return child.settled;
	}
}

/**
 * Hold one block of a PDF export to the export's deadline (budgets.ts `exportTotalBudgetMs`).
 *
 * Obsidian's export waits on every block's promise and has no timeout of its own, and each block
 * was bounded only by its own 30 s, one after another in the one engine: forty uncached diagrams
 * held "Preparing PDF" for up to twenty minutes. At the deadline every block still waiting rests
 * on a card that says it was not ready in time — the PDF prints that in its place — and the export
 * goes ahead. A block that comes to rest first takes its timer with it.
 */
function expireAt(child: TikzBlock, deadline: number, deps: ProcessorDeps): void {
	const id = deps.timers.setTimeout(() => child.expire(), Math.max(0, deadline - deps.now()));
	void child.settled.then(() => deps.timers.clearTimeout(id));
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
 * processor, because it is the processor. The scanned text is Reading view's, and a block Live
 * Preview hands over with a list's indentation is made Reading view's before its key is derived
 * (`readingViewSource`), so the block has the one key in both views.
 */
export function keyFor(source: string, notePath: string, deps: KeyDeps): string | Promise<string> {
	const prepared = specFor(source, notePath, deps);
	return prepared instanceof Promise ? prepared.then((spec) => spec.key) : prepared.key;
}

function specFor(source: string, notePath: string, deps: KeyDeps): TexJobSpec | Promise<TexJobSpec> {
	return prepare(source, deps, notePath, { isExport: false, budgeted: false, offscreen: false });
}

/** A rendered diagram taken out of the note, and the colour mode its block shows it in. */
export interface RenderedDiagram {
	markup: string;
	/** Not in the stored artifact, which is the same for every mode: the block's, or the setting. */
	colors: ColorMode;
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
): Promise<RenderedDiagram | null> {
	const spec = await specFor(asProcessorSource(scanned), notePath, deps);
	let artifact = deps.cache.peek(spec.key);
	if (!artifact) {
		try {
			artifact = (await deps.cache.lookup(spec.key, null))?.artifact;
		} catch {
			artifact = undefined;
		}
	}
	if (!artifact) return null;
	return { markup: standaloneMarkup(artifact), colors: spec.options.presentation.colors ?? 'adapt' };
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
	place: Place,
): TexJobSpec | Promise<TexJobSpec> {
	// Once, so a block whose preamble resolves after a settings change is still built from one
	// set of settings rather than half of each.
	const settings = deps.settings();
	const parsed = parseDirectives(source, defaultOptions(settings));

	const needsPreamble =
		parsed.preamblePath !== null ||
		parsed.inputs.length > 0 ||
		settings.preamblePath !== '' ||
		settings.autoPreambleName !== '';

	if (!needsPreamble) return buildSpec(parsed, settings, deps, place, null);

	return deps.preamble
		.resolve({
			globalPath: settings.preamblePath || null,
			walkUpName: settings.autoPreambleName,
			blockPath: parsed.preamblePath,
			inputs: parsed.inputs,
			notePath,
		})
		.then((resolved) => buildSpec(parsed, settings, deps, place, resolved));
}

function buildSpec(
	parsed: ReturnType<typeof parseDirectives>,
	settings: TikzSettings,
	deps: KeyDeps,
	place: Place,
	resolved: Awaited<ReturnType<PreambleService['resolve']>> | null,
): TexJobSpec {
	const { budgets } = deps;
	const { isExport } = place;
	const options = parsed.options;

	if (resolved) {
		options.baked.preamble = resolved.text;
		options.baked.depHashes = resolved.depHashes;
	}

	// Rendered into the off-screen container to be waited for, so not lazily: in there, a block
	// waiting to be scrolled into view waits for good. The real IntersectionObserver reports the
	// container as not intersecting, which also cancels the zero-record escape hatch, so the
	// command's wait never ended. `manual` too — running the command is the user asking. Lazy mode
	// is presentation, not in the key, so this costs nothing in the cache.
	if (place.offscreen) options.presentation.lazy = 'off';

	const normalized =
		settings.sourceHandling === 'legacy'
			? legacyTidyTikzSource(parsed.body)
			: normalizeSource(parsed.body);

	const svgo = parsed.svgo ?? settings.svgo;
	const key = deriveKey({
		normalizedSource: normalized,
		baked: options.baked,
		outputRevision: OUTPUT_REVISION,
		artifactRevision: artifactRevision(settings),
		pipeline: {
			raw: options.raw,
			fast: options.fast,
			svgo,
		},
	});

	const timeoutMs = isExport
		? budgets.exportBlockTimeoutMs
		: (options.presentation.timeoutMs ?? budgets.timeoutMs);

	return {
		key,
		source: normalized,
		options,
		svgo,
		texOptions: {
			...(Object.keys(options.baked.packages).length ? { texPackages: options.baked.packages } : {}),
			...(options.baked.libraries ? { tikzLibraries: options.baked.libraries } : {}),
			...(preambleFor(options.baked) ? { addToPreamble: preambleFor(options.baked) } : {}),
			wrap: options.baked.wrap,
			captureLog: settings.captureLog,
			...(options.baked.twoPass ? { twoPass: true } : {}),
		},
		preambleLines: resolved?.lines ?? [],
		legacySource: legacySourceFor(parsed.body, options.baked, settings),
		timeoutMs,
		isExport,
		// Each is bounded some other way: an export by its total budget, a warm run by its Stop.
		uncapped: place.budgeted || place.offscreen,
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

/** What a block gets before its own `%!tikz` lines are read: the settings. */
function defaultOptions(settings: TikzSettings): BlockOptions {
	const timeoutMs = settingTimeoutMs(settings);
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

/**
 * The time limit setting in ms; undefined for the platform budget's own.
 *
 * Not capped on a phone. The phone is the slower device, so a limit raised for heavy diagrams is
 * wanted there most. The clock starts only when the engine takes the job (queue.ts, `startupMs`)
 * and the worker runs one job at a time, so a long limit can delay the diagrams waiting behind it
 * but cannot make them fail.
 */
function settingTimeoutMs(settings: TikzSettings): number | undefined {
	return settings.timeoutSeconds > 0 ? settings.timeoutSeconds * 1000 : undefined;
}
