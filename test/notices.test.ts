// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { BootTimings } from '../engine-src/protocol';
import { installObsidianDom } from './stubs/obsidian-dom';
import { noJitNotice } from '../src/ui/notices';
import { README_LOCKDOWN } from '../src/ui/strings';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/*
 * What the plugin tells someone once, unasked, about their device: that TeX runs without the JIT on
 * their iPhone or iPad, which makes every diagram about twenty times slower (internal/DECISIONS.md
 * D33). main.ts shows what this returns and keeps in data.json that it did.
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
