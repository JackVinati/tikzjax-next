import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import * as obsidian from 'obsidian';
import { DEFAULT_SETTINGS, type TikzSettings } from '../src/settings/schema';
import { TikzSettingTab } from '../src/settings/tab';
import type TikzjaxNextPlugin from '../src/main';
import { STRINGS } from '../src/ui/strings';

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
		clicked: (() => unknown) | null = null;
		readonly calls: string[] = [];
		readonly buttonEl = {
			classes: [] as string[],
			addClass(cls: string): void {
				this.classes.push(cls);
			},
		};
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
			this.calls.push('setWarning');
			return this;
		}
		setDestructive(): this {
			this.calls.push('setDestructive');
			return this;
		}
		setCta(): this {
			this.calls.push('setCta');
			return this;
		}
		setButtonText(): this {
			return this;
		}
		onClick(callback: () => unknown): this {
			this.clicked = callback;
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
		readonly buttons: FakeControl[] = [];
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
			const button = new FakeControl();
			this.buttons.push(button);
			build(button);
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

	/** The Obsidian version the tab runs on, mutable so a test can be one before 1.13. */
	const Api = { version: '1.14.4' };
	function requireApiVersion(version: string): boolean {
		const have = Api.version.split('.').map(Number);
		const want = version.split('.').map(Number);
		for (let i = 0; i < 3; i++) {
			const a = have[i] ?? 0;
			const b = want[i] ?? 0;
			if (a !== b) return a > b;
		}
		return true;
	}

	return { Setting, PluginSettingTab, AbstractInputSuggest, Notice, Platform, Api, requireApiVersion };
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
	readonly clicked: (() => unknown) | null;
	readonly calls: string[];
	readonly buttonEl: { classes: string[] };
}

interface RecordedSetting {
	readonly name: string;
	readonly desc: string;
	readonly heading: boolean;
	readonly texts: RecordedText[];
	readonly controls: RecordedControl[];
	readonly buttons: RecordedControl[];
	setName(name: string): RecordedSetting;
	setDesc(desc: string): RecordedSetting;
	setHeading(): RecordedSetting;
}

interface RecordedSuggest {
	readonly inputEl: { value: string };
	readonly closed: boolean;
	getSuggestions(query: string): Array<{ path: string }>;
	selectSuggestion(file: { path: string }, evt: unknown): void;
}

const fakes = obsidian as unknown as {
	Setting: { all: RecordedSetting[]; new (): RecordedSetting };
	AbstractInputSuggest: { all: RecordedSuggest[] };
	Platform: { isMobile: boolean };
	Api: { version: string };
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
/** The plugin's diagram cache, or null before it has opened. */
let cache: { stats: () => Promise<{ entries: number; bytes: number }>; clear: () => Promise<void> } | null;
/** Who draws the tab: its own `display()`, as before Obsidian 1.13, or 1.13 and later from its definitions. */
let drawnBy: 'display' | 'definitions';
/** What the rows drawn from the definitions gave to run before Obsidian takes them down. */
let cleanups: Array<() => void>;

function newTab(): TikzSettingTab {
	const app = { vault: { getFiles: () => FILES } } as unknown as App;
	const plugin = {
		settings,
		saveSettings: () => {
			saves++;
			return Promise.resolve();
		},
		cache,
		engineInventory: null,
		secondEngineAvailable,
	} as unknown as TikzjaxNextPlugin;
	return new TikzSettingTab(app, plugin);
}

/**
 * What Obsidian 1.13 and later do with the definitions, as read in its 1.14.4 bundle: a group under
 * each heading, and in it, for each row it shows, a row it names and describes before it hands it
 * to the definition's `render`.
 */
function drawDefinitions(tab: TikzSettingTab): void {
	for (const group of tab.getSettingDefinitions()) {
		if (!('type' in group) || group.type !== 'group') throw new Error('expected only groups');
		new fakes.Setting().setName(group.heading ?? '').setHeading();
		for (const item of group.items ?? []) {
			if (!('render' in item) || !item.render) throw new Error(`expected a rendered row: ${item.name}`);
			const visible = typeof item.visible === 'function' ? item.visible() : (item.visible ?? true);
			if (!visible) continue;
			const row = new fakes.Setting()
				.setName(item.name)
				.setDesc(typeof item.desc === 'string' ? item.desc : '');
			const cleanup = item.render(row as unknown as obsidian.Setting, {} as obsidian.SettingGroup);
			if (cleanup) cleanups.push(cleanup);
		}
	}
}

function draw(tab: TikzSettingTab, by: 'display' | 'definitions'): void {
	fakes.Setting.all.length = 0;
	fakes.AbstractInputSuggest.all.length = 0;
	cleanups = [];
	if (by === 'display') tab.display();
	else drawDefinitions(tab);
}

function display(): TikzSettingTab {
	const tab = newTab();
	draw(tab, drawnBy);
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
	cache = null;
	drawnBy = 'display';
	cleanups = [];
	fakes.Platform.isMobile = false;
	fakes.Api.version = '1.14.4';
});

