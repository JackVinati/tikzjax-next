import type { Budgets } from '../types';

/**
 * Every time and size limit in the plugin, in one table. See docs/DESIGN.md §5.4.
 *
 * These are not tuning knobs scattered through the code; they are a policy, and having them in one
 * place is what makes "why did this diagram not render" answerable.
 */

const DESKTOP: Budgets = {
	concurrency: 2,
	timeoutMs: 10_000,
	/** The first job also pays for engine boot: base64 decode + inflate + wasm compile, ~600 ms. */
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

export function budgetsFor(isMobile: boolean, hardwareConcurrency: number): Budgets {
	if (isMobile) return { ...MOBILE };
	return { ...DESKTOP, concurrency: Math.max(1, Math.min(DESKTOP.concurrency, hardwareConcurrency - 1)) };
}

/** Applied when the user opts a block into fast mode, or the whole plugin into it. */
export function applyFastMode(budgets: Budgets): Budgets {
	return budgets;
}
