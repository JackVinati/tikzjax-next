import { describe, expect, it } from 'vitest';
import { editedNote, RecentEdits } from '../src/block/edits';

/*
 * Only a block of a note being typed in waits for the debounce (internal/DECISIONS.md D22): one made
 * by an edit of its note, within the window before it was made or in the same run of code as its
 * making, after it, which is how Live Preview reports a keystroke. An edit after a block was made, in
 * another run, did not make it (D39).
 */

function edits(windowMs = 1000) {
	const clock = { now: 0 };
	const queued: (() => void)[] = [];
	const recent = new RecentEdits(
		windowMs,
		() => clock.now,
		(task) => queued.push(task),
	);
	/** The run of code under way is over: what it left for later runs. */
	const endRun = () => {
		for (const task of queued.splice(0)) task();
	};
	return { clock, edits: recent, endRun };
}

describe('RecentEdits', () => {
	it('says a block was not made by typing before any editor changed its note', () => {
		const { edits: recent, endRun } = edits();
		const made = recent.making('note.md');
		endRun();
		expect(made().editing).toBe(false);
	});

	it('says a block was made by typing for the window after its note changed, and not after', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		clock.now = 5000;
		recent.changed('note.md');
		endRun();
		clock.now = 6000;
		const within = recent.making('note.md');
		clock.now = 6001;
		const after = recent.making('note.md');
		endRun();
		expect(within().editing).toBe(true);
		expect(after().editing).toBe(false);
	});

	it('is about that note only: another note opened meanwhile was not typed in', () => {
		const { clock, edits: recent, endRun } = edits();
		recent.changed('typing.md');
		endRun();
		clock.now = 100;
		const typing = recent.making('typing.md');
		const opened = recent.making('opened.md');
		endRun();
		expect(typing().editing).toBe(true);
		expect(opened().editing).toBe(false);
	});

	it('takes an edit in an editor that did not say which note for an edit of every note', () => {
		// Erring towards the debounce: a block that waits needlessly costs what every block cost in
		// 0.2.0, and one that does not wait while typed in costs a compile at every keystroke.
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed(null);
		endRun();
		clock.now = 500;
		const within = recent.making('any.md');
		clock.now = 1001;
		const after = recent.making('any.md');
		endRun();
		expect(within().editing).toBe(true);
		expect(after().editing).toBe(false);
	});

	it('keeps the latest edit of a note, however many notes were edited since', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed('a.md');
		for (let i = 0; i < 100; i++) {
			clock.now += 5;
			recent.changed(`n${i}.md`);
		}
		clock.now += 5;
		recent.changed('a.md');
		endRun();
		clock.now += 999;
		const a = recent.making('a.md');
		const n0 = recent.making('n0.md');
		endRun();
		expect(a().editing).toBe(true);
		expect(n0().editing).toBe(false);
	});

	it('says a block made before an edit of its note, in another run, was not made by it', () => {
		// As at Obsidian's start: the view loads the note and makes the block, which no editor hears;
		// then something writes the note, while the block's cache is read.
		const { clock, edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		endRun();
		clock.now += 40;
		recent.changed('note.md');
		recent.changed(null);
		endRun();
		expect(made().editing).toBe(false);
	});

	it('says a block made in the run that then reports an edit of its note was made by it', () => {
		// Live Preview: the keystroke's update makes the widget, and its listener then says the text
		// changed.
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('note.md');
		endRun();
		expect(made().editing).toBe(true);
	});

	it('takes an editor that names no note, in that run, for an edit of the block’s', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed(null);
		endRun();
		expect(made().editing).toBe(true);
	});

	it('does not take another note’s edit in that run for one of the block’s', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('other.md');
		endRun();
		expect(made().editing).toBe(false);
	});

	it('still counts an edit before the block was made when another comes after it', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed('note.md');
		endRun();
		clock.now += 100;
		const made = recent.making('note.md');
		endRun();
		clock.now += 100;
		recent.changed('note.md');
		endRun();
		expect(made().editing).toBe(true);
	});

	it('tells the runs apart with the page’s own queueMicrotask', async () => {
		const recent = new RecentEdits(1000, () => 0);
		const same = recent.making('note.md');
		recent.changed('note.md');
		await Promise.resolve();
		const later = new RecentEdits(1000, () => 0);
		const before = later.making('note.md');
		await Promise.resolve();
		later.changed('note.md');
		await Promise.resolve();
		expect(same().editing).toBe(true);
		expect(before().editing).toBe(false);
	});

	it('does not take another note’s edit in that run for one of the block’s, when the block’s note was edited long before', () => {
		// The block's note has an entry that has left the window: another note's edit drops it, which
		// is no edit of the block's note, and leaves an older edit that named no note as its last.
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed(null);
		recent.changed('note.md');
		endRun();
		clock.now = 5000;
		const made = recent.making('note.md');
		recent.changed('other.md');
		endRun();
		expect(made()).toEqual({ editing: false });
	});
});

/*
 * The desktop's first diagrams after a start said "waited 300 ms" and nothing said which rule had made
 * them wait, nor what reported the edit: so the miss is told which edit made the block, and of a block
 * none did, the last one after it, which did not count (internal/DECISIONS.md D39).
 */
describe('the edit a block is told of', () => {
	it('is the one before it was made that made it wait, with what reported it and how long before', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed('note.md', 'modify');
		endRun();
		clock.now = 120;
		const made = recent.making('note.md');
		endRun();
		expect(made()).toEqual({ editing: true, edit: { source: 'modify', at: 'before', ms: 120 } });
	});

	it('is the one reported in the run that made it, as Live Preview reports a keystroke', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('note.md', 'editor');
		endRun();
		expect(made()).toEqual({ editing: true, edit: { source: 'editor', at: 'with', ms: 0 } });
	});

	it('names an editor that names no note as such', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed(null);
		endRun();
		clock.now = 30;
		const made = recent.making('note.md');
		endRun();
		expect(made()).toEqual({ editing: true, edit: { source: 'unnamed', at: 'before', ms: 30 } });
	});

	it('is, for a block no edit made, the last edit of its note after it was made, which did not count', () => {
		// As at the desktop's start: the view makes the block, then something writes the note while the
		// block's cache is read.
		const { clock, edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		endRun();
		clock.now = 40;
		recent.changed('note.md', 'editor');
		endRun();
		clock.now = 85;
		recent.changed('note.md', 'modify');
		endRun();
		expect(made()).toEqual({ editing: false, edit: { source: 'modify', at: 'after', ms: 85 } });
	});

	it('is none for a block no edit came near, nor another note’s edit after it', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed('note.md');
		endRun();
		clock.now = 5000;
		const made = recent.making('note.md');
		endRun();
		clock.now = 5040;
		recent.changed('other.md', 'modify');
		endRun();
		expect(made()).toEqual({ editing: false });
	});
});

describe('the note an editor-change names', () => {
	it('is the file of the view or editor it came with', () => {
		expect(editedNote({ file: { path: 'folder/note.md' } })).toBe('folder/note.md');
	});

	it('is none, without throwing, for an editor with no file or an event with no second argument', () => {
		// Any plugin can trigger the workspace event, and not every one passes what Obsidian does.
		expect(editedNote({ file: null })).toBeNull();
		expect(editedNote({})).toBeNull();
		expect(editedNote(undefined)).toBeNull();
		expect(editedNote(null)).toBeNull();
	});
});
