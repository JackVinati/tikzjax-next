import type { App } from 'obsidian';
import { TFile } from './obsidian';

/**
 * An `App` with a vault made of a path -> text map, as much of one as the processor and the
 * preamble service reach: file lookup, `cachedRead`, link resolution and the workspace's document.
 *
 * Link resolution is the vault-root lookup only. Note-relative resolution is resolve.ts's business
 * and is tested there against a fake that has it; here a test names files by their full path.
 */
export function fakeApp(files: Record<string, string> = {}): App & { files: Map<string, string> } {
	const contents = new Map(Object.entries(files));
	const fileAt = (path: string): TFile | null => (contents.has(path) ? new TFile(path) : null);

	return {
		files: contents,
		vault: {
			getAbstractFileByPath: (path: string) => fileAt(path),
			cachedRead: (file: TFile) => {
				const text = contents.get(file.path);
				return text === undefined
					? Promise.reject(new Error(`not a file: ${file.path}`))
					: Promise.resolve(text);
			},
		},
		metadataCache: {
			getFirstLinkpathDest: (path: string) => fileAt(path),
		},
		workspace: {
			containerEl: document.body,
		},
	} as unknown as App & { files: Map<string, string> };
}
