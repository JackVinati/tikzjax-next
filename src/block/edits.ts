/**
 * Which notes are being typed in, so that only a block of one waits for the debounce.
 * See internal/DECISIONS.md D22.
 *
 * The debounce exists for typing (upstream #24): wherever a diagram is drawn while its text is being
 * edited — Live Preview in a second pane on the same note, a Reading view beside the editor, an
 * embed of the note — each keystroke remakes the block, and a block that waited for the debounce is
 * unloaded by the next keystroke before it was ever compiled. Until 0.2.1 every block waited, so
 * opening a note waited 500 ms (300 on the desktop) before its first diagram was even queued.
 *
 * A block remade by typing is processed in the same update as the edit (Live Preview's widget), or a
 * little after it (a Reading view re-renders 10 ms after its editor, or up to 200 ms while it is
 * still parsing, read in the 1.14.4 bundle), and reaches its cache miss after one more IndexedDB
 * read. So a block whose note's text changed within `windowMs` of its miss is taken for one being
 * typed in, and debounces; any other block is one shown for the first time or shown again, and goes
 * to the queue as soon as it is seen. Edits are what Obsidian's `editor-change` reports, in any
 * pane; an edit whose note it does not name counts for every note.
 *
 * Deliberately not "the block at this place in the note had other text": with two panes on one
 * note, the second pane's block for a keystroke finds the first pane's block with the same text
 * there, and would compile every keystroke at once. The note-wide rule errs the other way: a block
 * that first appears in a note within the window of a keystroke in it waits, as every block did.
 */
export class RecentEdits {
	private readonly windowMs: number;
	private readonly now: () => number;
	/** When each note's text last changed. Only entries within the window matter. */
	private readonly at = new Map<string, number>();
	/** When text last changed in an editor that did not say which note it is. */
	private unnamed = Number.NEGATIVE_INFINITY;

	constructor(windowMs: number, now: () => number) {
		this.windowMs = windowMs;
		this.now = now;
	}

	/** The text of the note at `path` changed; `null` when the editor did not say which note. */
	changed(path: string | null): void {
		const now = this.now();
		if (path === null) {
			this.unnamed = now;
			return;
		}
		this.at.delete(path);
		this.at.set(path, now);
		// Insertion order is oldest first, so what has fallen out of the window is at the front.
		for (const [note, when] of this.at) {
			if (now - when <= this.windowMs) break;
			this.at.delete(note);
		}
	}

	/** Whether the note at `path` is being typed in: its text changed within the window. */
	editing(path: string): boolean {
		const now = this.now();
		return (
			now - this.unnamed <= this.windowMs ||
			now - (this.at.get(path) ?? Number.NEGATIVE_INFINITY) <= this.windowMs
		);
	}
}