/** The rows of the definitions, which drawDefinitions checks are all rendered rows inside groups. */
function definedRows(tab: TikzSettingTab): obsidian.SettingDefinitionRender[] {
	return tab
		.getSettingDefinitions()
		.flatMap((g) =>
			'type' in g && g.type === 'group' ? (g.items ?? []) : [],
		) as obsidian.SettingDefinitionRender[];
}

/** The rows as drawn, each with what it shows and which controls it has, headings included. */
function drawn(): string[] {
	return fakes.Setting.all.map(
		(s) =>
			`${s.heading ? '#' : ''}${s.name} | ${s.desc} | ` +
			`${s.texts.length} text ${s.controls.length} toggle ${s.buttons.length} button`,
	);
}

describe('settings tab — the two ways it is drawn', () => {
	/*
	 * The rows are written once and drawn two ways (internal/DECISIONS.md D41): by Obsidian 1.13 and
	 * later from getSettingDefinitions, which also puts them in its settings search, and by display()
	 * on the versions before.
	 */
	for (const mobile of [false, true]) {
		it(`draws the same rows both ways ${mobile ? 'on a phone' : 'on a computer'}`, () => {
			fakes.Platform.isMobile = mobile;
			const tab = newTab();
			draw(tab, 'display');
			const byDisplay = drawn();
			draw(tab, 'definitions');
			expect(drawn()).toEqual(byDisplay);
			expect(byDisplay.length).toBeGreaterThan(15);
		});
	}

	it('gives every row a name and a description for the settings search', () => {
		const groups = newTab().getSettingDefinitions();
		expect(groups.map((g) => ('heading' in g ? g.heading : undefined))).toEqual([
			'Appearance',
			'Rendering',
			'Source',
			'Preamble',
			'Diagnostics',
			'Cache',
			'Engine',
		]);
		for (const row of definedRows(newTab())) {
			expect(row.name).not.toBe('');
			expect(typeof row.desc === 'string' && row.desc.length > 20, row.name).toBe(true);
		}
	});

	it('keeps the second engine out of the search on a phone, where it is not offered', () => {
		fakes.Platform.isMobile = true;
		const rows = definedRows(newTab());
		expect(rows.find((r) => r.name === 'Second engine')).toMatchObject({ visible: false });
		expect(rows.find((r) => r.name === 'Saved preambles')).toMatchObject({ visible: true });
	});

	it('applies a path still being typed when Obsidian draws the row again', async () => {
		drawnBy = 'definitions';
		display();
		await setting('Preamble file').texts[0]!.type('preambles/tikz.tex');
		expect(saves).toBe(0);

		for (const cleanup of cleanups) cleanup();
		await Promise.resolve();
		expect(settings.preamblePath).toBe('preambles/tikz.tex');
		expect(saves).toBe(1);
	});
});

describe('settings tab — cache', () => {
	beforeEach(() => {
		cache = {
			stats: vi.fn(() => Promise.resolve({ entries: 3, bytes: 3 * 1048576 })),
			clear: vi.fn(() => Promise.resolve()),
		};
	});

	for (const by of ['display', 'definitions'] as const) {
		it(`counts the cached diagrams, and after Clear counts them again without drawing the tab again (${by})`, async () => {
			drawnBy = by;
			display();
			expect(setting('Cached diagrams').desc).toBe('Counting…');
			await Promise.resolve();
			await Promise.resolve();
			expect(setting('Cached diagrams').desc).toBe(STRINGS.cacheStats(3, '3.0 MB'));

			const rows = fakes.Setting.all.length;
			await setting('Cached diagrams').buttons[0]!.clicked?.();
			await Promise.resolve();
			expect(cache?.clear).toHaveBeenCalledTimes(1);
			expect(cache?.stats).toHaveBeenCalledTimes(2);
			expect(fakes.Setting.all.length).toBe(rows);
		});
	}

	/*
	 * `setWarning` is deprecated since 1.13, where it became setDestructive().setCta(); before 1.13 it
	 * added `mod-warning`, as read in Obsidian 1.12.7. The button looks as it did on each.
	 */
	it('paints Clear as destructive with 1.13’s calls from 1.13 on', () => {
		display();
		const clear = setting('Cached diagrams').buttons[0]!;
		expect(clear.calls).toEqual(['setDestructive', 'setCta']);
		expect(clear.buttonEl.classes).toEqual([]);
	});

	it('paints Clear as setWarning did before 1.13, without calling it', () => {
		fakes.Api.version = '1.12.7';
		display();
		const clear = setting('Cached diagrams').buttons[0]!;
		expect(clear.calls).toEqual([]);
		expect(clear.buttonEl.classes).toEqual(['mod-warning']);
	});
});

for (const by of ['display', 'definitions'] as const)
	describe(`settings tab, drawn by ${by === 'display' ? 'display()' : 'Obsidian from its definitions'}`, () => {
		beforeEach(() => {
			drawnBy = by;
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
					expect(setting('Saved preambles').desc).toContain(
						'Turn this off if a diagram draws differently',
					);
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
				expect(suggest.getSuggestions('PREAMBLES').map((f) => f.path)).toEqual([
					'preambles/tikz.tex',
				]);
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
	});
