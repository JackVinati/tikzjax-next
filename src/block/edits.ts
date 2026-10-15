import type { BlockEdit, EditSource } from '../types';

/** A note's text changing: when, its place among every edit counted, and what reported it. */
interface Edit {
	when: number;
	count: number;
	source: EditSource;
	/**
	 * The run of code the first edit of its burst came in: of the edits of its note, or of those that
	 * named none, each within the window of the one before it.
	 */
	burst: number;
}

/**
 * A text on screen in a note, as the cache key of its blocks: from the run of code the first of them
 * was made in to the run the last was unloaded in.
 */
interface OnScreen {
	key: string;
	/** Its blocks loaded now. */
	loaded: number;
	from: number;
	/** Undefined while one of its blocks is loaded. */
	to: number | undefined;
	/** When the last was unloaded: it is let go once the window has passed. */
	at: number;
}

/** What a block's cache miss is told of the edits of its note around its making (Making.by). */
export interface MadeBy {
	/** An edit made the block: it waits for the debounce. */
	editing: boolean;
	/**
	 * That edit, for the diagnostics; or one before it was made, or with it, that did not count, as
	 * the note had the block's text on screen as the edits began (D40); else the last edit of its note
	 * reported after the block was made, which did not count. Absent when there was none
	 * (internal/DECISIONS.md D39).
	 */
	edit?: BlockEdit | undefined;
}

/** A block of a note being made (RecentEdits.making). */
export interface Making {
	/**
	 * What its cache miss asks, with the block's key: whether an edit made it, and so it waits for the
	 * debounce if it is not cached, and which edit that was.
	 */
	by(key: string): MadeBy;
	/**
	 * The block is loaded, with this key: its text is on screen in its note from the block's making
	 * until the function returned is called, as the block is unloaded.
	 */
	shown(key: string): () => void;
}

