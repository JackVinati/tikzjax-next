import { describe, expect, it } from 'vitest';
import {
	MAX_INCLUDE_DEPTH,
	resolvePreamble,
	type PreambleEntry,
	type PreambleSource,
} from '../src/preamble/resolve';

// ------------------------------------------------------------------------------------------
// Harness
//
// The vault is a Map of path -> text and nothing else. `resolve` mimics the one behaviour of
// `metadataCache.getFirstLinkpathDest` that matters to this module: a path is tried relative to
// the file that wrote it before it is tried against the vault root. That asymmetry is the bug PR
// #77's commenters reported, so the fake has to have it or the test proves nothing.

class FakeVault implements PreambleSource {
	readonly reads: string[] = [];
	private readonly files: Map<string, string>;
	/** Paths whose read throws — a file the index still knows about but the disk no longer has. */
	private readonly unreadable: Set<string>;

	constructor(files: Record<string, string>, unreadable: readonly string[] = []) {
		this.files = new Map(Object.entries(files));
		this.unreadable = new Set(unreadable);
	}

	resolve(path: string, fromNotePath: string): string | null {
		const dir = fromNotePath.includes('/') ? fromNotePath.slice(0, fromNotePath.lastIndexOf('/')) : '';
		const relative = dir === '' ? path : `${dir}/${path}`;
		if (this.files.has(relative) || this.unreadable.has(relative)) return relative;
		if (this.files.has(path) || this.unreadable.has(path)) return path;
		return null;
	}

	async read(canonicalPath: string): Promise<string> {
		this.reads.push(canonicalPath);
		if (this.unreadable.has(canonicalPath)) throw new Error('EIO: file went away');
		const text = this.files.get(canonicalPath);
		if (text === undefined) throw new Error(`not a file: ${canonicalPath}`);
		return text;
	}

	/** How many times one path was read, which is what "memoise" has to mean to be worth anything. */
	timesRead(path: string): number {
		return this.reads.filter((p) => p === path).length;
	}
}

/** Deterministic, order-independent, and different for different bytes. FNV-1a is plenty. */
function fakeHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

const NOTE = 'notes/diagrams.md';

function entry(over: Partial<PreambleEntry> = {}): PreambleEntry {
	return { globalPath: null, blockPath: null, inputs: [], ...over };
}

function resolve(vault: FakeVault, over: Partial<PreambleEntry> = {}, note = NOTE) {
	return resolvePreamble(entry(over), note, vault, fakeHash);
}

function messages(diagnostics: readonly { message: string }[]): string {
	return diagnostics.map((d) => d.message).join('\n');
}

// ------------------------------------------------------------------------------------------

describe('the empty case', () => {
	it('produces an empty preamble, no dependencies and no diagnostics', async () => {
		// This is load-bearing well beyond "nothing in, nothing out": DESIGN.md §8.3 gates the
		// legacy-cache import on the effective user preamble being EMPTY. A resolver that returned
		// "\n", or a diagnostic for an absent global setting, would disable L3 for every vault in
		// the release that promises no recompiles.
		const vault = new FakeVault({});
		const resolved = await resolve(vault);

		expect(resolved.text).toBe('');
		expect(resolved.deps).toEqual([]);
		expect(resolved.depHashes).toEqual([]);
		expect(resolved.diagnostics).toEqual([]);
		expect(vault.reads).toEqual([]);
	});

	it('treats an empty path the same as an absent one', async () => {
		// A settings field that has been cleared holds '', not null. Diagnosing it would put an
		// error card under every diagram in a default vault.
		const vault = new FakeVault({});
		const resolved = await resolve(vault, { globalPath: '', blockPath: '  ', inputs: [''] });

		expect(resolved.text).toBe('');
		expect(resolved.diagnostics).toEqual([]);
	});
});

describe('precedence', () => {
	it('composes global, walk-up, preamble= and %:input in that order', async () => {
		// DESIGN.md §7.7. The order is the contract: later definitions win in TeX, so a note-level
		// macro must be able to override a vault-level one.
		const vault = new FakeVault({
			'preambles/global.tex': '\\def\\level{global}',
			'notes/tikz-preamble.tex': '\\def\\level{walk-up}',
			'notes/block.tex': '\\def\\level{directive}',
			'notes/one.tex': '\\def\\level{input-one}',
			'notes/two.tex': '\\def\\level{input-two}',
		});

		const resolved = await resolve(vault, {
			globalPath: 'preambles/global.tex',
			walkUpPath: 'notes/tikz-preamble.tex',
			blockPath: 'block.tex',
			inputs: ['one.tex', 'two.tex'],
		});

		expect(resolved.text.split('\n')).toEqual([
			'\\def\\level{global}',
			'\\def\\level{walk-up}',
			'\\def\\level{directive}',
			'\\def\\level{input-one}',
			'\\def\\level{input-two}',
		]);
		expect(resolved.diagnostics).toEqual([]);
	});
});

