/**
 * Obsidian's DOM extensions, as much of them as the plugin actually uses.
 *
 * Obsidian patches `HTMLElement.prototype` with `createDiv`, `addClass`, `empty` and friends, and
 * adds a `doc` getter. None of that exists in happy-dom, so anything touching the DOM was
 * untestable until now — which is why the block lifecycle, the most intricate piece in the plugin,
 * had no coverage while ten pure modules had 373 tests between them.
 *
 * Deliberately faithful rather than convenient: `createDiv` returns the CHILD, not the parent, and
 * `empty()` removes children rather than clearing innerHTML. A stub that got either backwards
 * would let a broken implementation pass.
 */

interface DomElementInfo {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string>;
}

export function installObsidianDom(window: Window & typeof globalThis): void {
	const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
	const nodeProto = window.Node.prototype as unknown as Record<string, unknown>;

	const applyInfo = (el: HTMLElement, info?: DomElementInfo | string): void => {
		if (info === undefined) return;
		if (typeof info === 'string') {
			el.className = info;
			return;
		}
		if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
		if (info.text !== undefined) el.textContent = info.text;
		if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttribute(k, v);
	};

	proto['createEl'] = function (this: HTMLElement, tag: string, info?: DomElementInfo): HTMLElement {
		const el = this.ownerDocument.createElement(tag);
		applyInfo(el, info);
		this.appendChild(el);
		return el;
	};

	proto['createDiv'] = function (this: HTMLElement, info?: DomElementInfo | string): HTMLElement {
		return (proto['createEl'] as (t: string, i?: unknown) => HTMLElement).call(this, 'div', info);
	};

	proto['createSpan'] = function (this: HTMLElement, info?: DomElementInfo | string): HTMLElement {
		return (proto['createEl'] as (t: string, i?: unknown) => HTMLElement).call(this, 'span', info);
	};

	proto['addClass'] = function (this: HTMLElement, ...classes: string[]): void {
		this.classList.add(...classes);
	};
	proto['removeClass'] = function (this: HTMLElement, ...classes: string[]): void {
		this.classList.remove(...classes);
	};
	proto['empty'] = function (this: HTMLElement): void {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto['setText'] = function (this: HTMLElement, text: string): void {
		this.textContent = text;
	};

	// `el.doc` and `el.win`, which the plugin uses instead of the globals so a pop-out or the PDF
	// export popup resolves to ITS document rather than the focused one.
	if (!Object.getOwnPropertyDescriptor(nodeProto, 'doc')) {
		Object.defineProperty(nodeProto, 'doc', {
			get(this: Node) {
				return this.ownerDocument ?? window.document;
			},
			configurable: true,
		});
	}
	if (!Object.getOwnPropertyDescriptor(nodeProto, 'win')) {
		Object.defineProperty(nodeProto, 'win', {
			get() {
				return window;
			},
			configurable: true,
		});
	}
}
