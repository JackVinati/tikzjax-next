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
		expect(made()).toBe(false);
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
		expect(within()).toBe(true);
		expect(after()).toBe(false);
	});

	it('is about that note only: another note opened meanwhile was not typed in', () => {
		const { clock, edits: recent, endRun } = edits();
		recent.changed('typing.md');
		endRun();
		clock.now = 100;
		const typing = recent.making('typing.md');
		const opened = recent.making('opened.md');
		endRun();
		expect(typing()).toBe(true);
		expect(opened()).toBe(false);
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
		expect(within()).toBe(true);
		expect(after()).toBe(false);
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
		expect(a()).toBe(true);
		expect(n0()).toBe(false);
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
		expect(made()).toBe(false);
	});

	it('says a block made in the run that then reports an edit of its note was made by it', () => {
		// Live Preview: the keystroke's update makes the widget, and its listener then says the text
		// changed.
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('note.md');
		endRun();
		expect(made()).toBe(true);
	});

	it('takes an editor that names no note, in that run, for an edit of the block’s', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed(null);
		endRun();
		expect(made()).toBe(true);
	});

	it('does not take another note’s edit in that run for one of the block’s', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('other.md');
		endRun();
		expect(made()).toBe(false);
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
		expect(made()).toBe(true);
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
		expect(same()).toBe(true);
		expect(before()).toBe(false);
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
