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
export class Component {
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

export class Notice {
	message: string | DocumentFragment;
	duration: number | undefined;
	constructor(message: string | DocumentFragment, duration?: number) {
		this.message = message;
		this.duration = duration;
	}
	hide(): void {}
}

export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false };
