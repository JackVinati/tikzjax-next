import { describe, expect, it } from 'vitest';
import { editedNote, RecentEdits } from '../src/block/edits';

/*
 * Only a block of a note being typed in waits for the debounce (internal/DECISIONS.md D22). A note
 * is being typed in for a while after any editor changed its text, in any pane.
 */

function edits(windowMs = 1000) {
	const clock = { now: 0 };
	return { clock, edits: new RecentEdits(windowMs, () => clock.now) };
}

describe('RecentEdits', () => {
	it('says no note is being typed in before any editor changed one', () => {
		expect(edits().edits.editing('note.md')).toBe(false);
	});

	it('says a note is being typed in for the window after its text changed, and not after', () => {
		const { clock, edits: recent } = edits(1000);
		clock.now = 5000;
		recent.changed('note.md');
		clock.now = 6000;
		expect(recent.editing('note.md')).toBe(true);
		clock.now = 6001;
		expect(recent.editing('note.md')).toBe(false);
	});

	it('is about that note only: another note opened meanwhile is not being typed in', () => {
		const { clock, edits: recent } = edits();
		recent.changed('typing.md');
		clock.now = 100;
		expect(recent.editing('typing.md')).toBe(true);
		expect(recent.editing('opened.md')).toBe(false);
	});

	it('takes an edit in an editor that did not say which note for an edit of every note', () => {
		// Erring towards the debounce: a block that waits needlessly costs what every block cost in
		// 0.2.0, and one that does not wait while typed in costs a compile at every keystroke.
		const { clock, edits: recent } = edits(1000);
		recent.changed(null);
		clock.now = 500;
		expect(recent.editing('any.md')).toBe(true);
		clock.now = 1001;
		expect(recent.editing('any.md')).toBe(false);
	});

	it('keeps the latest edit of a note, however many notes were edited since', () => {
		const { clock, edits: recent } = edits(1000);
		recent.changed('a.md');
		for (let i = 0; i < 100; i++) {
			clock.now += 5;
			recent.changed(`n${i}.md`);
		}
		clock.now += 5;
		recent.changed('a.md');
		clock.now += 999;
		expect(recent.editing('a.md')).toBe(true);
		expect(recent.editing('n0.md')).toBe(false);
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