describe('nesting', () => {
	it('splices an included file where the directive stood', async () => {
		const vault = new FakeVault({
			'notes/base.tex': ['\\def\\before{1}', '%:input child.tex', '\\def\\after{1}'].join('\n'),
			'notes/child.tex': '\\def\\child{1}',
		});

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.text.split('\n')).toEqual(['\\def\\before{1}', '\\def\\child{1}', '\\def\\after{1}']);
	});

	it('resolves a nested path relative to the file that wrote it, not to the note', async () => {
		// PR #77's headline confusion: `%:input macros.tex` inside `latex/base.tex` means
		// `latex/macros.tex`, exactly as a [[link]] written in that file would.
		const vault = new FakeVault({
			'latex/base.tex': '%:input macros.tex',
			'latex/macros.tex': '\\def\\nested{1}',
		});

		const resolved = await resolve(vault, { blockPath: 'latex/base.tex' });

		expect(resolved.text).toBe('\\def\\nested{1}');
		expect(resolved.deps).toEqual(['latex/base.tex', 'latex/macros.tex']);
	});

	it('never lets a directive line reach TeX', async () => {
		// The line is a TeX comment, so this is not about the compile — it is about the cache key.
		// `baked.preamble` is hashed, so a directive left in the text would recompile every
		// dependent diagram whenever someone edited a comment in a shared preamble.
		const vault = new FakeVault({
			'notes/base.tex': ['%:input gone.tex', '%:input', '\\def\\kept{1}'].join('\n'),
		});

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.text).toBe('\\def\\kept{1}');
	});

	it('honours a quoted path exactly as quoted, spaces and all', async () => {
		// Quoting is the documented way to name a file whose name has a leading or trailing space —
		// it is the only reason `unquote` exists on this side at all, since an unquoted path is
		// trimmed before it is ever seen. A resolver that trims the quoted value too makes the
		// quoting a no-op and reports a file that is right there as missing.
		const vault = new FakeVault({
			'notes/base.tex': ['%:input "trailing .tex "', '%:input " leading.tex"'].join('\n'),
			'notes/trailing .tex ': '\\def\\trailing{1}',
			'notes/ leading.tex': '\\def\\leading{1}',
		});

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.text.split('\n')).toEqual(['\\def\\trailing{1}', '\\def\\leading{1}']);
	});

	it('still calls an all-whitespace quoted path no path at all', async () => {
		const vault = new FakeVault({ 'notes/base.tex': '%:input "   "\n\\def\\kept{1}' });

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.text).toBe('\\def\\kept{1}');
		expect(resolved.diagnostics).toHaveLength(1);
		expect(resolved.diagnostics[0]?.message).toContain('no path');
	});

	it('honours a directive in a file with CRLF line endings', async () => {
		// The scanner splits on '\n', so every line of a Windows-authored preamble arrives with a
		// trailing '\r'. A prefix check that did not allow for it would leave `%:input` unrecognised
		// in exactly the vaults most likely to have one, and would do it silently: the line is a
		// legal TeX comment, so nothing warns and the macros are simply absent.
		const vault = new FakeVault({
			'notes/base.tex': '\\def\\before{1}\r\n%:input child.tex\r\n\\def\\after{1}\r\n',
			'notes/child.tex': '\\def\\child{1}\r\n',
		});

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.text).toContain('\\def\\child{1}');
		expect(resolved.text).not.toContain('%:input');
	});

	it('leaves %!tikz lines in an included file alone', async () => {
		// A block option in a shared file would silently re-scale every diagram that includes it.
		const vault = new FakeVault({ 'notes/base.tex': '%!tikz scale=4\n\\def\\a{1}' });

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.text).toBe('%!tikz scale=4\n\\def\\a{1}');
	});

	it('treats %:inputs as a plain comment, the way directives.ts does', async () => {
		const vault = new FakeVault({ 'notes/base.tex': '%:inputs child.tex' });

		const resolved = await resolve(vault, { blockPath: 'base.tex' });

		expect(resolved.text).toBe('%:inputs child.tex');
		expect(resolved.diagnostics).toEqual([]);
	});
});