/**
 * Which notes are being typed in, so that only a block of one waits for the debounce.
 * See internal/DECISIONS.md D22, D39 and D40.
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
 * desktop, the first diagrams of the note open when Obsidian started (D39).
 *
 * That edit is Obsidian's own: once a session, when the script of its CodeMirror 5 modes has loaded,
 * it resets the syntax highlighting of each open note by replacing the note's first character with
 * itself, which changes nothing and saves nothing, but is a change of the document all the same, and
 * `editor-change` names the note (read in the 1.14.4 bundle). A note's blocks made again within the
 * window after it waited in 0.2.1-beta.6, as Live Preview makes every code block again when another
 * plugin registers a processor once the workspace is ready. So an edit does not count for a block
 * whose text its note had on screen as the edits began: the first of them, each within the window of
 * the one before, came in a later run of code than a block of that text was made in, and no later
 * than the run the last such block was unloaded in (D40). Typing makes a text the note did not have,
 * which waits, in Live Preview, a second pane, a Reading view beside the editor or an embed alike, as
 * does going back to a text the typing made; going back to the text the note had before it, by an
 * undo or a sync, does not wait, and is normally in the cache. A text is remembered while a block of
 * it is loaded, and for the window after the last is unloaded.
 *
 * What reported an edit was not known, and the diagnostics could not say: a block said "waited
 * 300 ms" whichever rule made it wait. So the miss is told which edit made the block, `editor-change`
 * naming the note or naming none, or `modify`, and how long before its making, or that it came in the
 * same run; that it did not count, as the note had the block's text on screen as the edits began; and
 * of a block no edit made, the last edit of its note reported after it was made, which did not count.
 * The waited step says each (CompileTimings.edit).
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
	/** The run of code under way, counted from 1, and whether one is: it ends as `later` runs. */
	private run = 0;
	private running = false;
	/** The texts each note has on screen, or had within the window, by key. */
	private readonly screens = new Map<string, Map<string, OnScreen>>();
	/** Texts whose last block was unloaded, the earliest first, to be let go once the window has passed. */
	private readonly unloaded: { note: string; text: OnScreen; at: number }[] = [];

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
		const previous = path === null ? this.unnamed : this.at.get(path);
		const edit: Edit = {
			when: now,
			count: ++this.count,
			source: path === null ? 'unnamed' : source,
			burst:
				previous !== undefined && now - previous.when <= this.windowMs
					? previous.burst
					: this.thisRun(),
		};
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
	 * A block of the note at `path` is being made now. Its miss asks whether an edit made it, one
	 * within the window before now or one in this same run of code, after it, and which edit that
	 * was; or, for the diagnostics, the last edit of the note reported after the block was made, by
	 * the time of asking, which did not count. Asked from the block's lookup, which awaits IndexedDB,
	 * by when this run is over.
	 *
	 * Where an edit made it, which texts its note had on screen as the edits began is noted when this
	 * run is over, by when every block this run unloaded has said so, and the miss asks whether the
	 * block's is one of them. Noted then rather than at the miss, which may come after the window, when
	 * a text unloaded in this run is no longer remembered.
	 */
	making(path: string): Making {
		const madeAt = this.now();
		const madeIn = this.thisRun();
		const prior = this.lastOf(path);
		const before = prior?.count ?? 0;
		let withIt: Edit | undefined;
		/** The texts its note had on screen as the edits that made the block began, if any did. */
		let shown: ReadonlySet<string> | undefined;
		this.later(() => {
			// More only through an edit of the note or one that names none: dropping a note's entry
			// once it has left the window can only make it less, and is no edit.
			const last = this.lastOf(path);
			if (last !== undefined && last.count > before) withIt = last;
			const made =
				withIt ?? (prior !== undefined && madeAt - prior.when <= this.windowMs ? prior : undefined);
			if (made === undefined) return;
			// The edits of the note and those that named none, from the earlier of the two while both
			// go on: erring towards the debounce.
			let burst = made.burst;
			for (const edit of [this.at.get(path), this.unnamed]) {
				if (edit !== undefined && (edit.count > before || madeAt - edit.when <= this.windowMs))
					burst = Math.min(burst, edit.burst);
			}
			shown = this.onScreen(path, burst);
		});
		return {
			by: (key) => {
				const already = shown?.has(key) === true;
				const mark = already ? { shown: true as const } : {};
				if (withIt !== undefined)
					return { editing: !already, edit: { source: withIt.source, at: 'with', ms: 0, ...mark } };
				if (prior !== undefined && madeAt - prior.when <= this.windowMs)
					return {
						editing: !already,
						edit: { source: prior.source, at: 'before', ms: madeAt - prior.when, ...mark },
					};
				const after = this.lastOf(path);
				return after !== undefined && after.count > before
					? { editing: false, edit: { source: after.source, at: 'after', ms: after.when - madeAt } }
					: { editing: false };
			},
			shown: (key) => this.show(path, key, madeIn),
		};
	}

	/**
	 * A block of `key`, made in the run `from`, is loaded in the note at `note`, until the function
	 * returned is called. A text shown again keeps the run its first block was made in: in the window
	 * after it was last unloaded, that errs towards not waiting only for a text the note had before.
	 */
	private show(note: string, key: string, from: number): () => void {
		this.forget();
		let keys = this.screens.get(note);
		if (keys === undefined) this.screens.set(note, (keys = new Map<string, OnScreen>()));
		let text = keys.get(key);
		if (text === undefined) keys.set(key, (text = { key, loaded: 0, from, to: undefined, at: 0 }));
		const shown = text;
		shown.loaded++;
		shown.from = Math.min(shown.from, from);
		shown.to = undefined;
		let unloaded = false;
		return () => {
			if (unloaded) return;
			unloaded = true;
			if (--shown.loaded > 0) return;
			shown.to = this.thisRun();
			shown.at = this.now();
			this.unloaded.push({ note, text: shown, at: shown.at });
			this.forget();
		};
	}

	/**
	 * The texts the note at `note` had on screen as the edits that began in the run `burst` began: one
	 * made in an earlier run, and still loaded or unloaded no earlier than that run. A block made in the
	 * run of the first edit came with it, as Live Preview makes a keystroke's; one unloaded in it was
	 * on screen as it came, as the edit's own update lets blocks go.
	 */
	private onScreen(note: string, burst: number): ReadonlySet<string> {
		this.forget();
		const keys = new Set<string>();
		for (const text of this.screens.get(note)?.values() ?? []) {
			if (text.from < burst && (text.to === undefined || text.to >= burst)) keys.add(text.key);
		}
		return keys;
	}

	/** Let go of the texts whose last block was unloaded more than the window ago. */
	private forget(): void {
		const now = this.now();
		for (let first = this.unloaded[0]; first !== undefined; first = this.unloaded[0]) {
			if (now - first.at <= this.windowMs) return;
			this.unloaded.shift();
			const { note, text } = first;
			// Shown again since: a later entry lets it go, if it is unloaded again.
			if (text.to === undefined || text.at !== first.at) continue;
			const keys = this.screens.get(note);
			if (keys?.get(text.key) !== text) continue;
			keys.delete(text.key);
			if (keys.size === 0) this.screens.delete(note);
		}
	}

	/** The run of code under way: a new one once the page has run the tasks the last one queued. */
	private thisRun(): number {
		if (!this.running) {
			this.running = true;
			this.run++;
			this.later(() => {
				this.running = false;
			});
		}
		return this.run;
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
