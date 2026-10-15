import type { BlockEdit, EditSource } from '../types';

/** A note's text changing: when, its place among every edit counted, and what reported it. */
interface Edit {
	when: number;
	count: number;
	source: EditSource;
}

/** What a block's cache miss is told of the edits of its note around its making (RecentEdits.making). */
export interface MadeBy {
	/** An edit made the block: it waits for the debounce. */
	editing: boolean;
	/**
	 * That edit, for the diagnostics; else the last edit of its note reported after the block was
	 * made, which did not count. Absent when there was neither (internal/DECISIONS.md D39).
	 */
	edit?: BlockEdit | undefined;
}

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
 * What reported that edit was not known, and the diagnostics could not say: a block said "waited
 * 300 ms" whichever rule made it wait. So the miss is told which edit made the block, `editor-change`
 * naming the note or naming none, or `modify`, and how long before its making, or that it came in the
 * same run; and of a block no edit made, the last edit of its note reported after it was made, which
 * did not count. The waited step says either (CompileTimings.edit).
 *
 * Deliberately not "the block at this place in the note had other text": with two panes on one
 * note, the second pane's block for a keystroke finds the first pane's block with the same text
 * there, and would compile every keystroke at once. The note-wide rule errs the other way: a block
 * that first appears in a note within the window of a keystroke in it waits, as every block did.
 */
export class RecentEdits {
	private readonly windowMs: number;
	private readonly now: () => number;
	/** Each note's last edit, oldest first. Only entries within the window matter. */
	private readonly at = new Map<string, Edit>();
	/** The last edit an editor reported without saying which note it is. */
	private unnamed: Edit | undefined;
	/**
	 * Edits counted: a block made before an edit in the same run of code tells it by its place
	 * (`making`).
	 */
	private count = 0;
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

	/**
	 * The text of the note at `path` changed; `null` when the editor did not say which note. `source`
	 * is what said so: an editor (`editor-change`), or the note's file changing (`modify`).
	 */
	changed(path: string | null, source: 'editor' | 'modify' = 'editor'): void {
		const now = this.now();
		const edit: Edit = { when: now, count: ++this.count, source: path === null ? 'unnamed' : source };
		if (path === null) {
			this.unnamed = edit;
			return;
		}
		this.at.delete(path);
		this.at.set(path, edit);
		// Insertion order is oldest first, so what has fallen out of the window is at the front.
		for (const [note, last] of this.at) {
			if (now - last.when <= this.windowMs) break;
			this.at.delete(note);
		}
	}

	/**
	 * A block of the note at `path` is being made now. Says what its cache miss asks: whether an edit
	 * made it, one within the window before now or one in this same run of code, after it, and which
	 * edit that was; or, for the diagnostics, the last edit of the note reported after the block was
	 * made, by the time of asking, which did not count. Asked from the block's lookup, which awaits
	 * IndexedDB, by when this run is over.
	 */
	making(path: string): () => MadeBy {
		const madeAt = this.now();
		const prior = this.lastOf(path);
		const before = prior?.count ?? 0;
		let withIt: Edit | undefined;
		this.later(() => {
			// More only through an edit of the note or one that names none: dropping a note's entry
			// once it has left the window can only make it less, and is no edit.
			const last = this.lastOf(path);
			if (last !== undefined && last.count > before) withIt = last;
		});
		return () => {
			if (withIt !== undefined)
				return { editing: true, edit: { source: withIt.source, at: 'with', ms: 0 } };
			if (prior !== undefined && madeAt - prior.when <= this.windowMs)
				return {
					editing: true,
					edit: { source: prior.source, at: 'before', ms: madeAt - prior.when },
				};
			const after = this.lastOf(path);
			return after !== undefined && after.count > before
				? { editing: false, edit: { source: after.source, at: 'after', ms: after.when - madeAt } }
				: { editing: false };
		};
	}

	/** The last edit of `path`, or the last unnamed one if that came later. */
	private lastOf(path: string): Edit | undefined {
		const named = this.at.get(path);
		const unnamed = this.unnamed;
		if (named === undefined) return unnamed;
		if (unnamed === undefined) return named;
		return named.count > unnamed.count ? named : unnamed;
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
