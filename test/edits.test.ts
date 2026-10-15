import { describe, expect, it } from 'vitest';
import { editedNote, RecentEdits } from '../src/block/edits';

/*
 * Only a block of a note being typed in waits for the debounce (internal/DECISIONS.md D22): one made
 * by an edit of its note, within the window before it was made or in the same run of code as its
 * making, after it, which is how Live Preview reports a keystroke. An edit after a block was made, in
 * another run, did not make it (D39).
 */

/** The cache key of the block asked about. */
const KEY = 'key';

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
		expect(made.by(KEY).editing).toBe(false);
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
		expect(within.by(KEY).editing).toBe(true);
		expect(after.by(KEY).editing).toBe(false);
	});

	it('is about that note only: another note opened meanwhile was not typed in', () => {
		const { clock, edits: recent, endRun } = edits();
		recent.changed('typing.md');
		endRun();
		clock.now = 100;
		const typing = recent.making('typing.md');
		const opened = recent.making('opened.md');
		endRun();
		expect(typing.by(KEY).editing).toBe(true);
		expect(opened.by(KEY).editing).toBe(false);
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
		expect(within.by(KEY).editing).toBe(true);
		expect(after.by(KEY).editing).toBe(false);
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
		expect(a.by(KEY).editing).toBe(true);
		expect(n0.by(KEY).editing).toBe(false);
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
		expect(made.by(KEY).editing).toBe(false);
	});

	it('says a block made in the run that then reports an edit of its note was made by it', () => {
		// Live Preview: the keystroke's update makes the widget, and its listener then says the text
		// changed.
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('note.md');
		endRun();
		expect(made.by(KEY).editing).toBe(true);
	});

	it('takes an editor that names no note, in that run, for an edit of the block’s', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed(null);
		endRun();
		expect(made.by(KEY).editing).toBe(true);
	});

	it('does not take another note’s edit in that run for one of the block’s', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('other.md');
		endRun();
		expect(made.by(KEY).editing).toBe(false);
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
		expect(made.by(KEY).editing).toBe(true);
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
		expect(same.by(KEY).editing).toBe(true);
		expect(before.by(KEY).editing).toBe(false);
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
		expect(made.by(KEY)).toEqual({ editing: false });
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
		expect(made.by(KEY)).toEqual({ editing: true, edit: { source: 'modify', at: 'before', ms: 120 } });
	});

	it('is the one reported in the run that made it, as Live Preview reports a keystroke', () => {
		const { edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		recent.changed('note.md', 'editor');
		endRun();
		expect(made.by(KEY)).toEqual({ editing: true, edit: { source: 'editor', at: 'with', ms: 0 } });
	});

	it('names an editor that names no note as such', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed(null);
		endRun();
		clock.now = 30;
		const made = recent.making('note.md');
		endRun();
		expect(made.by(KEY)).toEqual({ editing: true, edit: { source: 'unnamed', at: 'before', ms: 30 } });
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
		expect(made.by(KEY)).toEqual({ editing: false, edit: { source: 'modify', at: 'after', ms: 85 } });
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
		expect(made.by(KEY)).toEqual({ editing: false });
	});
});

/**
 * Obsidian hands the processor a block of `note` with this text, and loads it, in the run of code
 * under way. `hide` is its unload.
 */
function show(recent: RecentEdits, key: string, note = 'note.md') {
	const made = recent.making(note);
	return { made, hide: made.shown(key) };
}

/*
 * At a start on the desktop, Obsidian's own reset of its syntax highlighting replaced the note's first
 * character with itself, an edit that changed nothing, and Live Preview then made the note's blocks
 * again: they waited for the debounce, though the note had shown each of them before the edit. An edit
 * makes a block wait only when the note did not have its text on screen as the edits began
 * (internal/DECISIONS.md D40).
 */
