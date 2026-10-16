import type { App, ButtonComponent, SettingDefinitionItem, TextComponent, TFile } from 'obsidian';
import {
	AbstractInputSuggest,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
	requireApiVersion,
} from 'obsidian';
import type TikzjaxNextPlugin from '../main';
import { STRINGS } from '../ui/strings';

/** What a preamble file can be: TeX source, by any of its usual extensions, or plain text. */
const PREAMBLE_EXTENSIONS: ReadonlySet<string> = new Set(['tex', 'sty', 'ltx', 'def', 'txt']);

/**
 * Type-ahead for the preamble path, over the vault's TeX files.
 *
 * AbstractInputSuggest rather than a modal picker: it is the documented way to attach suggestions
 * to a text field, and every part of it this uses is in Obsidian 1.7.2, the plugin's floor
 * (internal/DECISIONS.md D6). A note or an image is never offered; a path typed by hand is still
 * accepted, since the resolver reads any text file.
 */
class PreambleFileSuggest extends AbstractInputSuggest<TFile> {
	private readonly picked: (path: string) => void;

	constructor(app: App, inputEl: HTMLInputElement, picked: (path: string) => void) {
		super(app, inputEl);
		this.picked = picked;
	}

	protected getSuggestions(query: string): TFile[] {
		const needle = query.trim().toLowerCase();
		return this.app.vault
			.getFiles()
			.filter((f) => PREAMBLE_EXTENSIONS.has(f.extension) && f.path.toLowerCase().includes(needle))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	override selectSuggestion(file: TFile): void {
		this.setValue(file.path);
		this.picked(file.path);
		this.close();
	}
}

/**
 * Paint a button as destructive, the way `setWarning` paints it on each version.
 *
 * `setWarning` itself is deprecated since 1.13, which made it `setDestructive().setCta()`; before
 * 1.13 it added the `mod-warning` class, as read in Obsidian 1.12.7. The store's review warns about
 * the deprecated call, and calling `setDestructive` alone would break every version before 1.13,
 * which is the plugin's floor and what Obsidian for iOS ran until recently (internal/DECISIONS.md
 * D6). The store's linter reads `requireApiVersion` in an `if` as the guard it is (D41).
 */
function markDestructive(button: ButtonComponent): ButtonComponent {
	if (requireApiVersion('1.13.0')) return button.setDestructive().setCta();
	button.buttonEl.addClass('mod-warning');
	return button;
}

/**
 * One row of the settings: its name and description, which Obsidian's settings search reads from
 * 1.13 on, and what puts its control on a row that already shows them.
 */
interface Row {
	readonly name: string;
	readonly desc: string;
	/** False where the row would do nothing, which also keeps it out of the search. */
	readonly visible?: boolean;
	/** May return what to do before Obsidian takes the row down to draw it again. */
	readonly render: (setting: Setting) => void | (() => void);
}

interface Section {
	readonly heading: string;
	readonly rows: readonly Row[];
}

/**
 * Settings.
 *
 * Sentence case throughout, no top-level heading, no plugin name in the headings — those are the
 * community-store conventions, and the plugin this forks from violates all three. Every control
 * here maps to a documented behaviour; nothing is offered that the engine cannot honour.
 *
 * The rows are written once, in `sections`, and drawn two ways: by Obsidian from
 * `getSettingDefinitions` on 1.13 and later, which also puts them in its settings search, and by
 * `display` on the versions before (internal/DECISIONS.md D41). Each row builds its own control, as
 * Obsidian's own settings tabs do, so both ways draw the same controls with the same code.
 */
export class TikzSettingTab extends PluginSettingTab {
	private readonly plugin: TikzjaxNextPlugin;
	/** The fields applied when they are left, by row, each applied once more when the tab closes. */
	private readonly onLeave = new Map<string, () => Promise<void>>();