describe('cycles', () => {
	it('breaks a self-include and names it', async () => {
		const vault = new FakeVault({ 'notes/self.tex': '%:input self.tex\n\\def\\once{1}' });

		const resolved = await resolve(vault, { blockPath: 'self.tex' });

		expect(resolved.text).toBe('\\def\\once{1}');
		expect(resolved.diagnostics).toHaveLength(1);
		expect(resolved.diagnostics[0]?.message).toContain('notes/self.tex → notes/self.tex');
		expect(vault.timesRead('notes/self.tex')).toBe(1);
	});

	it('breaks a two-file cycle and reports the ring', async () => {
		const vault = new FakeVault({
			'notes/a.tex': '\\def\\a{1}\n%:input b.tex',
			'notes/b.tex': '\\def\\b{1}\n%:input a.tex',
		});

		const resolved = await resolve(vault, { blockPath: 'a.tex' });

		expect(resolved.text.split('\n')).toEqual(['\\def\\a{1}', '\\def\\b{1}']);
		expect(messages(resolved.diagnostics)).toContain('notes/a.tex → notes/b.tex → notes/a.tex');
	});

	it('breaks a three-file cycle and reports the whole ring, not just the repeat', async () => {
		const vault = new FakeVault({
			'notes/a.tex': '%:input b.tex',
			'notes/b.tex': '%:input c.tex',
			'notes/c.tex': '%:input a.tex\n\\def\\c{1}',
		});

		const resolved = await resolve(vault, { blockPath: 'a.tex' });

		expect(resolved.text).toBe('\\def\\c{1}');
		expect(messages(resolved.diagnostics)).toContain(
			'notes/a.tex → notes/b.tex → notes/c.tex → notes/a.tex',
		);
		// The proof that a cycle costs nothing beyond the diagnostic: three files, three reads.
		expect(vault.reads).toHaveLength(3);
	});

	it('resolves rather than hanging when the entry point is inside the loop', async () => {
		// A cycle must not blow the stack or spin. The assertion is that this test terminates at
		// all; the shape below is the one that recurses forever under a naive implementation.
		const vault = new FakeVault({
			'notes/a.tex': '%:input b.tex\n%:input c.tex',
			'notes/b.tex': '%:input a.tex',
			'notes/c.tex': '%:input b.tex\n%:input a.tex',
		});

		const resolved = await resolve(vault, { inputs: ['a.tex', 'b.tex', 'c.tex'] });

		expect(resolved.deps).toEqual(['notes/a.tex', 'notes/b.tex', 'notes/c.tex']);
	});
});

describe('diamonds', () => {
	it('includes the shared file once and calls it no cycle', async () => {
		// `\newcommand` twice is `! LaTeX Error: Command \foo already defined`, so splicing a
		// diamond's shared file twice would turn a legal include graph into a compile failure.
		const vault = new FakeVault({
			'notes/a.tex': '%:input b.tex\n%:input c.tex',
			'notes/b.tex': '%:input shared.tex\n\\def\\b{1}',
			'notes/c.tex': '%:input shared.tex\n\\def\\c{1}',
			'notes/shared.tex': '\\newcommand\\shared{1}',
		});

		const resolved = await resolve(vault, { blockPath: 'a.tex' });

		expect(resolved.text.split('\n')).toEqual(['\\newcommand\\shared{1}', '\\def\\b{1}', '\\def\\c{1}']);
		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.deps).toEqual(['notes/a.tex', 'notes/b.tex', 'notes/c.tex', 'notes/shared.tex']);
	});

	it('recognises one file under two different spellings of its path', async () => {
		// The spelling-identical case below cannot distinguish deduping on the path *as written*
		// from deduping on the file it names, and only the second is the requirement: `notes/m.tex`
		// from a global setting and `m.tex` from a `%:input` in the same folder are one file, one
		// read, one dependency and — because `\newcommand` twice is a hard TeX error — one splice.
		const vault = new FakeVault({ 'notes/m.tex': '\\newcommand\\m{1}' });

		const resolved = await resolve(vault, { globalPath: 'notes/m.tex', inputs: ['m.tex'] });

		expect(resolved.text).toBe('\\newcommand\\m{1}');
		expect(resolved.deps).toEqual(['notes/m.tex']);
		expect(vault.timesRead('notes/m.tex')).toBe(1);
	});

	it('reads a file named twice in one resolution exactly once', async () => {
		const vault = new FakeVault({ 'shared.tex': '\\def\\s{1}' });

		const resolved = await resolve(vault, {
			globalPath: 'shared.tex',
			blockPath: 'shared.tex',
			inputs: ['shared.tex', 'shared.tex'],
		});

		expect(vault.timesRead('shared.tex')).toBe(1);
		expect(resolved.text).toBe('\\def\\s{1}');
		expect(resolved.deps).toEqual(['shared.tex']);
	});
});

