/**
 * Runtime stub for the `obsidian` module, aliased in vitest.config.ts.
 *
 * The real package is types-only at runtime, so anything importing it in a test would otherwise
 * fail to resolve. Core modules are written not to need this at all — if a test pulls it in, that
 * is a signal the module under test has drifted into the platform layer.
 *
 * No constructor parameter properties: `erasableSyntaxOnly` forbids them project-wide, and this
 * file is typechecked with everything else.
 */
/**
 * Obsidian's lifecycle, as far as the plugin leans on it: `load` runs `onload` and then loads the
 * children, `unload` unloads the children, runs what was registered, then `onunload`, and a child
 * added to a loaded parent is loaded on the spot — which is what `ctx.addChild` does to a block.
 */
export class Component {
	private loaded = false;
	private readonly children: Component[] = [];
	private readonly cleanups: (() => void)[] = [];

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
		for (const child of this.children) child.load();
	}

	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of this.children.splice(0)) child.unload();
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		this.onunload();
	}

	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		if (this.loaded) child.load();
		return child;
	}

	register(cleanup: () => void): void {
		this.cleanups.push(cleanup);
	}

	onload(): void {}
	onunload(): void {}
}

export class MarkdownRenderChild extends Component {
	containerEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		super();
		this.containerEl = containerEl;
	}
}

/** Every notice shown, in order, so a test can read what the user was told. */
export const shownNotices: Notice[] = [];

export class Notice {
	message: string | DocumentFragment;
	duration: number | undefined;
	hidden = false;
	constructor(message: string | DocumentFragment, duration?: number) {
		this.message = message;
		this.duration = duration;
		shownNotices.push(this);
	}
	hide(): void {
		this.hidden = true;
	}
}

/** Only so that modules defining a modal or naming a view type load; nothing here opens one. */
export class Modal {
	app: unknown;
	constructor(app: unknown) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
}

export class MarkdownView {}

export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false };

/**
 * Just enough of a vault file for the `instanceof TFile` checks the preamble service makes. The
 * real class is never constructed by a plugin, so the constructor here is the stub's own.
 */
export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	constructor(path: string) {
		this.path = path;
		this.name = path.slice(path.lastIndexOf('/') + 1);
		const dot = this.name.lastIndexOf('.');
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
	}
}
