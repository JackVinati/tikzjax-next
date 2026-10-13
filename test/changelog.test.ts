/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * CHANGELOG.md is not decoration: the release workflow cuts the section for the tag out of it and
 * puts it at the top of the release notes, and fails the release when there is none. That check
 * runs once the tag is already pushed. These run on every commit, so a missing or malformed entry
 * is found while it is still an edit, not a failed release.
 *
 * The format the workflow relies on: one `## <version> — <date>` heading per release, newest
 * first, where the date is YYYY-MM-DD or, until the release is cut, the word `unreleased`. A
 * pre-release such as `0.2.0-beta.1` has a section of its own while it is the newest; the release
 * it leads to takes that section over.
 */

// Vite's glob rather than node:fs, like preflight.test.ts: the tests typecheck without Node's types.
const files = import.meta.glob<string>(['../CHANGELOG.md', '../manifest.json', '../versions.json'], {
	query: '?raw',
	import: 'default',
	eager: true,
});

const HEADING = /^## (\S+)(.*)$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const DATED = /^ — \d{4}-\d{2}-\d{2}$/;
const UNRELEASED = ' — unreleased';

interface Section {
	version: string;
	rest: string;
	body: string;
}

function sections(text: string): Section[] {
	const out: Section[] = [];
	let current: Section | null = null;
	for (const line of text.split(/\r?\n/)) {
		const m = HEADING.exec(line);
		if (m) {
			current = { version: m[1] ?? '', rest: m[2] ?? '', body: '' };
			out.push(current);
		} else if (current) {
			current.body += `${line}\n`;
		}
	}
	return out;
}

/** Semver's order, as far as these versions need it: 0.2.0-beta.1 < 0.2.0-beta.2 < 0.2.0. */
function compare(a: string, b: string): number {
	const [ca = '', pa = ''] = a.split('-', 2);
	const [cb = '', pb = ''] = b.split('-', 2);
	const na = ca.split('.').map(Number);
	const nb = cb.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (na[i] ?? 0) - (nb[i] ?? 0);
		if (d !== 0) return d;
	}
	if (pa === pb) return 0;
	if (pa === '') return 1;
	if (pb === '') return -1;
	return pa.localeCompare(pb, 'en', { numeric: true });
}

describe('CHANGELOG.md', () => {
	const changelog = files['../CHANGELOG.md'];

	it('exists', () => {
		expect(changelog).toBeTypeOf('string');
	});

	const all = sections(changelog ?? '');
	const manifest = JSON.parse(files['../manifest.json'] ?? '{}') as { version: string };
	const versions = JSON.parse(files['../versions.json'] ?? '{}') as Record<string, string>;

	it('has one well-formed heading per release, newest first', () => {
		expect(all.length).toBeGreaterThan(0);
		for (const s of all) {
			expect(s.version, `## ${s.version}${s.rest}`).toMatch(VERSION);
			expect(DATED.test(s.rest) || s.rest === UNRELEASED, `## ${s.version}${s.rest}`).toBe(true);
			expect(s.body.trim(), `## ${s.version} is empty`).not.toBe('');
		}
		const listed = all.map((s) => s.version);
		expect(new Set(listed).size).toBe(listed.length);
		expect(listed).toEqual([...listed].sort((a, b) => compare(b, a)));
	});

	it('only ever calls the newest section unreleased', () => {
		all.slice(1).forEach((s) => expect(s.rest, `## ${s.version}`).not.toBe(UNRELEASED));
	});

	it('covers every version in versions.json', () => {
		const listed = new Set(all.map((s) => s.version));
		for (const version of Object.keys(versions)) expect(listed.has(version), version).toBe(true);
	});

	// The release workflow refuses an `unreleased` heading for the tag it is publishing. The manifest
	// carries the version being released from the commit that bumps it, so this is the same check,
	// made before the tag exists.
	it('dates the section for the manifest version', () => {
		const section = all.find((s) => s.version === manifest.version);
		expect(section, `no ## ${manifest.version} section`).toBeDefined();
		expect(section?.rest).toMatch(DATED);
	});
});