describe('the depth cap', () => {
	it('expands to the cap, stops, and says which file it dropped', async () => {
		// A chain deep enough to trip the cap without ever repeating a file: the cap has to be a
		// second, independent guard, because an acyclic include graph can still be unbounded.
		const depth = MAX_INCLUDE_DEPTH + 3;
		const files: Record<string, string> = {};
		for (let i = 0; i < depth; i++) {
			const next = i + 1 < depth ? `%:input f${i + 1}.tex\n` : '';
			files[`notes/f${i}.tex`] = `${next}\\def\\f${i}{1}`;
		}

		const resolved = await resolve(new FakeVault(files), { blockPath: 'f0.tex' });

		// f0 is depth 1, so f0..f9 are expanded and f10 is refused.
		expect(resolved.text).toContain(`\\def\\f${MAX_INCLUDE_DEPTH - 1}{1}`);
		expect(resolved.text).not.toContain(`\\def\\f${MAX_INCLUDE_DEPTH}{1}`);
		expect(resolved.deps).toHaveLength(MAX_INCLUDE_DEPTH);
		expect(messages(resolved.diagnostics)).toContain(`notes/f${MAX_INCLUDE_DEPTH}.tex was not expanded`);
	});
});

describe('missing files', () => {
	it('reports one at every level, and keeps everything that did resolve', async () => {
		// The whole reason this module exists. PR #77 spliced "" for a file it could not find and
		// its author conceded the limitation; the user then debugs an undefined control sequence a
		// hundred lines from the include that actually failed.
		const vault = new FakeVault({
			'notes/base.tex': '%:input nested-gone.tex\n\\def\\base{1}',
			'notes/present.tex': '\\def\\present{1}',
		});

		const resolved = await resolve(vault, {
			globalPath: 'global-gone.tex',
			walkUpPath: 'walkup-gone.tex',
			blockPath: 'base.tex',
			inputs: ['input-gone.tex', 'present.tex'],
		});

		const text = messages(resolved.diagnostics);
		for (const missing of ['global-gone.tex', 'walkup-gone.tex', 'nested-gone.tex', 'input-gone.tex']) {
			expect(text).toContain(missing);
		}
		expect(resolved.diagnostics.every((d) => d.kind === 'missing-file')).toBe(true);
		// Named the including file, so a nested failure is traceable to the file that asked for it.
		expect(text).toContain('included from notes/base.tex');
		// Nothing was substituted, and nothing else was lost.
		expect(resolved.text.split('\n')).toEqual(['\\def\\base{1}', '\\def\\present{1}']);
		expect(resolved.deps).toEqual(['notes/base.tex', 'notes/present.tex']);
	});

	it('says which knob named the path', async () => {
		const vault = new FakeVault({});

		const global = await resolve(vault, { globalPath: 'gone.tex' });
		const directive = await resolve(vault, { blockPath: 'gone.tex' });

		expect(global.diagnostics[0]?.hint).toContain('global preamble setting');
		expect(directive.diagnostics[0]?.hint).toContain('preamble=');
	});

	it('turns a read that throws into a diagnostic rather than a rejection', async () => {
		// The render child's settle path has no branch for "the preamble threw"; a file deleted
		// between the metadata cache and the read must not become an unhandled rejection.
		const vault = new FakeVault({ 'notes/ok.tex': '\\def\\ok{1}' }, ['notes/ghost.tex']);

		const resolved = await resolve(vault, { inputs: ['ghost.tex', 'ok.tex'] });

		expect(resolved.text).toBe('\\def\\ok{1}');
		expect(resolved.diagnostics).toHaveLength(1);
		expect(resolved.diagnostics[0]?.kind).toBe('missing-file');
		expect(resolved.diagnostics[0]?.message).toContain('notes/ghost.tex');
		// A file that failed to read is not a dependency: there are no bytes to hash.
		expect(resolved.deps).toEqual(['notes/ok.tex']);
	});

	it('turns a resolve that throws into a diagnostic rather than a rejection', async () => {
		// The other half of the "it always resolves" invariant, and the half that was missing.
		// `PreambleSource.resolve` is the Obsidian boundary — `PreambleService.source()` implements it
		// with `metadataCache.getFirstLinkpathDest` plus `vault.getAbstractFileByPath` — so it is
		// exactly as able to throw as `read` is, and it is called on every path at every level. An
		// unguarded throw here is an unhandled rejection in the render child's settle path, which has
		// no branch for "the preamble threw": the block never settles and shows a spinner forever.
		const source: PreambleSource = {
			resolve: () => {
				throw new Error('metadata cache is being rebuilt');
			},
			read: async () => '',
		};

		const resolved = await resolvePreamble(
			entry({ globalPath: 'anything.tex' }),
			NOTE,
			source,
			fakeHash,
		);

		expect(resolved.text).toBe('');
		expect(resolved.deps).toEqual([]);
		expect(resolved.diagnostics).toHaveLength(1);
		expect(resolved.diagnostics[0]?.kind).toBe('missing-file');
		expect(resolved.diagnostics[0]?.message).toContain('anything.tex');
	});

	it('keeps resolving the other slots after one path throws', async () => {
		// A throw must cost the one path that threw, not the whole preamble.
		const files = new FakeVault({ 'notes/ok.tex': '\\def\\ok{1}' });
		const source: PreambleSource = {
			resolve: (path, from) => {
				if (path === 'boom.tex') throw new Error('nope');
				return files.resolve(path, from);
			},
			read: (canonical) => files.read(canonical),
		};

		const resolved = await resolvePreamble(
			entry({ inputs: ['boom.tex', 'ok.tex'] }),
			NOTE,
			source,
			fakeHash,
		);

		expect(resolved.text).toBe('\\def\\ok{1}');
		expect(resolved.deps).toEqual(['notes/ok.tex']);
		expect(resolved.diagnostics).toHaveLength(1);
	});

	it('says the same thing once', async () => {
		// A duplicated `%:input`, or a `preamble=` that repeats the global setting, is one problem
		// and gets one chip. Two DIFFERENT broken includes still get two, because each message
		// names its own path and the file it was included from.
		const vault = new FakeVault({});

		const repeated = await resolve(vault, { globalPath: 'gone.tex', inputs: ['gone.tex', 'gone.tex'] });
		const distinct = await resolve(vault, { inputs: ['gone.tex', 'also-gone.tex'] });

		expect(repeated.diagnostics).toHaveLength(1);
		expect(distinct.diagnostics).toHaveLength(2);
	});
});

