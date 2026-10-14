// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { BootTimings } from '../engine-src/protocol';
import { installObsidianDom } from './stubs/obsidian-dom';
import { noJitNotice, outOfStepNotice } from '../src/ui/notices';
import { README_LOCKDOWN, README_OUT_OF_STEP } from '../src/ui/strings';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/*
 * What the plugin tells someone once, unasked, about their device: that TeX runs without the JIT on
 * their iPhone or iPad, which makes every diagram about twenty times slower (internal/DECISIONS.md
 * D33), and that the main.js the device runs is not the version its manifest.json says, which is
 * what Obsidian Sync Standard leaves behind (D34). main.ts shows what these return and keeps in
 * data.json that it did.
 */

const boot = (jit: BootTimings['jit']): BootTimings => ({
	decodeMs: 3,
	inflateMs: 30,
	compileMs: 1,
	totalMs: 47,
	nativeInflate: true,
	nativeBase64: true,
	jit,
});

const OFF = boot({ on: false, fastestMs: 3, attempts: 4, spentMs: 12 });
const ON = boot({ on: true, fastestMs: 0, attempts: 1, spentMs: 1 });

describe('the notice that TeX runs without the JIT', () => {
	it('is shown on an iPhone or iPad whose engine found the JIT off, with what to do and a link', () => {
		const message = noJitNotice(OFF, 'iOS', false);
		expect(message?.textContent).toContain('TeX runs without the JIT compiler on this device');
		expect(message?.textContent).toContain('Lockdown Mode is the usual cause.');
		expect(message?.textContent).toContain(
			'Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing',
		);
		expect(message?.querySelector('a')?.getAttribute('href')).toBe(README_LOCKDOWN);
	});

	it('is shown once', () => {
		expect(noJitNotice(OFF, 'iOS', true)).toBeNull();
	});

	it('is not shown when the JIT is on, or nobody measured it', () => {
		expect(noJitNotice(ON, 'iOS', false)).toBeNull();
		expect(noJitNotice(boot(undefined), 'iOS', false)).toBeNull();
		expect(noJitNotice(null, 'iOS', false)).toBeNull();
	});

	it('is not shown anywhere but iOS and iPadOS, where Lockdown Mode is not the cause', () => {
		for (const os of ['Android', 'macOS', 'Windows', 'Linux', 'unknown'] as const)
			expect(noJitNotice(OFF, os, false), os).toBeNull();
	});
});

describe('the notice that main.js and manifest.json are out of step', () => {
	it('says which version each is, and how to put it right, with a link', () => {
		const notice = outOfStepNotice('0.2.1-beta.3', '0.2.1', '');
		expect(notice?.pair).toBe('0.2.1-beta.3 → 0.2.1');
		const text = notice?.message.textContent ?? '';
		expect(text).toContain(
			'This device runs main.js from version 0.2.1-beta.3, while its manifest.json says 0.2.1.',
		);
		expect(text).toContain('with BRAT, its "Choose a single plugin to reinstall"');
		expect(text).toContain('from the community store, uninstall it and install it again');
		expect(text).toContain('turn off "Installed community plugins" in Sync\'s settings');
		expect(notice?.message.querySelector('a')?.getAttribute('href')).toBe(README_OUT_OF_STEP);
	});

	it('is shown once for each pair of versions', () => {
		expect(outOfStepNotice('0.2.1-beta.3', '0.2.1', '0.2.1-beta.3 → 0.2.1')).toBeNull();
		expect(outOfStepNotice('0.2.1', '0.2.2', '0.2.1-beta.3 → 0.2.1')?.pair).toBe('0.2.1 → 0.2.2');
	});

	it('is not shown when they are the same, or main.js does not say', () => {
		expect(outOfStepNotice('0.2.1', '0.2.1', '')).toBeNull();
		expect(outOfStepNotice(null, '0.2.1', '')).toBeNull();
	});
});