	constructor(app: App, plugin: TikzjaxNextPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Closing the settings is leaving whatever field was being typed in, and the browser does not
	 * promise a `change` event for a focused field taken out of the page.
	 */
	override hide(): void {
		for (const apply of this.onLeave.values()) void apply();
		super.hide();
	}

	/**
	 * The settings for Obsidian 1.13 and later. It reads them when the tab is added, to index them
	 * for its settings search, and draws the tab from them instead of calling `display`. Each row is
	 * named and described by Obsidian and given its control by `render`.
	 */
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((section) => ({
			type: 'group' as const,
			heading: section.heading,
			items: section.rows.map((row) => ({
				name: row.name,
				desc: row.desc,
				visible: row.visible ?? true,
				render: row.render,
			})),
		}));
	}

	/**
	 * The same rows for Obsidian before 1.13, which has no declarative settings and calls this to
	 * draw the tab. 1.13 and later do not call it, since `getSettingDefinitions` returns rows.
	 */
	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.onLeave.clear();
		for (const section of this.sections()) {
			new Setting(containerEl).setName(section.heading).setHeading();
			for (const row of section.rows) {
				if (row.visible === false) continue;
				row.render(new Setting(containerEl).setName(row.name).setDesc(row.desc));
			}
		}
	}

	/**
	 * Apply a text field when it is left — Enter, a click elsewhere, the settings closing, the row
	 * drawn again — rather than at every keystroke, which is when the component's own `onChange`
	 * fires.
	 *
	 * For the preamble paths. Each save re-processes the open notes when it changes how their
	 * blocks are built, and a path typed a letter at a time names a missing file at every letter
	 * but the last: each diagram on screen turned into a "Preamble file not found" card as the
	 * path was typed, and a folder name typed slowly queued compiles under each of its prefixes.
	 * A value left as it was saves nothing, so leaving the field after picking a suggestion, or
	 * closing the settings after leaving it, is not a second change.
	 */
	private applyOnLeave(
		row: string,
		text: TextComponent,
		setting: { get: () => string; set: (value: string) => void },
	): { apply: (value: string) => Promise<void>; cleanup: () => void } {
		const apply = async (value: string): Promise<void> => {
			const trimmed = value.trim();
			if (trimmed === setting.get()) return;
			setting.set(trimmed);
			await this.plugin.saveSettings();
		};
		text.inputEl.addEventListener('change', () => void apply(text.getValue()));
		this.onLeave.set(row, () => apply(text.getValue()));
		return { apply, cleanup: () => void apply(text.getValue()) };
	}

	/** Said of the second engine, with why it does nothing on this computer where it does not. */
	private secondEngineDesc(): string {
		return (
			'Compile two new diagrams at a time when several are waiting. The second engine starts only ' +
			'then, takes more memory while it runs, and stops with the first. A computer that reports ' +
			'less than 8 GB of memory uses one.' +
			// Said, so that a toggle that changes nothing here does not look broken.
			(this.plugin.secondEngineAvailable
				? ''
				: ' This one reports less memory, or fewer processor cores, than a second engine needs.')
		);
	}

	/** The engine's packages once it has started, which it reports only then. */
	private engineDesc(): string {
		const inventory = this.plugin.engineInventory;
		if (!inventory) return 'Not started yet — it boots with the first diagram.';
		const packages = Object.entries(inventory.packages)
			.map(([name, version]) => `${name} ${version}`)
			.join(', ');
		return (
			`${inventory.engine} · ${inventory.files.length} TeX files · ` +
			`expl3 ${inventory.capabilities.expl3 ? 'available' : 'unavailable'}` +
			(packages ? ` · ${packages}` : '')
		);
	}