describe('deps and depHashes', () => {
	const vault = () =>
		new FakeVault({
			'notes/a.tex': '\\def\\a{1}',
			'notes/b.tex': '\\def\\b{1}',
			'notes/c.tex': '%:input a.tex\n\\def\\c{1}',
		});

	it('are sorted and deduped', async () => {
		const resolved = await resolve(vault(), { inputs: ['c.tex', 'b.tex', 'a.tex', 'b.tex'] });

		expect(resolved.deps).toEqual(['notes/a.tex', 'notes/b.tex', 'notes/c.tex']);
		expect([...resolved.deps].sort()).toEqual(resolved.deps);
		expect([...resolved.depHashes].sort()).toEqual(resolved.depHashes);
		expect(new Set(resolved.deps).size).toBe(resolved.deps.length);
	});

	it('are identical whatever order the includes were written in', async () => {
		// `depHashes` is in `BakedOptions`, i.e. in the cache key. If include order leaked into it,
		// swapping two `%:input` lines that define disjoint macros would recompile the diagram and
		// §6.3's per-file invalidation would be keyed on noise.
		const one = await resolve(vault(), { inputs: ['a.tex', 'b.tex', 'c.tex'] });
		const two = await resolve(vault(), { inputs: ['c.tex', 'b.tex', 'a.tex'] });

		expect(two.deps).toEqual(one.deps);
		expect(two.depHashes).toEqual(one.depHashes);
		// ...while the TEXT still follows what the user wrote, because TeX order is meaningful.
		expect(two.text).not.toBe(one.text);
	});

	it('carry the digest of each file as "path:hash"', async () => {
		const resolved = await resolve(vault(), { inputs: ['a.tex'] });

		expect(resolved.depHashes).toEqual([`notes/a.tex:${fakeHash('\\def\\a{1}')}`]);
	});

	it('hash the bytes as read, not the expansion', async () => {
		// `depHashes` answers "has this FILE changed". Hashing the expansion would make every file
		// in a chain look changed whenever any file below it did, defeating the point of tracking
		// dependencies per file at all.
		const nested = await resolve(vault(), { inputs: ['c.tex'] });

		expect(nested.depHashes).toContain(`notes/c.tex:${fakeHash('%:input a.tex\n\\def\\c{1}')}`);
	});
});
