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
	private readonly observers = new Map<Element | Document, IntersectionObserver>();
	private readonly callbacks = new WeakMap<Element, Callback>();
	private readonly sawRecord = new WeakSet<Element>();
	private readonly escapeTimers = new WeakMap<Element, number>();
	private readonly options: ViewportGateOptions;

	constructor(options: ViewportGateOptions) {
		this.options = options;
	}

	observe(el: HTMLElement, onChange: Callback): void {
		this.callbacks.set(el, onChange);

		const root = this.scrollRootFor(el);
		let observer = this.observers.get(root ?? el.doc);
		if (!observer) {
			observer = new IntersectionObserver((entries) => this.handle(entries), {
				root: root ?? null,
				rootMargin: `${this.options.rootMarginPx}px`,
			});
			this.observers.set(root ?? el.doc, observer);
		}
		observer.observe(el);

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
			const timer = this.escapeTimers.get(el);
			if (timer !== undefined) {
				this.options.clearTimeout(timer);
				this.escapeTimers.delete(el);
			}
			this.callbacks.get(el)?.(entry.isIntersecting);
		}
	}

	unobserve(el: HTMLElement): void {
		for (const observer of this.observers.values()) observer.unobserve(el);
		this.callbacks.delete(el);
		const timer = this.escapeTimers.get(el);
		if (timer !== undefined) {
			this.options.clearTimeout(timer);
			this.escapeTimers.delete(el);
		}
	}

	disconnect(): void {
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
	}

	/**
	 * Obsidian scrolls inside `.markdown-preview-view` / `.cm-scroller`, not the document. Using the
	 * right root keeps rootMargin meaningful; falling back to the viewport is correct but coarser.
	 */
	private scrollRootFor(el: HTMLElement): Element | null {
		return el.closest('.markdown-preview-view, .cm-scroller, .view-content');
	}
}