describe('a block whose text its note already showed', () => {
	it('does not wait when Live Preview makes it again after an edit, unloading the old one in that run', () => {
		// The start of beta.6 on the desktop: another plugin's processor, registered once the
		// workspace was ready, had Live Preview make every code block again, 103 ms after the edit.
		const { clock, edits: recent, endRun } = edits(1000);
		const old = show(recent, KEY);
		endRun();
		clock.now = 50;
		recent.changed('note.md');
		endRun();
		clock.now = 153;
		old.hide();
		const again = show(recent, KEY);
		endRun();
		expect(again.made.by(KEY)).toEqual({
			editing: false,
			edit: { source: 'editor', at: 'before', ms: 103, shown: true },
		});
	});

	it('nor when the old block was unloaded in the run of the edit, and the new one made later', () => {
		// The edit's own update finds a stale syntax tree and lets the blocks past it go; the parse
		// that comes after makes them again.
		const { clock, edits: recent, endRun } = edits(1000);
		const old = show(recent, KEY);
		endRun();
		clock.now = 50;
		old.hide();
		recent.changed('note.md');
		endRun();
		clock.now = 150;
		const again = show(recent, KEY);
		endRun();
		expect(again.made.by(KEY)).toEqual({
			editing: false,
			edit: { source: 'editor', at: 'before', ms: 100, shown: true },
		});
	});

	it('nor when the old block is unloaded only after the new one was made', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		const old = show(recent, KEY);
		endRun();
		clock.now = 50;
		recent.changed('note.md');
		endRun();
		clock.now = 150;
		const again = show(recent, KEY);
		old.hide();
		endRun();
		expect(again.made.by(KEY).editing).toBe(false);
	});

	it('nor for a block made before the edit and loaded after it, as one whose preamble is read first', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		const made = recent.making('note.md');
		endRun();
		clock.now = 20;
		recent.changed('note.md');
		endRun();
		clock.now = 30;
		const hide = made.shown(KEY);
		endRun();
		clock.now = 120;
		hide();
		const again = show(recent, KEY);
		endRun();
		expect(again.made.by(KEY).editing).toBe(false);
	});

	it('waits for a text first shown after the edits began, as a Reading view beside the editor makes one at each keystroke', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		const typed = show(recent, 'k0');
		endRun();
		// Each keystroke, and 10 ms later the Reading view lets the old block go and makes the new one.
		const keystroke = (at: number, from: { hide: () => void }, to: string) => {
			clock.now = at;
			recent.changed('note.md');
			endRun();
			clock.now = at + 10;
			from.hide();
			const next = show(recent, to);
			endRun();
			return next;
		};
		const k1 = keystroke(1000, typed, 'k1');
		expect(k1.made.by('k1')).toEqual({ editing: true, edit: { source: 'editor', at: 'before', ms: 10 } });
		const k2 = keystroke(1300, k1, 'k2');
		expect(k2.made.by('k2').editing).toBe(true);
		// Back to a text the keystrokes made, as an undo makes it: shown only once they had begun.
		const back = keystroke(1600, k2, 'k1');
		expect(back.made.by('k1').editing).toBe(true);
		// Back to the text shown before the first keystroke, which normally is in the cache.
		const first = keystroke(1900, back, 'k0');
		expect(first.made.by('k0')).toEqual({
			editing: false,
			edit: { source: 'editor', at: 'before', ms: 10, shown: true },
		});
	});

	it('waits for a block made in the update of the edit that began the edits, as Live Preview makes a keystroke’s', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		const made = show(recent, KEY);
		recent.changed('note.md');
		endRun();
		expect(made.made.by(KEY)).toEqual({ editing: true, edit: { source: 'editor', at: 'with', ms: 0 } });
		// Made again a moment later, by a second pane: shown first in the edit's own run, so not before it.
		clock.now = 10;
		made.hide();
		const again = show(recent, KEY);
		recent.changed('note.md');
		endRun();
		expect(again.made.by(KEY).editing).toBe(true);
	});

	it('counts the edits from the first of those each within the window of the one before', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		clock.now = 0;
		recent.changed('note.md');
		endRun();
		clock.now = 10;
		const shown = show(recent, KEY);
		endRun();
		for (const at of [900, 1800, 2700]) {
			clock.now = at;
			recent.changed('note.md');
			endRun();
		}
		clock.now = 2710;
		shown.hide();
		const typing = show(recent, KEY);
		endRun();
		// Shown 10 ms after the first of those edits: 2.7 s of typing later, still not before it.
		expect(typing.made.by(KEY).editing).toBe(true);
		// After a pause longer than the window, the next edit begins anew, and the text was on screen.
		clock.now = 4000;
		recent.changed('note.md');
		endRun();
		clock.now = 4010;
		typing.hide();
		const paused = show(recent, KEY);
		endRun();
		expect(paused.made.by(KEY).editing).toBe(false);
	});

	it('takes an editor that named no note with the edits of the block’s note, from the earlier of the two', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		recent.changed(null);
		endRun();
		clock.now = 10;
		const shown = show(recent, KEY);
		endRun();
		clock.now = 600;
		recent.changed('note.md');
		endRun();
		clock.now = 610;
		shown.hide();
		const again = show(recent, KEY);
		endRun();
		// On screen before the note's own edit, but not before the one that named no note.
		expect(again.made.by(KEY).editing).toBe(true);
	});

	it('keeps a text on screen while any block of it is, in any view of the note', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		const pane = show(recent, KEY);
		const reading = show(recent, KEY);
		endRun();
		pane.hide();
		endRun();
		clock.now = 5000;
		recent.changed('note.md');
		endRun();
		clock.now = 5010;
		reading.hide();
		const again = show(recent, KEY);
		endRun();
		expect(again.made.by(KEY).editing).toBe(false);
	});

	it('is about the note: the same text on screen in another note does not count', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		show(recent, KEY, 'other.md');
		endRun();
		clock.now = 50;
		recent.changed('note.md');
		endRun();
		clock.now = 60;
		const made = show(recent, KEY);
		endRun();
		expect(made.made.by(KEY).editing).toBe(true);
	});

	it('is a text unloaded no longer than the window ago, and then forgotten', () => {
		for (const [madeAt, editing] of [
			[1010, false],
			[1011, true],
		] as const) {
			const { clock, edits: recent, endRun } = edits(1000);
			const old = show(recent, KEY);
			endRun();
			recent.changed('note.md');
			endRun();
			clock.now = 10;
			old.hide();
			endRun();
			for (const at of [500, 1000]) {
				clock.now = at;
				recent.changed('note.md');
				endRun();
			}
			clock.now = madeAt;
			const again = show(recent, KEY);
			endRun();
			expect(again.made.by(KEY).editing, `made at ${madeAt}`).toBe(editing);
		}
	});

	it('takes an unload said twice for one', () => {
		const { clock, edits: recent, endRun } = edits(1000);
		const one = show(recent, KEY);
		show(recent, KEY);
		endRun();
		one.hide();
		one.hide();
		endRun();
		clock.now = 50;
		recent.changed('note.md');
		endRun();
		clock.now = 2000;
		recent.changed('note.md');
		endRun();
		clock.now = 2010;
		// The other block is still on screen: had the second unload counted, the text would be gone.
		const again = show(recent, KEY);
		endRun();
		expect(again.made.by(KEY).editing).toBe(false);
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
