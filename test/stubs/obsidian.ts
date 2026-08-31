/**
 * Runtime stub for the `obsidian` module, aliased in vitest.config.ts.
 *
 * The real package is types-only at runtime, so anything importing it in a test would otherwise
 * fail to resolve. Core modules are written not to need this at all — if a test pulls it in, that
 * is a signal the module under test has drifted into the platform layer.
 */
export class Component {
	onload(): void {}
	onunload(): void {}
}
export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}
export class Notice {
	constructor(public message: string | DocumentFragment, public duration?: number) {}
	hide(): void {}
}
export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false };
