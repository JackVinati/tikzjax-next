import { TFile, type App } from 'obsidian';
import type { Diagnostic } from '../types';
import { resolvePreamble, type PreambleSource, type ResolvedPreamble } from './resolve';

/**
 * Preambles that live in the vault. Upstream #46, #76, #77, #83.
 *
 * Two things live here that the pure resolver deliberately does not know about: how to turn a path
 * as a user writes it into a file, and what to do when that file changes.
 *
 * Resolution goes through `metadataCache.getFirstLinkpathDest`, not raw path joining, so a
 * note-relative path works the same way a `[[link]]` does. Three separate commenters on PR #77 were
 * confused by exactly that: they wrote a path relative to their note and the plugin looked for it
 * relative to the vault root.
 */
export class PreambleService {
	private readonly app: App;
	private readonly hash: (text: string) => string;

	/**
	 * file path -> the block cache keys on the page that were built from it, each with the number
	 * of blocks showing it (the same diagram in two panes is one key and two blocks).
	 */
	private readonly dependents = new Map<string, Map<string, number>>();
	/** Resolutions are memoised per note+options; cleared wholesale when any dependency changes. */
	private readonly cache = new Map<string, ResolvedPreamble>();

	constructor(app: App, hash: (text: string) => string) {
		this.app = app;
		this.hash = hash;
	}

	/**
	 * The file to walk up for, e.g. `tikz-preamble.tex`.
	 *
	 * Walking up from the note rather than looking in one fixed place is PR #100's idea and it is
	 * the right one: a preamble usually belongs to a folder of related notes, not to the vault.
	 */
	findWalkUp(notePath: string, fileName: string): string | null {
		if (!fileName) return null;
		let dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
		for (;;) {
			const candidate = dir ? `${dir}/${fileName}` : fileName;
			if (this.app.vault.getAbstractFileByPath(candidate) instanceof TFile) return candidate;
			if (!dir) return null;
			dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
		}
	}

	private source(): PreambleSource {
		return {
			resolve: (path, fromNotePath) => {
				const file = this.app.metadataCache.getFirstLinkpathDest(path, fromNotePath);
				if (file) return file.path;
				// A bare path that is not a link target may still be a literal vault path.
				const direct = this.app.vault.getAbstractFileByPath(path);
				return direct instanceof TFile ? direct.path : null;
			},
			read: async (canonicalPath) => {
				const file = this.app.vault.getAbstractFileByPath(canonicalPath);
				if (!(file instanceof TFile)) throw new Error(`not a file: ${canonicalPath}`);
				// cachedRead, not read: this runs for every block in a note and the same preamble
				// file is usually shared by all of them.
				return this.app.vault.cachedRead(file);
			},
		};
	}

	async resolve(entry: {
		globalPath: string | null;
		/** The file name to walk up for, e.g. `tikz-preamble.tex`. Empty disables the level. */
		walkUpName: string;
		blockPath: string | null;
		inputs: string[];
		notePath: string;
	}): Promise<ResolvedPreamble> {
		// §7.7's second precedence level. Review caught that findWalkUp existed, was correct, and was
		// called by nobody — the auto-discovered preamble was dead code, which is the kind of gap
		// that reads as "implemented" in every summary and does nothing in the vault.
		const walkUpPath = this.findWalkUp(entry.notePath, entry.walkUpName);

		const cacheKey = JSON.stringify([
			entry.notePath,
			entry.globalPath,
			walkUpPath,
			entry.blockPath,
			entry.inputs,
		]);
		const hit = this.cache.get(cacheKey);
		if (hit) return hit;

		const resolved = await resolvePreamble(
			{ globalPath: entry.globalPath, walkUpPath, blockPath: entry.blockPath, inputs: entry.inputs },
			entry.notePath,
			this.source(),
			this.hash,
		);
		this.cache.set(cacheKey, resolved);
		return resolved;
	}

	/** Record that a block's artifact depends on these files, so a change can invalidate it. */
	track(blockKey: string, deps: readonly string[]): void {
		for (const dep of deps) {
			let keys = this.dependents.get(dep);
			if (!keys) {
				keys = new Map();
				this.dependents.set(dep, keys);
			}
			keys.set(blockKey, (keys.get(blockKey) ?? 0) + 1);
		}
	}

	/**
	 * The block is gone. Called with what `track` was given, when the block unloads.
	 *
	 * Without it, only a change to the file ever removed a key, so a session spent editing a diagram
	 * that uses a preamble kept one for every version of it. A block nobody can see needs no
	 * invalidating: should it come back, it is processed again against the file as it is then.
	 */
	untrack(blockKey: string, deps: readonly string[]): void {
		for (const dep of deps) {
			const keys = this.dependents.get(dep);
			const count = keys?.get(blockKey);
			// Already gone: the file changed while the block was up, and `invalidate` took the lot.
			if (!keys || count === undefined) continue;
			if (count > 1) keys.set(blockKey, count - 1);
			else keys.delete(blockKey);
			if (keys.size === 0) this.dependents.delete(dep);
		}
	}

	/**
	 * A dependency changed. Returns the block keys whose cached artifacts are now wrong.
	 *
	 * This is the limitation PR #77's author conceded openly: edit the preamble and nothing
	 * notices, because the cache key was derived from the block source alone. The keys are
	 * returned rather than acted on, so the caller decides whether to drop them, re-render the
	 * visible ones, or both.
	 */
	invalidate(path: string): string[] {
		this.cache.clear();
		const affected = this.dependents.get(path);
		if (!affected) return [];
		this.dependents.delete(path);
		return [...affected.keys()];
	}

	/** Every file a block on the page depends on. */
	trackedFiles(): string[] {
		return [...this.dependents.keys()];
	}

	clear(): void {
		this.cache.clear();
		this.dependents.clear();
	}

	/** Missing files and cycles, surfaced beside the diagram instead of silently splicing nothing. */
	static diagnostics(resolved: ResolvedPreamble): Diagnostic[] {
		return resolved.diagnostics;
	}
}
