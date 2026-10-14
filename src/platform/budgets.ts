import type { Budgets } from '../types';
import type { WebViewFeatures } from './device';

/**
 * Every time and size limit in the plugin, in one table. See internal/DESIGN.md §5.4.
 *
 * These are not tuning knobs scattered through the code; they are a policy, and having them in one
 * place is what makes "why did this diagram not render" answerable.
 */

const DESKTOP: Budgets = {
	/**
	 * Two workers at most, each running one TeX job at a time (engine/worker-host.ts), and the queue
	 * runs as many jobs at once as there are workers. Until 0.2.1 it was one: a second job beside
	 * the first in ONE worker only waited in the worker's own queue with its clock running, and a
	 * second worker cost a second engine for a path that only matters until the diagrams are
	 * cached. Measured for 0.2.1 (internal/DECISIONS.md D24), two workers drew a note of 37 uncached
	 * diagrams in 54–55% of one worker's time, with 0.2.0's worker, in WebKit and Chromium on the
	 * desktop, for about 100 MB more at the peak (Node 22). The second starts only while a job
	 * waits that the first cannot take, both go when idle, and `engineCount` below leaves it out
	 * where it is turned off or the computer is short of memory.
	 */
	concurrency: 2,
	timeoutMs: 10_000,
	/**
	 * How long a job may wait for the engine to come up before its own `timeoutMs` starts.
	 *
	 * Booting is base64 decode + inflate + wasm compile, ~600 ms here and seconds on a phone, and it
	 * is not the diagram's work, so it is not counted against the diagram's budget (queue.ts,
	 * `startupMs`). A boot slower than this is presumed wedged: the job fails as "the engine could
	 * not start", never as a timeout, and its key is not poisoned.
	 */
	firstJobGraceMs: 20_000,
	exportBlockTimeoutMs: 30_000,
	/**
	 * Not optional. Obsidian's PDF export awaits `Promise.all(ctx.promises)` with no timeout of its
	 * own, so 40 uncached blocks at 30 s each would be a 20-minute uncancellable "Preparing PDF"
	 * modal. On expiry we mount error cards for whatever did not finish and resolve.
	 */
	exportTotalBudgetMs: 60_000,
	queueDepthCap: 64,
	rootMarginPx: 200,
	/**
	 * A block detached from the document never receives an IntersectionObserver record at all.
	 * Without this escape hatch it would sit behind a permanent placeholder — a new class of
	 * blank-diagram bug introduced by lazy rendering itself. (A collapsed callout or a background
	 * tab does get a record, and renders when shown: block/viewport.ts.)
	 */
	zeroRecordEscapeMs: 2_000,
	/**
	 * How long a block waits for typing to pause before it is compiled — only a block whose note is
	 * being typed in (block/edits.ts). Any other goes to the queue as soon as it is seen.
	 */
	debounceMs: 300,
	/**
	 * How long after a note's text changes a block of it that misses the cache is taken for one
	 * remade by the typing, and debounces (block/edits.ts). It has to cover the time from the
	 * keystroke to the block's cache miss: the same update in Live Preview, 10 ms and up to 200 ms
	 * more in a Reading view beside the editor (read in the 1.14.4 bundle), then an IndexedDB read.
	 * Too long costs nothing but the debounce, to a block that first appears in a note just typed in.
	 */
	editWindowMs: 1_000,
	l1Entries: 256,
	l1Bytes: 24 * 1024 * 1024,
	l2Bytes: 64 * 1024 * 1024,
	/**
	 * A worker with nothing to do is terminated after this long (engine/worker-host.ts), giving its
	 * core dump back. Long enough that reading through a note does not pay a boot per diagram.
	 */
	idleTeardownMs: 5 * 60_000,
};

const MOBILE: Budgets = {
	/**
	 * Hard-clamped to 1, and not offered as a preference. Each worker is an engine of its own, and
	 * each compile in it a new 156.25 MiB WebAssembly memory (DECISIONS.md D18), inside one WKWebView
	 * content process whose ceiling ranges from ~100 MB on an iPhone SE3 to ~450 MB. Upstream #111,
	 * #91, #74 are all this. A second worker on a phone waits for a measurement on one.
	 */
	concurrency: 1,
	timeoutMs: 20_000,
	firstJobGraceMs: 30_000,
	exportBlockTimeoutMs: 30_000,
	exportTotalBudgetMs: 60_000,
	queueDepthCap: 16,
	rootMarginPx: 400,
	zeroRecordEscapeMs: 2_000,
	debounceMs: 500,
	editWindowMs: 1_000,
	l1Entries: 64,
	l1Bytes: 8 * 1024 * 1024,
	l2Bytes: 24 * 1024 * 1024,
	/**
	 * Aggressive on purpose, and paired with teardown on `visibilitychange → hidden`: WebKit
	 * discards JIT code at 65% memory pressure and reloads the page at 100%, so being near zero
	 * while backgrounded is the difference between surviving and being jetsam-killed.
	 */
	idleTeardownMs: 30_000,
};

export function budgetsFor(isMobile: boolean): Budgets {
	return isMobile ? { ...MOBILE } : { ...DESKTOP };
}

/** Below this many GiB of memory, as `navigator.deviceMemory` reports it, a computer runs one engine. */
export const LOW_MEMORY_GIB = 8;

/** With memory unreported, below this many logical cores a computer runs one engine. */
export const FEW_CORES = 4;

/**
 * How many engines this device runs at once (internal/DECISIONS.md D24): the platform's
 * `concurrency`, unless the second engine is turned off in the settings, or the computer reports
 * less than 8 GiB of memory. Where it reports no memory figure at all, which Chromium withholds
 * outside a secure context, the cores decide instead: two engines compiling at once want two cores
 * of their own beside the one Obsidian draws on, so fewer than four keeps one. With neither figure,
 * a desktop keeps its two: the second starts only while diagrams queue up, and the setting turns it
 * off.
 */
export function engineCount(
	budgets: Budgets,
	secondEngine: boolean,
	webView: Pick<WebViewFeatures, 'memoryGiB' | 'cores'>,
): number {
	if (budgets.concurrency <= 1 || !secondEngine) return 1;
	if (webView.memoryGiB !== null) return webView.memoryGiB < LOW_MEMORY_GIB ? 1 : budgets.concurrency;
	if (webView.cores !== null && webView.cores < FEW_CORES) return 1;
	return budgets.concurrency;
}
