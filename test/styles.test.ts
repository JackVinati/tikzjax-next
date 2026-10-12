import { describe, expect, it } from 'vitest';
import { readText } from './support/read-text';

const baseCss = readText('src/styles/base.css');

/**
 * The colour modes live entirely in base.css: every mode mounts the same stored template, whose
 * ink is `currentColor` and whose paper is a `.tz-paper-*` class (svg/colors.ts). So a mode is only
 * as right as the two tokens its class sets. A mode class that leaves `--tikz-ink` at the theme's
 * text colour draws theme ink where it promised black — and under `invert`'s filter in a dark
 * theme, that light ink is inverted into dark ink on a dark background.
 *
 * Read as text rather than through a CSS engine: happy-dom does not resolve custom properties
 * through a cascade, and what has to hold here is a property of the rules as written.
 */

/**
 * The declarations of the top-level rule whose selector list includes `selector`. Rules nested in
 * an at-rule are skipped: `@media print` deliberately overrides these tokens, and it is not what a
 * diagram in a note is drawn with.
 */
function declarationsOf(selector: string): Map<string, string> {
	const css = baseCss.replace(/\/\*[\s\S]*?\*\//g, '');
	const found = new Map<string, string>();
	let depth = 0;
	let start = 0;
	let prelude = '';
	for (let i = 0; i < css.length; i++) {
		const ch = css.charAt(i);
		if (ch === '{') {
			if (depth === 0) prelude = css.slice(start, i).trim();
			depth++;
			start = i + 1;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				const selectors = prelude.split(',').map((s) => s.trim());
				if (!prelude.startsWith('@') && selectors.includes(selector)) {
					for (const declaration of css.slice(start, i).split(';')) {
						const colon = declaration.indexOf(':');
						if (colon < 0) continue;
						found.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
					}
				}
			}
			start = i + 1;
		}
	}
	return found;
}

describe('colour modes in base.css', () => {
	it('adapt follows the theme', () => {
		const adapt = declarationsOf('.tikzjax-figure');
		expect(adapt.get('--tikz-ink')).toBe('var(--text-normal)');
		expect(adapt.get('--tikz-paper')).toBe('var(--background-primary)');
	});

	for (const mode of ['preserve', 'paper', 'invert']) {
		it(`${mode} draws TeX's own black on white`, () => {
			const rule = declarationsOf(`.tikzjax-figure.is-${mode}`);
			expect(rule.get('--tikz-ink'), `--tikz-ink for is-${mode}`).toBe('#000');
			expect(rule.get('--tikz-paper'), `--tikz-paper for is-${mode}`).toBe('#fff');
		});
	}

	it('draws the zoom view, which mounts the same artifact outside any figure, as adapt', () => {
		// Without these a paper-class shape inherits the ink of the group around it, so a white
		// label plate turns into a block of ink over its own label.
		const surface = declarationsOf('.tikzjax-zoom-surface');
		expect(surface.get('--tikz-ink')).toBe('var(--text-normal)');
		expect(surface.get('--tikz-paper')).toBe('var(--background-primary)');
		expect(surface.get('color')).toBe('var(--tikz-ink)');
		expect(declarationsOf('.tikzjax-zoom-surface svg').get('fill')).toBe('currentColor');
		expect(declarationsOf('.tikzjax-zoom-surface svg .tz-paper-fill').get('fill')).toBe(
			'var(--tikz-paper)',
		);
		expect(declarationsOf('.tikzjax-zoom-surface svg .tz-paper-stroke').get('stroke')).toBe(
			'var(--tikz-paper)',
		);
	});

	it('inverts only in a dark theme, over that black on white', () => {
		const filter = declarationsOf('.theme-dark .tikzjax-figure.is-invert svg').get('filter');
		expect(filter).toBe('invert(1) hue-rotate(180deg)');
	});
});
