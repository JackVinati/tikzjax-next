/**
 * Viewport gating. See internal/DESIGN.md §7.1.
 *
 * One IntersectionObserver per scroll root, pooled — never a document-wide scanner. The shipped
 * plugin's engine installs a MutationObserver on `document.body`, which fires on every keystroke
 * anywhere in the app, including in the file explorer.
 */

export interface ViewportGateOptions {
	rootMarginPx: number;
	/**
	 * A block inside a collapsed callout, a hidden tab, a `display:none` ancestor, or a reading-view
	 * section Obsidian has detached receives NO IntersectionObserver record at all — not even a
	 * non-intersecting one. Without a timeout it would sit behind a placeholder forever: a new class
	 * of blank-diagram bug introduced by lazy rendering itself. So after this long with zero records
	 * we give up waiting and schedule it at the lowest priority.
	 */
	zeroRecordEscapeMs: number;
	setTimeout: (fn: () => void, ms: number) => number;
	clearTimeout: (id: number) => void;
}

type Callback = (visible: boolean) => void;

export class ViewportGate {
	/**
	 * One observer per scroll root, with the number of blocks it is watching, and given up at zero.
	 *
	 * They used to be dropped only when the plugin unloaded. An observer keeps its root alive, so
	 * every closed tab and every hover preview that ever held an uncached diagram kept its whole
	 * detached view in memory for the rest of the session.
	 */
	private readonly roots = new Map<
		Element | Document,
		{ observer: IntersectionObserver; blocks: number }
	>();
	/** The root each observed block is counted under, so that letting it go finds the same one. */
	private readonly rootOf = new WeakMap<Element, Element | Document>();
	private readonly callbacks = new WeakMap<Element, Callback>();
	private readonly sawRecord = new WeakSet<Element>();
	private readonly escapeTimers = new WeakMap<Element, number>();
	private readonly options: ViewportGateOptions;

	constructor(options: ViewportGateOptions) {
		this.options = options;
	}

	observe(el: HTMLElement, onChange: Callback): void {
		this.callbacks.set(el, onChange);

		if (!this.rootOf.has(el)) {
			const root = this.scrollRootFor(el);
			const key = root ?? el.doc;
			let entry = this.roots.get(key);
			if (!entry) {
				const observer = new IntersectionObserver((entries) => this.handle(entries), {
					root: root ?? null,
					rootMargin: `${this.options.rootMarginPx}px`,
				});
				entry = { observer, blocks: 0 };
				this.roots.set(key, entry);
			}
			entry.blocks++;
			entry.observer.observe(el);
			this.rootOf.set(el, key);
		}

		this.clearEscape(el);
		const timer = this.options.setTimeout(() => {
			if (this.sawRecord.has(el)) return;
			// Never observed at all. Treat as "render it anyway, at the back of the queue".
			this.callbacks.get(el)?.(true);
		}, this.options.zeroRecordEscapeMs);
		this.escapeTimers.set(el, timer);
	}

	private handle(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			const el = entry.target as HTMLElement;
			this.sawRecord.add(el);
			this.clearEscape(el);
			this.callbacks.get(el)?.(entry.isIntersecting);
		}
	}

	unobserve(el: HTMLElement): void {
		const key = this.rootOf.get(el);
		if (key !== undefined) {
			this.rootOf.delete(el);
			const entry = this.roots.get(key);
			if (entry) {
				entry.observer.unobserve(el);
				entry.blocks--;
				if (entry.blocks <= 0) {
					entry.observer.disconnect();
					this.roots.delete(key);
				}
			}
		}
		this.callbacks.delete(el);
		this.clearEscape(el);
	}

	disconnect(): void {
		for (const { observer } of this.roots.values()) observer.disconnect();
		this.roots.clear();
	}

	private clearEscape(el: Element): void {
		const timer = this.escapeTimers.get(el);
		if (timer !== undefined) {
			this.options.clearTimeout(timer);
			this.escapeTimers.delete(el);
		}
	}

	/**
	 * Obsidian scrolls inside `.markdown-preview-view` / `.cm-scroller`, not the document. Using the
	 * right root keeps rootMargin meaningful; falling back to the viewport is correct but coarser.
	 */
	private scrollRootFor(el: HTMLElement): Element | null {
		return el.closest('.markdown-preview-view, .cm-scroller, .view-content');
	}
}
