import type { Budgets } from '../types';

/**
 * Every time and size limit in the plugin, in one table. See internal/DESIGN.md §5.4.
 *
 * These are not tuning knobs scattered through the code; they are a policy, and having them in one
 * place is what makes "why did this diagram not render" answerable.
 */

const DESKTOP: Budgets = {
	/**
	 * One, because there is one worker and it runs one TeX job at a time: a job runs to completion
	 * inside a single message task. This used to be 2, which bought no parallelism at all — the
	 * second job sat in the worker's queue while its timeout ran, so a heavy diagram could time out
	 * an innocent neighbour, and that timeout's terminate took the neighbour down with it. A second
	 * worker WOULD run in parallel, but costs a second ~156 MiB core dump and a second boot, for a
	 * path that only matters until the diagrams are cached.
	 */
	concurrency: 1,
	timeoutMs: 10_000,
	timeoutSettingCapMs: null,
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
	 * A block inside a collapsed callout, a hidden tab or a `display:none` ancestor never receives
	 * an IntersectionObserver record at all. Without this escape hatch it would sit behind a
	 * permanent placeholder — a new class of blank-diagram bug introduced by lazy rendering itself.
	 */
	zeroRecordEscapeMs: 2_000,
	debounceMs: 300,
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
	 * Hard-clamped to 1, and not offered as a preference. Each worker retains the full core dump —
	 * 2500 pages = 156.25 MiB — so two workers is ~312 MiB resident inside one WKWebView content
	 * process whose measured ceiling ranges from ~100 MB on an iPhone SE3 to ~450 MB. Upstream
	 * #111, #91, #74 are all this.
	 */
	concurrency: 1,
	timeoutMs: 20_000,
	/**
	 * The time limit setting may lower the limit on a phone, not raise it. The setting syncs between
	 * devices, and a limit chosen for a desktop's heavy diagrams would let one diagram hold the
	 * phone's only engine — and its ~156 MiB — for that long, with every other diagram waiting. A
	 * block's own `%!tikz timeout=` is not capped: it is a decision about that one diagram, and the
	 * timeout card is what tells the user to write it.
	 */
	timeoutSettingCapMs: 20_000,
	firstJobGraceMs: 30_000,
	exportBlockTimeoutMs: 30_000,
	exportTotalBudgetMs: 60_000,
	queueDepthCap: 16,
	rootMarginPx: 400,
	zeroRecordEscapeMs: 2_000,
	debounceMs: 500,
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
