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
		private readonly listeners = new Map<string, Array<() => void>>();
		addEventListener(type: string, listener: () => void): void {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		dispatch(type: string): void {
			for (const listener of this.listeners.get(type) ?? []) listener();
		}
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
		getValue(): string {
			return this.inputEl.value;
		}
		onChange(callback: (value: string) => unknown): this {
			this.changed = callback;
			return this;
		}
		/**
		 * What typing does: the input changes, then the component's callback runs — on every
		 * keystroke, since Obsidian wires it to the `input` event.
		 */
		type(value: string): unknown {
			this.inputEl.value = value;
			this.inputEl.dispatch('input');
			return this.changed?.(value);
		}
		/** What Enter or leaving the field does: the browser's `change` event. */
		leave(): void {
			this.inputEl.dispatch('change');
		}
	}

	class FakeControl {
		value: unknown = undefined;
		changed: ((value: unknown) => unknown) | null = null;
		addOptions(): this {
			return this;
		}
		setValue(value: unknown): this {
			this.value = value;
			return this;
		}
		onChange(callback: (value: unknown) => unknown): this {
			this.changed = callback;
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
		readonly controls: FakeControl[] = [];
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
			const control = new FakeControl();
			this.controls.push(control);
			build(control);
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
		hidden = false;
		constructor(app: unknown) {
			this.app = app;
		}
		hide(): void {
			this.hidden = true;
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

	/** Mutable, so a test can be a phone. */
	const Platform = { isMobile: false };

	return { Setting, PluginSettingTab, AbstractInputSuggest, Notice, Platform };
});

interface RecordedText {
	readonly inputEl: { value: string };
	readonly placeholder: string;
	type(value: string): unknown;
	leave(): void;
}

interface RecordedControl {
	readonly value: unknown;
	readonly changed: ((value: unknown) => unknown) | null;
}

interface RecordedSetting {
	readonly name: string;
	readonly desc: string;
	readonly heading: boolean;
	readonly texts: RecordedText[];
	readonly controls: RecordedControl[];
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
	Platform: { isMobile: boolean };
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
/** What the plugin says of this computer's memory and cores (main.ts `secondEngineAvailable`). */
let secondEngineAvailable: boolean;

function display(): TikzSettingTab {
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
		secondEngineAvailable,
	} as unknown as TikzjaxNextPlugin;
	const tab = new TikzSettingTab(app, plugin);
	tab.display();
	return tab;
}

function setting(name: string): RecordedSetting {
	const found = fakes.Setting.all.find((s) => s.name === name && !s.heading);
	if (!found) throw new Error(`no setting named ${name}`);
	return found;
}

beforeEach(() => {
	settings = { ...DEFAULT_SETTINGS };
	saves = 0;
	secondEngineAvailable = true;
	fakes.Platform.isMobile = false;
});

describe('settings tab — second engine', () => {
	it('offers the second engine on a computer, on by default, and turning it off saves', async () => {
		display();
		const toggle = setting('Second engine').controls[0]!;
		expect(toggle.value).toBe(true);

		await toggle.changed?.(false);
		expect(settings.secondEngine).toBe(false);
		expect(saves).toBe(1);
	});

	it('says that a computer reporting less than 8 GB uses one, and so does this one where it is such', () => {
		display();
		const desc = setting('Second engine').desc;
		expect(desc).toContain('A computer that reports less than 8 GB of memory uses one.');
		expect(desc).not.toContain('This one');

		secondEngineAvailable = false;
		display();
		expect(setting('Second engine').desc).toContain(
			'This one reports less memory, or fewer processor cores, than a second engine needs.',
		);
	});

	it('does not offer it on a phone or a tablet, which run one engine whatever it says', () => {
		fakes.Platform.isMobile = true;
		display();
		expect(fakes.Setting.all.some((s) => s.name === 'Second engine')).toBe(false);
	});
});

describe('settings tab — saved preambles', () => {
	/*
	 * The one switch for saved preambles (internal/DECISIONS.md D32), which a phone has to reach too:
	 * its data.json is in a folder the Files app hides.
	 */
	for (const mobile of [false, true]) {
		it(`offers them ${mobile ? 'on a phone or a tablet' : 'on a computer'}, on by default, and turning them off saves`, async () => {
			fakes.Platform.isMobile = mobile;
			display();
			const toggle = setting('Saved preambles').controls[0]!;
			expect(toggle.value).toBe(true);
			await toggle.changed?.(false);
			expect(settings.preambleSnapshots).toBe(false);
			expect(saves).toBe(1);
			expect(setting('Saved preambles').desc).toContain('Turn this off if a diagram draws differently');
			expect(setting('Saved preambles').desc).toContain('never in the vault');
			expect(setting('Saved preambles').desc).toContain('turning this off deletes them');
		});
	}
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
		field.leave();
		await Promise.resolve();
		expect(settings.preamblePath).toBe('preambles/tikz.tex');
		expect(saves).toBe(1);
	});

	it('edits the folder preamble name, and an empty name turns the lookup off', async () => {
		display();
		const field = setting('Folder preamble file name').texts[0]!;
		expect(field.inputEl.value).toBe('tikz-preamble.tex');

		await field.type('');
		field.leave();
		expect(settings.autoPreambleName).toBe('');
		await field.type(' shared.tex ');
		field.leave();
		expect(settings.autoPreambleName).toBe('shared.tex');
	});

	/**
	 * Every save re-processes the open notes, and a path typed a letter at a time names a missing
	 * file at every letter but the last: each diagram on screen turned into a "Preamble file not
	 * found" card while the path was being typed, and a folder name typed slowly queued compiles
	 * under each of its prefixes.
	 */
	for (const name of ['Preamble file', 'Folder preamble file name']) {
		it(`applies ${name.toLowerCase()} once the field is left, not at every keystroke`, async () => {
			const before = { ...settings };
			display();
			const field = setting(name).texts[0]!;

			for (const typed of ['p', 'pr', 'pre', 'preambles/tikz.tex']) await field.type(typed);
			expect(saves).toBe(0);
			expect(settings).toEqual(before);

			field.leave();
			await Promise.resolve();
			expect(saves).toBe(1);
			expect(settings).not.toEqual(before);
		});
	}

	it('applies a path still being typed when the settings are closed', async () => {
		const tab = display();
		await setting('Preamble file').texts[0]!.type('preambles/tikz.tex');
		await setting('Folder preamble file name').texts[0]!.type('shared.tex');
		expect(saves).toBe(0);

		tab.hide();
		await Promise.resolve();
		expect(settings.preamblePath).toBe('preambles/tikz.tex');
		expect(settings.autoPreambleName).toBe('shared.tex');
		expect(saves).toBe(2);
	});

	it('does not save a field that is left as it was', async () => {
		settings.preamblePath = 'old.tex';
		const tab = display();
		const field = setting('Preamble file').texts[0]!;

		await field.type('old.te');
		await field.type('old.tex ');
		field.leave();
		tab.hide();
		await Promise.resolve();
		expect(saves).toBe(0);
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
		const tab = display();
		const suggest = fakes.AbstractInputSuggest.all[0]!;
		suggest.selectSuggestion(file('macros/physics.sty'), {});
		await Promise.resolve();

		expect(settings.preamblePath).toBe('macros/physics.sty');
		expect(suggest.inputEl.value).toBe('macros/physics.sty');
		expect(suggest.closed).toBe(true);
		expect(saves).toBe(1);

		// Leaving the field afterwards, or closing the settings, is not a second change.
		setting('Preamble file').texts[0]!.leave();
		tab.hide();
		await Promise.resolve();
		expect(saves).toBe(1);
	});
});
