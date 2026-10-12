import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import * as obsidian from 'obsidian';
import { DEFAULT_SETTINGS, type TikzSettings } from '../src/settings/schema';
import { TikzSettingTab } from '../src/settings/tab';
import type TikzjaxNextPlugin from '../src/main';

/**
 * The settings tab, against a recording stand-in for the slice of Obsidian's API it uses. Obsidian
 * draws the controls; what can go wrong here is which controls exist and what they write.
 */

vi.mock('obsidian', () => {
	class FakeInput {
		value = '';
	}

	class FakeText {
		readonly inputEl = new FakeInput();
		placeholder = '';
		changed: ((value: string) => unknown) | null = null;
		setPlaceholder(value: string): this {
			this.placeholder = value;
			return this;
		}
		setValue(value: string): this {
			this.inputEl.value = value;
			return this;
		}
		onChange(callback: (value: string) => unknown): this {
			this.changed = callback;
			return this;
		}
		/** What typing does: the input changes, then the callback runs. */
		type(value: string): unknown {
			this.inputEl.value = value;
			return this.changed?.(value);
		}
	}

	class FakeControl {
		addOptions(): this {
			return this;
		}
		setValue(): this {
			return this;
		}
		onChange(): this {
			return this;
		}
		setWarning(): this {
			return this;
		}
		setButtonText(): this {
			return this;
		}
		onClick(): this {
			return this;
		}
	}

	class Setting {
		static all: Setting[] = [];
		name = '';
		desc = '';
		heading = false;
		readonly texts: FakeText[] = [];
		constructor() {
			Setting.all.push(this);
		}
		setName(name: string): this {
			this.name = name;
			return this;
		}
		setDesc(desc: string): this {
			this.desc = desc;
			return this;
		}
		setHeading(): this {
			this.heading = true;
			return this;
		}
		addText(build: (text: FakeText) => void): this {
			const text = new FakeText();
			this.texts.push(text);
			build(text);
			return this;
		}
		addDropdown(build: (control: FakeControl) => void): this {
			build(new FakeControl());
			return this;
		}
		addToggle(build: (control: FakeControl) => void): this {
			build(new FakeControl());
			return this;
		}
		addButton(build: (control: FakeControl) => void): this {
			build(new FakeControl());
			return this;
		}
	}

	class PluginSettingTab {
		readonly app: unknown;
		readonly containerEl = { empty: (): void => undefined };
		constructor(app: unknown) {
			this.app = app;
		}
	}

	class AbstractInputSuggest<T> {
		static all: Array<AbstractInputSuggest<unknown>> = [];
		readonly app: unknown;
		readonly inputEl: FakeInput;
		limit = 100;
		closed = false;
		constructor(app: unknown, inputEl: FakeInput) {
			this.app = app;
			this.inputEl = inputEl;
			AbstractInputSuggest.all.push(this as AbstractInputSuggest<unknown>);
		}
		setValue(value: string): void {
			this.inputEl.value = value;
		}
		close(): void {
			this.closed = true;
		}
		/** Overridden by the real subclass. */
		getSuggestions(_query: string): T[] {
			return [];
		}
	}

	class Notice {}

	return { Setting, PluginSettingTab, AbstractInputSuggest, Notice };
});

interface RecordedText {
	readonly inputEl: { value: string };
	readonly placeholder: string;
	type(value: string): unknown;
}

interface RecordedSetting {
	readonly name: string;
	readonly desc: string;
	readonly heading: boolean;
	readonly texts: RecordedText[];
}

interface RecordedSuggest {
	readonly inputEl: { value: string };
	readonly closed: boolean;
	getSuggestions(query: string): Array<{ path: string }>;
	selectSuggestion(file: { path: string }, evt: unknown): void;
}

const fakes = obsidian as unknown as {
	Setting: { all: RecordedSetting[] };
	AbstractInputSuggest: { all: RecordedSuggest[] };
};

function file(path: string): { path: string; extension: string } {
	return { path, extension: path.slice(path.lastIndexOf('.') + 1) };
}

const FILES = [
	file('notes/maths.md'),
	file('preambles/tikz.tex'),
	file('tikz-preamble.tex'),
	file('attachments/diagram.png'),
	file('macros/physics.sty'),
	file('Courses/Analysis/tikz-preamble.tex'),
];

let settings: TikzSettings;
let saves: number;

function display(): void {
	fakes.Setting.all.length = 0;
	fakes.AbstractInputSuggest.all.length = 0;
	const app = { vault: { getFiles: () => FILES } } as unknown as App;
	const plugin = {
		settings,
		saveSettings: () => {
			saves++;
			return Promise.resolve();
		},
		cache: null,
		engineInventory: null,
	} as unknown as TikzjaxNextPlugin;
	new TikzSettingTab(app, plugin).display();
}

function setting(name: string): RecordedSetting {
	const found = fakes.Setting.all.find((s) => s.name === name && !s.heading);
	if (!found) throw new Error(`no setting named ${name}`);
	return found;
}

beforeEach(() => {
	settings = { ...DEFAULT_SETTINGS };
	saves = 0;
});

describe('settings tab — preamble', () => {
	it('has a Preamble section, after Source', () => {
		display();
		const headings = fakes.Setting.all.filter((s) => s.heading).map((s) => s.name);
		expect(headings).toContain('Preamble');
		expect(headings.indexOf('Preamble')).toBe(headings.indexOf('Source') + 1);
	});

	it('edits the vault-wide preamble file, trimmed', async () => {
		settings.preamblePath = 'old.tex';
		display();
		const field = setting('Preamble file').texts[0]!;
		expect(field.inputEl.value).toBe('old.tex');

		await field.type('  preambles/tikz.tex ');
		expect(settings.preamblePath).toBe('preambles/tikz.tex');
		expect(saves).toBe(1);
	});

	it('edits the folder preamble name, and an empty name turns the lookup off', async () => {
		display();
		const field = setting('Folder preamble file name').texts[0]!;
		expect(field.inputEl.value).toBe('tikz-preamble.tex');

		await field.type('');
		expect(settings.autoPreambleName).toBe('');
		await field.type(' shared.tex ');
		expect(settings.autoPreambleName).toBe('shared.tex');
	});

	it('suggests TeX files from the vault for the preamble file', () => {
		display();
		const suggest = fakes.AbstractInputSuggest.all[0]!;
		expect(suggest.inputEl).toBe(setting('Preamble file').texts[0]!.inputEl);

		expect(suggest.getSuggestions('').map((f) => f.path)).toEqual([
			'Courses/Analysis/tikz-preamble.tex',
			'macros/physics.sty',
			'preambles/tikz.tex',
			'tikz-preamble.tex',
		]);
		expect(suggest.getSuggestions('PREAMBLES').map((f) => f.path)).toEqual(['preambles/tikz.tex']);
		// A note or an image is never a preamble, whatever the query matches.
		expect(suggest.getSuggestions('a').map((f) => f.path)).not.toContain('notes/maths.md');
		expect(suggest.getSuggestions('diagram')).toEqual([]);
	});

	it('saves a picked suggestion', async () => {
		display();
		const suggest = fakes.AbstractInputSuggest.all[0]!;
		suggest.selectSuggestion(file('macros/physics.sty'), {});
		await Promise.resolve();

		expect(settings.preamblePath).toBe('macros/physics.sty');
		expect(suggest.inputEl.value).toBe('macros/physics.sty');
		expect(suggest.closed).toBe(true);
		expect(saves).toBe(1);
	});
});
