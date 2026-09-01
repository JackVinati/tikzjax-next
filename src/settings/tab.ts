import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type TikzjaxNextPlugin from '../main';
import { STRINGS } from '../ui/strings';

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
				'Skip SVG optimisation, the ink-bounds measurement and the pre-flight check. ' +
					'Faster, slightly rougher framing. Fast and full renders are cached separately, ' +
					'so switching back costs nothing.',
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
				b
					.setButtonText('Clear')
					.setDestructive()
					.onClick(async () => {
						await this.plugin.cache?.clear();
						new Notice(STRINGS.cacheCleared);
						this.update();
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