	/**
	 * Every row, in order. The values are read when a row is drawn, not when this is called:
	 * Obsidian 1.13 and later keep what `getSettingDefinitions` returned and draw from it later,
	 * after the settings may have changed, after Sync brought a new data.json among them.
	 */
	private sections(): Section[] {
		return [
			{
				heading: 'Appearance',
				rows: [
					{
						name: 'Colours',
						desc:
							'How diagram colours follow the theme. Adapt recolours TeX’s default ink and paper ' +
							'only, leaving colours you chose alone. Changing this never recompiles anything.',
						render: (s) => {
							s.addDropdown((d) =>
								d
									.addOptions({
										adapt: 'Adapt to the theme',
										preserve: 'Keep the original colours',
										paper: 'Always on white paper',
										invert: 'Invert in dark mode',
									})
									.setValue(this.plugin.settings.colors)
									.onChange(async (value) => {
										this.plugin.settings.colors =
											value as typeof this.plugin.settings.colors;
										await this.plugin.saveSettings();
									}),
							);
						},
					},
				],
			},
			{
				heading: 'Rendering',
				rows: [
					{
						name: 'Render diagrams lazily',
						desc:
							'Compile a diagram when it comes into view rather than when the note opens. ' +
							'Manual adds a button instead, for notes with very heavy diagrams.',
						render: (s) => {
							s.addDropdown((d) =>
								d
									.addOptions({
										on: 'When scrolled into view',
										off: 'Immediately',
										manual: 'On demand',
									})
									.setValue(this.plugin.settings.lazy)
									.onChange(async (value) => {
										this.plugin.settings.lazy = value as typeof this.plugin.settings.lazy;
										await this.plugin.saveSettings();
									}),
							);
						},
					},
					{
						name: 'Fast mode',
						desc:
							'Skip SVG optimisation and the pre-flight check, and render ahead of other diagrams. ' +
							'Fast and full renders are cached separately, so switching back costs nothing.',
						render: (s) => {
							s.addToggle((t) =>
								t.setValue(this.plugin.settings.fast).onChange(async (value) => {
									this.plugin.settings.fast = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
					// Desktop only: a phone or tablet runs one engine whatever this says
					// (platform/budgets.ts `engineCount`), and a toggle that did nothing there would
					// only mislead.
					{
						name: 'Second engine',
						desc: this.secondEngineDesc(),
						visible: !Platform.isMobile,
						render: (s) => {
							s.setDesc(this.secondEngineDesc());
							s.addToggle((t) =>
								t.setValue(this.plugin.settings.secondEngine).onChange(async (value) => {
									this.plugin.settings.secondEngine = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
					// On every platform: the switch for saved preambles (internal/DECISIONS.md D32) has
					// to be reachable where data.json is not, on a phone above all, should a diagram draw
					// differently from one. The host reads it for each diagram, so it applies to the
					// next. It covers the ones kept in this device's storage across restarts too (D36),
					// which turning it off deletes.
					{
						name: 'Saved preambles',
						desc:
							'Start a diagram where an earlier one with the same packages and preamble stood once ' +
							'its preamble was loaded, and compile only its body. They are kept on this device, ' +
							'never in the vault, so that the first diagram after a restart starts there too; ' +
							'turning this off deletes them. Turn this off if a diagram draws differently with it, ' +
							'and please report that diagram.',
						render: (s) => {
							s.addToggle((t) =>
								t.setValue(this.plugin.settings.preambleSnapshots).onChange(async (value) => {
									this.plugin.settings.preambleSnapshots = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
					{
						name: 'Time limit per diagram',
						desc: 'Seconds before a diagram is abandoned and the engine restarted. 0 uses the built-in limit.',
						render: (s) => {
							s.addText((t) =>
								t
									.setPlaceholder('0')
									.setValue(String(this.plugin.settings.timeoutSeconds))
									.onChange(async (value) => {
										const n = Number(value);
										if (!Number.isFinite(n) || n < 0) return;
										this.plugin.settings.timeoutSeconds = n;
										await this.plugin.saveSettings();
									}),
							);
						},
					},
				],
			},
			{
				heading: 'Source',
				rows: [
					{
						name: 'Source handling',
						desc:
							'Corrected preserves blank lines, so a \\par in a diagram takes effect. The previous ' +
							'plugin deleted every blank line, so switching to corrected can change how an ' +
							'existing diagram renders — legacy reproduces the old behaviour exactly.',
						render: (s) => {
							s.addDropdown((d) =>
								d
									.addOptions({
										corrected: 'Corrected',
										legacy: 'Legacy (previous plugin)',
									})
									.setValue(this.plugin.settings.sourceHandling)
									.onChange(async (value) => {
										this.plugin.settings.sourceHandling = value as 'corrected' | 'legacy';
										await this.plugin.saveSettings();
									}),
							);
						},
					},
					{
						name: 'Check diagrams before compiling',
						desc:
							'Warn about problems that TeX reports late or not at all — a second \\documentclass, ' +
							'an unbundled package, a pgfplots library that is not shipped.',
						render: (s) => {
							s.addToggle((t) =>
								t.setValue(this.plugin.settings.preflight).onChange(async (value) => {
									this.plugin.settings.preflight = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
				],
			},
			// Both settings existed, and were read by every render, with no way to set them but
			// editing data.json. They resolve in this order, before a block's own `preamble=` and
			// `%:input` lines (preamble/resolve.ts), and each file is part of the cache key, so editing
			// one recompiles exactly the diagrams that read it.
			{
				heading: 'Preamble',
				rows: [
					{
						name: 'Preamble file',
						desc:
							'A file in the vault whose contents go before every diagram: packages, macros, ' +
							'styles. Leave empty for none.',
						render: (s) => {
							let cleanup = (): void => undefined;
							s.addText((t) => {
								t.setPlaceholder('preambles/tikz.tex').setValue(
									this.plugin.settings.preamblePath,
								);
								const leave = this.applyOnLeave('Preamble file', t, {
									get: () => this.plugin.settings.preamblePath,
									set: (value) => {
										this.plugin.settings.preamblePath = value;
									},
								});
								new PreambleFileSuggest(
									this.app,
									t.inputEl,
									(path) => void leave.apply(path),
								);
								cleanup = leave.cleanup;
							});
							return cleanup;
						},
					},
					{
						name: 'Folder preamble file name',
						desc:
							'Also use the nearest file with this name in the note’s folder or a folder above it, ' +
							'after the preamble file. Leave empty to turn this off.',
						render: (s) => {
							let cleanup = (): void => undefined;
							s.addText((t) => {
								t.setValue(this.plugin.settings.autoPreambleName);
								cleanup = this.applyOnLeave('Folder preamble file name', t, {
									get: () => this.plugin.settings.autoPreambleName,
									set: (value) => {
										this.plugin.settings.autoPreambleName = value;
									},
								}).cleanup;
							});
							return cleanup;
						},
					},
				],
			},
			{
				heading: 'Diagnostics',
				rows: [
					{
						name: 'Capture the TeX log',
						desc: 'Needed for error messages to name the problem and the line. Costs nothing when nothing fails.',
						render: (s) => {
							s.addToggle((t) =>
								t.setValue(this.plugin.settings.captureLog).onChange(async (value) => {
									this.plugin.settings.captureLog = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
				],
			},
			{
				heading: 'Cache',
				rows: [
					{
						name: 'Cached diagrams',
						desc: 'The diagrams already drawn on this device, kept so that they do not compile again.',
						render: (s) => {
							const count = (): void => {
								void this.plugin.cache?.stats().then((stats) => {
									s.setDesc(
										STRINGS.cacheStats(
											stats.entries,
											`${(stats.bytes / 1048576).toFixed(1)} MB`,
										),
									);
								});
							};
							s.setDesc('Counting…');
							s.addButton((b) =>
								markDestructive(b)
									.setButtonText('Clear')
									.onClick(async () => {
										await this.plugin.cache?.clear();
										new Notice(STRINGS.cacheCleared);
										// Only the count changes, so only the count is read again: not
										// `display()`, deprecated since 1.13, nor 1.13's `update()`, which
										// the versions before it do not have.
										count();
									}),
							);
							count();
						},
					},
					{
						name: 'Reuse the previous plugin’s cache',
						desc:
							'Read diagrams already rendered by the original TikZJax plugin instead of recompiling ' +
							'them. Its records are only read, never deleted, so the original keeps working if you ' +
							'still use it.',
						render: (s) => {
							s.addToggle((t) =>
								t.setValue(this.plugin.settings.importLegacyCache).onChange(async (value) => {
									this.plugin.settings.importLegacyCache = value;
									await this.plugin.saveSettings();
								}),
							);
						},
					},
				],
			},
			{
				heading: 'Engine',
				rows: [
					{
						name: 'Bundled TeX engine',
						desc: this.engineDesc(),
						render: (s) => {
							s.setDesc(this.engineDesc());
						},
					},
				],
			},
		];
	}
}
