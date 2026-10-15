/**
 * Which notes are being typed in, so that only a block of one waits for the debounce.
 * See internal/DECISIONS.md D22 and D39.
 *
 * The debounce exists for typing (upstream #24): wherever a diagram is drawn while its text is being
 * edited — Live Preview in a second pane on the same note, a Reading view beside the editor, an
 * embed of the note — each keystroke remakes the block, and a block that waited for the debounce is
 * unloaded by the next keystroke before it was ever compiled. Until 0.2.1 every block waited, so
 * opening a note waited 500 ms (300 on the desktop) before its first diagram was even queued.
 *
 * So a block is taken for one being typed in when it was made by an edit: when its note's text
 * changed within `windowMs` before the block was made, or in the same run of the page's code as its
 * making, which is how Live Preview reports a keystroke: it remakes the widget in the keystroke's
 * own update, and Obsidian triggers `editor-change` from that update's listener, after it (read in the
 * 1.14.4 bundle). A second pane, a Reading view beside the editor and an embed are remade after the
 * edit, up to 200 ms after it while a Reading view is still parsing. Any other block is one shown for
 * the first time or shown again, and goes to the queue as soon as it is seen. Edits are what
 * Obsidian's `editor-change` reports, in any pane, and a note's file changing (`vault.on('modify')`),
 * which is how a change that no editor made arrives: a sync or collaboration plugin, another
 * program. An edit whose note `editor-change` does not name counts for every note.
 *
 * An edit that comes after a block was made, in another run, did not make it. Through
 * 0.2.1-beta.5 the window was counted back from the block's cache miss instead, which comes after an
 * IndexedDB read, so that an edit reported meanwhile made a block wait that it had not made: on the
 * desktop, the first diagrams of the note open when Obsidian started, as something other than
 * Obsidian's own loading of the note reported an edit of it then (D39).
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
	/**
	 * Edits counted, and which of them was each note's last and the last unnamed one: a block made
	 * before an edit in the same run of code tells it from these (`making`).
	 */
	private count = 0;
	private readonly countAt = new Map<string, number>();
	private unnamedCount = 0;
	private readonly later: (task: () => void) => void;

	/**
	 * `later` runs a task once the run of code under way is over: the page's queueMicrotask, called
	 * as itself, since the platform refuses it called on another object.
	 */
	constructor(
		windowMs: number,
		now: () => number,
		later: (task: () => void) => void = (task) => queueMicrotask(task),
	) {
		this.windowMs = windowMs;
		this.now = now;
		this.later = later;
	}

	/** The text of the note at `path` changed; `null` when the editor did not say which note. */
	changed(path: string | null): void {
		const now = this.now();
		this.count++;
		if (path === null) {
			this.unnamed = now;
			this.unnamedCount = this.count;
			return;
		}
		this.at.delete(path);
		this.at.set(path, now);
		this.countAt.delete(path);
		this.countAt.set(path, this.count);
		// Insertion order is oldest first, so what has fallen out of the window is at the front.
		for (const [note, when] of this.at) {
			if (now - when <= this.windowMs) break;
			this.at.delete(note);
			this.countAt.delete(note);
		}
	}

	/**
	 * A block of the note at `path` is being made now. Says what its cache miss asks: whether an edit
	 * made it, one within the window before now or one in this same run of code, after it. Asked from
	 * the block's lookup, which awaits IndexedDB, by when this run is over.
	 */
	making(path: string): () => boolean {
		const madeAt = this.now();
		const last = Math.max(this.unnamed, this.at.get(path) ?? Number.NEGATIVE_INFINITY);
		const before = this.countOf(path);
		let sameRun = false;
		this.later(() => {
			sameRun = this.countOf(path) !== before;
		});
		return () => sameRun || madeAt - last <= this.windowMs;
	}

	/** The count at the last edit of `path`, or the last unnamed one if that came later. */
	private countOf(path: string): number {
		return Math.max(this.unnamedCount, this.countAt.get(path) ?? 0);
	}
}

/**
 * The note an `editor-change` names: its second argument's file, if any. Defensive, because the
 * event is a workspace event any plugin can trigger, with arguments of its own or none, and this
 * listener must not throw into the plugin that did.
 */
export function editedNote(info: { file?: { path: string } | null } | null | undefined): string | null {
	return info?.file?.path ?? null;
}
