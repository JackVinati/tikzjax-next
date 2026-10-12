// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { FakeTimers } from './stubs/timers';
import { ViewportGate } from '../src/block/viewport';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/** An IntersectionObserver the test drives: it reports only when told to. */
class FakeObserver {
	static readonly live = new Set<FakeObserver>();
	readonly targets = new Set<Element>();
	private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void;

	constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
		this.callback = callback;
		FakeObserver.live.add(this);
	}

	observe(el: Element): void {
		this.targets.add(el);
	}

	unobserve(el: Element): void {
		this.targets.delete(el);
	}

	disconnect(): void {
		this.targets.clear();
		FakeObserver.live.delete(this);
	}

	report(el: Element, isIntersecting: boolean): void {
		this.callback([{ target: el, isIntersecting }]);
	}
}

beforeEach(() => {
	FakeObserver.live.clear();
	vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function gate(timers = new FakeTimers()): ViewportGate {
	return new ViewportGate({
		rootMarginPx: 200,
		zeroRecordEscapeMs: 2000,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
	});
}

const scrollRoot = (): HTMLElement => document.body.createDiv({ cls: 'markdown-preview-view' });

describe('ViewportGate', () => {
	it('shares one observer between the blocks of one scroll root', () => {
		const viewport = gate();
		const root = scrollRoot();
		viewport.observe(root.createDiv(), () => undefined);
		viewport.observe(root.createDiv(), () => undefined);
		expect(FakeObserver.live.size).toBe(1);
	});

	it('tells a block when it comes into view', () => {
		const viewport = gate();
		const block = scrollRoot().createDiv();
		const seen: boolean[] = [];
		viewport.observe(block, (visible) => seen.push(visible));

		[...FakeObserver.live][0]?.report(block, true);
		expect(seen).toEqual([true]);
	});

	/**
	 * The observers were kept by scroll root and dropped only when the plugin unloaded, so every
	 * closed tab and every hover preview that ever held an uncached diagram kept its whole detached
	 * view alive through the observer's root.
	 */
	it('lets go of a scroll root once nothing in it is observed', () => {
		const viewport = gate();
		const root = scrollRoot();
		const a = root.createDiv();
		const b = root.createDiv();
		viewport.observe(a, () => undefined);
		viewport.observe(b, () => undefined);

		viewport.unobserve(a);
		expect(FakeObserver.live.size).toBe(1);
		viewport.unobserve(b);
		expect(FakeObserver.live.size).toBe(0);

		// And a block arriving in it later is still observed.
		viewport.observe(root.createDiv(), () => undefined);
		expect(FakeObserver.live.size).toBe(1);
	});

	it('counts each block once, however often it is observed or let go', () => {
		const viewport = gate();
		const root = scrollRoot();
		const a = root.createDiv();
		const b = root.createDiv();
		viewport.observe(a, () => undefined);
		viewport.observe(a, () => undefined);
		viewport.observe(b, () => undefined);

		viewport.unobserve(a);
		viewport.unobserve(a);
		expect(FakeObserver.live.size).toBe(1);
		viewport.unobserve(b);
		expect(FakeObserver.live.size).toBe(0);
	});

	it('still escapes after two seconds without a single record', () => {
		const timers = new FakeTimers();
		const viewport = gate(timers);
		const seen: boolean[] = [];
		viewport.observe(scrollRoot().createDiv(), (visible) => seen.push(visible));

		timers.advance(2000);
		expect(seen).toEqual([true]);
	});
});
