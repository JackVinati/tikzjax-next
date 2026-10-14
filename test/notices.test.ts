// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { installObsidianDom } from './stubs/obsidian-dom';
import { JIT_OFF_STARTS, noJitNotice, outOfStepNotice } from '../src/ui/notices';
import { README_LOCKDOWN, README_OUT_OF_STEP } from '../src/ui/strings';

beforeAll(() => {
	installObsidianDom(window as unknown as Window & typeof globalThis);
});

/*
 * What the plugin tells someone once, unasked, about their device: that TeX seems to run without the JIT on
 * their iPhone or iPad, which makes every diagram about twenty times slower (internal/DECISIONS.md
 * D33), and that the main.js the device runs is not the version its manifest.json says, which is
 * what Obsidian Sync Standard leaves behind (D34). main.ts shows what these return and keeps in
 * data.json that it did.
 */

describe('the notice that TeX runs without the JIT', () => {
	const offTwice = { on: 0, off: 2 };

	it('is shown on an iPhone or iPad whose engine found the JIT off twice, with what to do and a link', () => {
		const message = noJitNotice(offTwice, 'iOS', false);
		expect(message?.textContent).toContain('TeX seems to run without the JIT compiler on this device');
		expect(message?.textContent).toContain('If Lockdown Mode is on, it is the likely cause');
		expect(message?.textContent).toContain(
			'Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing',
		);
		expect(message?.querySelector('a')?.getAttribute('href')).toBe(README_LOCKDOWN);
	});

	it('waits for a second start to find it off: one probe is one moment, which a busy phone can make slow', () => {
		expect(JIT_OFF_STARTS).toBe(2);
		expect(noJitNotice({ on: 0, off: 1 }, 'iOS', false)).toBeNull();
		expect(noJitNotice({ on: 0, off: 3 }, 'iOS', false)).not.toBeNull();
	});

	it('is not shown once a start this session found the JIT on', () => {
		expect(noJitNotice({ on: 1, off: 2 }, 'iOS', false)).toBeNull();
	});

	it('is shown once', () => {
		expect(noJitNotice(offTwice, 'iOS', true)).toBeNull();
	});

	it('is not shown when nobody measured it', () => {
		expect(noJitNotice({ on: 0, off: 0 }, 'iOS', false)).toBeNull();
	});

	it('is not shown anywhere but iOS and iPadOS, where Lockdown Mode is not the cause', () => {
		for (const os of ['Android', 'macOS', 'Windows', 'Linux', 'unknown'] as const)
			expect(noJitNotice(offTwice, os, false), os).toBeNull();
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

	/*
	 * An older manifest.json beside a newer main.js warns too (D34), and Sync Standard's copying a new
	 * manifest.json is no explanation of it: a sync service or a backup brought the old one back.
	 */
	it('says something else left them so where manifest.json is the older, and that Sync Standard only can', () => {
		const older = outOfStepNotice('0.2.1-beta.3', '0.2.0', '')?.message.textContent ?? '';
		expect(older).toContain(
			'This device runs main.js from version 0.2.1-beta.3, while its manifest.json says 0.2.0, an older one',
		);
		expect(older).toContain('something brought back the old manifest.json, a sync service or a backup');
		expect(older).not.toContain('copies a new manifest.json');
		expect(older).toContain('with BRAT, its "Choose a single plugin to reinstall"');
		const newer = outOfStepNotice('0.2.1-beta.3', '0.2.1', '')?.message.textContent ?? '';
		expect(newer).toContain('Obsidian Sync Standard can leave the plugin like this');
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
