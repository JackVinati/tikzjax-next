import type { App, ButtonComponent, TFile } from 'obsidian';
import { AbstractInputSuggest, Notice, PluginSettingTab, Setting } from 'obsidian';
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
 * Paint a button as destructive.
 *
 * `setWarning`, not its 1.13 replacement `setDestructive`, and deliberately: deprecated is not
 * absent, it works on every version from 0.11.0 up, and calling the new one would raise this
 * plugin's floor to 1.13 for the colour of one button — which on mobile is the difference between
 * installable and not, because Obsidian for iOS trails the desktop (internal/DECISIONS.md D6).
 *
 * Feature-detecting the pair was the first attempt and is worse: the store's linter reads the call
 * textually, cannot see the guard, and reports an error against the floor either way.
 */
function markDestructive(button: ButtonComponent): ButtonComponent {
	return button.setWarning();
}

/**
 * Settings.
 *
 * Sentence case throughout, no top-level heading, no plugin name in the headings — those are the
 * community-store conventions, and the plugin this forks from violates all three. Every control
 * here maps to a documented behaviour; nothing is offered that the engine cannot honour.
 */
export class TikzSettingTab extends PluginSettingTab {
	private readonly plugin: TikzjaxNextPlugin;

	constructor(app: App, plugin: TikzjaxNextPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Appearance').setHeading();

		new Setting(containerEl)
			.setName('Colours')
			.setDesc(
				'How diagram colours follow the theme. Adapt recolours TeX’s default ink and paper only, ' +
					'leaving colours you chose alone. Changing this never recompiles anything.',
			)
			.addDropdown((d) =>
				d
					.addOptions({
						adapt: 'Adapt to the theme',
						preserve: 'Keep the original colours',
						paper: 'Always on white paper',
						invert: 'Invert in dark mode',
					})
					.setValue(this.plugin.settings.colors)
					.onChange(async (value) => {
						this.plugin.settings.colors = value as typeof this.plugin.settings.colors;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Rendering').setHeading();

		new Setting(containerEl)
			.setName('Render diagrams lazily')
			.setDesc(
				'Compile a diagram when it comes into view rather than when the note opens. ' +
					'Manual adds a button instead, for notes with very heavy diagrams.',
			)
			.addDropdown((d) =>
				d
					.addOptions({ on: 'When scrolled into view', off: 'Immediately', manual: 'On demand' })
					.setValue(this.plugin.settings.lazy)
					.onChange(async (value) => {
						this.plugin.settings.lazy = value as typeof this.plugin.settings.lazy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Fast mode')
			.setDesc(
				'Skip SVG optimisation and the pre-flight check, and render ahead of other diagrams. ' +
					'Fast and full renders are cached separately, so switching back costs nothing.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.fast).onChange(async (value) => {
					this.plugin.settings.fast = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Time limit per diagram')
			.setDesc(
				'Seconds before a diagram is abandoned and the engine restarted. 0 uses the built-in limit.',
			)
			.addText((t) =>
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

		new Setting(containerEl).setName('Source').setHeading();

		new Setting(containerEl)
			.setName('Source handling')
			.setDesc(
				'Corrected preserves blank lines, so a \\par in a diagram takes effect. The previous ' +
					'plugin deleted every blank line, so switching to corrected can change how an existing ' +
					'diagram renders — legacy reproduces the old behaviour exactly.',
			)
			.addDropdown((d) =>
				d
					.addOptions({ corrected: 'Corrected', legacy: 'Legacy (previous plugin)' })
					.setValue(this.plugin.settings.sourceHandling)
					.onChange(async (value) => {
						this.plugin.settings.sourceHandling = value as 'corrected' | 'legacy';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Check diagrams before compiling')
			.setDesc(
				'Warn about problems that TeX reports late or not at all — a second \\documentclass, ' +
					'an unbundled package, a pgfplots library that is not shipped.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.preflight).onChange(async (value) => {
					this.plugin.settings.preflight = value;
					await this.plugin.saveSettings();
				}),
			);

		// Both settings existed, and were read by every render, with no way to set them but editing
		// data.json. They resolve in this order, before a block's own `preamble=` and `%:input` lines
		// (preamble/resolve.ts), and each file is part of the cache key, so editing one recompiles
		// exactly the diagrams that read it.
		new Setting(containerEl).setName('Preamble').setHeading();

		const savePreamblePath = async (value: string): Promise<void> => {
			this.plugin.settings.preamblePath = value.trim();
			await this.plugin.saveSettings();
		};
		new Setting(containerEl)
			.setName('Preamble file')
			.setDesc(
				'A file in the vault whose contents go before every diagram: packages, macros, styles. ' +
					'Leave empty for none.',
			)
			.addText((t) => {
				t.setPlaceholder('preambles/tikz.tex')
					.setValue(this.plugin.settings.preamblePath)
					.onChange(savePreamblePath);
				new PreambleFileSuggest(this.app, t.inputEl, (path) => void savePreamblePath(path));
			});

		new Setting(containerEl)
			.setName('Folder preamble file name')
			.setDesc(
				'Also use the nearest file with this name in the note’s folder or a folder above it, ' +
					'after the preamble file. Leave empty to turn this off.',
			)
			.addText((t) =>
				t.setValue(this.plugin.settings.autoPreambleName).onChange(async (value) => {
					this.plugin.settings.autoPreambleName = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Diagnostics').setHeading();

		new Setting(containerEl)
			.setName('Capture the TeX log')
			.setDesc(
				'Needed for error messages to name the problem and the line. Costs nothing when nothing fails.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.captureLog).onChange(async (value) => {
					this.plugin.settings.captureLog = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Cache').setHeading();

		const stats = new Setting(containerEl)
			.setName('Cached diagrams')
			.setDesc('Counting…')
			.addButton((b) =>
				markDestructive(b)
					.setButtonText('Clear')
					.onClick(async () => {
						await this.plugin.cache?.clear();
						new Notice(STRINGS.cacheCleared);
						// `display()`, not 1.13's `update()`: it does the same thing here — clear the
						// container and rebuild — and works all the way down to this plugin's floor.
						this.display();
					}),
			);

		void this.plugin.cache?.stats().then((s) => {
			stats.setDesc(STRINGS.cacheStats(s.entries, `${(s.bytes / 1048576).toFixed(1)} MB`));
		});

		new Setting(containerEl)
			.setName('Reuse the previous plugin’s cache')
			.setDesc(
				'Read diagrams already rendered by the original TikZJax plugin instead of recompiling them. ' +
					'Its records are only read, never deleted, so the original keeps working if you still use it.',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.importLegacyCache).onChange(async (value) => {
					this.plugin.settings.importLegacyCache = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Engine').setHeading();

		const inventory = this.plugin.engineInventory;
		const engineInfo = new Setting(containerEl).setName('Bundled TeX engine');
		if (inventory) {
			const packages = Object.entries(inventory.packages)
				.map(([name, version]) => `${name} ${version}`)
				.join(', ');
			engineInfo.setDesc(
				`${inventory.engine} · ${inventory.files.length} TeX files · ` +
					`expl3 ${inventory.capabilities.expl3 ? 'available' : 'unavailable'}` +
					(packages ? ` · ${packages}` : ''),
			);
		} else {
			engineInfo.setDesc('Not started yet — it boots with the first diagram.');
		}
	}
}
