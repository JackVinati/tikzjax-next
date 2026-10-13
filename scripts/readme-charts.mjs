/**
 * Draws the README's charts as static SVG files in docs/images.
 *
 *   node scripts/readme-charts.mjs [out-dir]           out-dir defaults to docs/images
 *   node scripts/readme-charts.mjs [out-dir] --table   also prints the README's table of all 26 diagrams
 *
 * Deterministic: every number is written out below with where it comes from, and nothing depends on
 * the time, the machine or a random seed. Run it twice and the files are identical. No dependencies,
 * no network, and no scripts, fonts or other external resources inside the SVGs.
 *
 * Each chart is a card with its own background, so it reads on a light page and on a dark one, and it
 * switches to a dark card when the page or the system prefers dark. The canvas is 640 wide, no text is
 * smaller than 16 px, and labels and values are 18 px, because the README is also read in Obsidian's
 * plugin browser on a phone, where the chart is shown at a little over half size. At most 8 rows of
 * bars per chart.
 *
 * File names carry the version. The community plugin site shows an old copy of the README text for a
 * while but loads the images live, so a chart must never change its numbers under an old name: new
 * numbers get a new file, and old files stay.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGS = process.argv.slice(2);
const OUT = resolve(
	ARGS.find((a) => !a.startsWith('--')) ??
		join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images'),
);

// ---------------------------------------------------------------------------------------------
// Data. The only place the charts' numbers live.
// ---------------------------------------------------------------------------------------------

// IPHONE-FIGURES: nothing has been measured on an iPhone or iPad yet, so each `iphone` entry below is
// null. To fill one in, read the figures off the diagnostics view on the device (engine start, memory
// reset, TeX, DVI to SVG for each diagram), on 0.1.5 and on 0.2.0, best of several runs, and give the
// device, its iOS version and the Obsidian version as `platform`. Then run this script. For each
// entry that is filled in it draws a phone chart (`tex-time-iphone-0.2.0.svg`,
// `engine-iphone-0.2.0.svg`), and the desktop charts stop saying that nothing was measured on a
// phone. The README's IPHONE-FIGURES comments say where the phone charts and the sentence that
// names the device go.

const DATA = {
	texTime: {
		// TeX time per test diagram in ms, the minimum of 5 runs: 0.1.5 as released against 0.2.0,
		// both engines in one Node 22.19 process on a Windows desktop, interleaved diagram by
		// diagram. Run 1 of the two runs in internal/DECISIONS.md D18. All 26 diagrams that 0.1.5
		// has; the SVG of every one is the same as 0.1.5's (mathfrak and mathscr give no SVG on
		// either version). The fourth column is the benchmark's own change, worked out from the
		// unrounded times, so it is copied rather than recomputed from the ms; `unrounded` says so
		// on the chart.
		desktop: {
			platform: 'Windows desktop, Node 22.19 (V8)',
			runs: 5,
			unrounded: true,
			rows: [
				['feynhand', 768, 399, -48],
				['circuitikz', 652, 349, -46],
				['pgfplots-axis', 622, 335, -46],
				['pgfplots-fillbetween', 613, 332, -46],
				['forest', 566, 312, -45],
				['siunitx', 251, 143, -43],
				['tikz-cd', 208, 118, -44],
				['chemfig', 128, 71, -45],
				['mathtools', 89, 53, -40],
				['arrows-meta', 81, 46, -43],
				['patterns', 79, 47, -41],
				['ts1-currency', 48, 30, -39],
				['ts1-symbols', 44, 26, -41],
				['dieresis', 43, 24, -43],
				['ts1-small-caps', 42, 25, -39],
				['shading', 41, 24, -41],
				['xparse', 38, 23, -38],
				['l-stroke', 37, 22, -40],
				['rule-frac', 36, 22, -39],
				['mathfrak', 35, 21, -40],
				['mathscr', 35, 21, -39],
				['expl3', 34, 21, -38],
				['basic', 33, 20, -41],
				['white-fill', 32, 19, -40],
				['omega-otimes', 30, 19, -38],
				['broken', 26, 16, -37],
			],
			// The benchmark's sum over the 26, and its change.
			total: [4612, 2539, -45],
		},
		// Later: { platform: '<device>, iOS <x>, Obsidian <y>', runs: <n>, rows: [[name, ms015, ms020], ...],
		// total: [sum015, sum020] or null }. Changes are then worked out from the ms given.
		iphone: null,
	},

	engine: {
		// Medians of 7 fresh processes, each running the shipped worker through five compiles
		// (basic, pgfplots-axis, basic, tikz-cd, basic), on the same desktop in Node 22.19. Set 1 of
		// the two sets in internal/DECISIONS.md D18, rounded to whole ms and MiB.
		desktop: {
			platform: 'Windows desktop, Node 22.19 (V8)',
			method: 'Medians of 7 fresh processes',
			rows: [
				// Worker evaluated until it reports ready: median 528.4 ms on 0.1.5 (529.5 in set 2),
				// 161.3 ms on 0.2.0 (161.4). CHANGELOG.md rounds 0.1.5's to 529.
				['Engine start', 'ms', 528, 161],
				// The worker's own durationMs for the third compile, `basic`, a small diagram, once the
				// engine is running: reset, TeX and DVI to SVG (4 + 22 + 1 ms on 0.2.0). It leaves out the
				// queue and the plugin's SVG pipeline. 61 and 63 ms on 0.1.5, 27 and 27 ms on 0.2.0.
				['A small diagram, compiled in the running engine worker', 'ms', 61, 27],
				// ArrayBuffers once the engine has started, after a garbage collection.
				['Memory buffers held once started', 'MiB', 157.5, 23.5],
				// The test process's peak resident memory over the five compiles: 702.6 and 167.5 MiB,
				// including the 57 MiB Node holds before the worker is evaluated.
				['Peak memory of the whole test process, five compiles', 'MiB', 703, 168],
			],
		},
		// Later: { platform: '...', method: '...', rows: [[label, 'ms', v015, v020], ...] } from the
		// diagnostics view. It shows no memory, so a phone chart carries the time rows only.
		iphone: null,
	},

	// The plan, from the wiki's Roadmap page. No dates. `done`, `now` or `next`.
	plan: [
		['0.1.0 to 0.1.5', 'Six releases, 1 September to 13 October 2026', 'released', 'done'],
		['0.2.0', 'Faster engine', 'this release', 'now'],
		['0.2.x', 'Skip the preamble; a second engine on desktop', 'ideas, prototype first', 'next'],
		['0.3.0', 'TeX Live 2026: newer packages, smaller main.js', 'planned', 'next'],
		['Then', 'Features, one at a time', 'chosen by votes in Discussions', 'next'],
	],
};

// The diagrams the TeX chart shows: the packages people load most, slowest first, and one small
// diagram from the low end of the range. The README's table has all 26.
const TEX_CHART_ROWS = [
	'feynhand',
	'circuitikz',
	'pgfplots-axis',
	'forest',
	'siunitx',
	'tikz-cd',
	'chemfig',
	'xparse',
];

// What a test diagram is called on the chart, where its file name would say less.
const LABEL = { feynhand: 'tikz-feynhand' };

// What the README's table says next to a test diagram's name.
const NOTE = { broken: 'an error on purpose' };

// ---------------------------------------------------------------------------------------------
// Drawing helpers.
// ---------------------------------------------------------------------------------------------

const W = 640;
const PAD = 24;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';

// Type sizes. Nothing below 16.
const S = { title: 22, sub: 17, label: 18, value: 18, legend: 17, source: 18 };
// From a bar's vertical centre to the baseline of 18 px digits beside it.
const MID = 6.5;
const MIN_SIZE = 16;

// Colours: light values first, dark values in the media query. Text keeps at least 4.5:1 and the
// bars and lines at least 3:1 against their card in both. The two bar colours stay at least 15 apart
// in OKLab (x100) for normal vision and for each colour-vision deficiency, in both themes. 0.1.5 is
// grey on purpose: it is the reference, and 0.2.0 is the bar to look at.
const STYLE = `
	.card { fill: #f6f8fa; stroke: #d1d9e0; }
	text { font-family: ${FONT}; }
	.t1 { fill: #1f2328; }
	.t2 { fill: #59636e; }
	.num { font-variant-numeric: tabular-nums; }
	.rule { stroke: #d1d9e0; stroke-width: 1; }
	.base { stroke: #808893; stroke-width: 1; }
	.link { stroke: #808893; stroke-width: 2; fill: none; }
	.open { stroke: #808893; stroke-width: 2; stroke-dasharray: 4 4; fill: none; }
	.old { fill: #656d76; }
	.new { fill: #2a78d6; }
	.dot { fill: #2a78d6; stroke: #f6f8fa; stroke-width: 2; }
	.ring { fill: none; stroke: #2a78d6; stroke-width: 2; }
	.todo { fill: #f6f8fa; stroke: #656d76; stroke-width: 2; }
	@media (prefers-color-scheme: dark) {
		.card { fill: #161b22; stroke: #3d444d; }
		.t1 { fill: #f0f6fc; }
		.t2 { fill: #9198a1; }
		.rule { stroke: #3d444d; }
		.base { stroke: #626c78; }
		.link { stroke: #626c78; }
		.open { stroke: #626c78; }
		.old { fill: #6e7681; }
		.new { fill: #3987e5; }
		.dot { fill: #3987e5; stroke: #161b22; }
		.ring { stroke: #3987e5; }
		.todo { fill: #161b22; stroke: #6e7681; }
	}
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => n.toLocaleString('en-US');
const signed = (n) => (n < 0 ? `−${Math.abs(n)}` : n > 0 ? `+${n}` : '0');
const change = (before, after) => Math.round((after / before - 1) * 100);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

// A deliberately generous estimate of a string's width in the system sans, so that nothing is
// placed tight against anything else whichever font the viewer's system picks.
function textWidth(str, size, weight = 400) {
	let em = 0;
	for (const ch of str) {
		if (/[0-9]/.test(ch)) em += 0.58;
		else if (/[iljtfr.,:;'!|]/.test(ch)) em += 0.31;
		else if (/[mw]/.test(ch)) em += 0.86;
		else if (/[a-z]/.test(ch)) em += 0.56;
		else if (/[MW]/.test(ch)) em += 0.88;
		else if (/[I]/.test(ch)) em += 0.32;
		else if (/[A-Z]/.test(ch)) em += 0.68;
		else if (ch === ' ') em += 0.28;
		else if (ch === '-' || ch === '(' || ch === ')') em += 0.36;
		else if (ch === '%') em += 0.86;
		else if (ch === '→') em += 0.9;
		else em += 0.62;
	}
	return em * size * (weight >= 600 ? 1.06 : 1);
}

function text(x, y, str, { cls = 't1', size = S.label, weight = 400, anchor = 'start', num = false } = {}) {
	if (size < MIN_SIZE) throw new Error(`text under ${MIN_SIZE} px: "${str}"`);
	const classes = num ? `${cls} num` : cls;
	const w = weight === 400 ? '' : ` font-weight="${weight}"`;
	const a = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
	return `<text x="${r1(x)}" y="${r1(y)}" class="${classes}" font-size="${size}"${w}${a}>${esc(str)}</text>`;
}

// Fails the build when a string would run past `right` (by default the card's inner edge).
function fits(x, str, size, weight = 400, right = W - PAD) {
	if (x + textWidth(str, size, weight) > right + 0.5) throw new Error(`does not fit: "${str}"`);
}

// A horizontal bar growing right from x: square at the baseline, rounded at the data end.
function hbar(x, y, len, h, cls, radius = 3) {
	if (len <= 0) return '';
	const r = Math.min(radius, h / 2, len);
	const x2 = x + len;
	return (
		`<path class="${cls}" d="M${r1(x)} ${r1(y)}H${r1(x2 - r)}` +
		`A${r} ${r} 0 0 1 ${r1(x2)} ${r1(y + r)}V${r1(y + h - r)}` +
		`A${r} ${r} 0 0 1 ${r1(x2 - r)} ${r1(y + h)}H${r1(x)}Z"/>`
	);
}

const rect = (x, y, w, h, cls, rx = 0) =>
	`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${rx}" class="${cls}"/>`;
const line = (x1, y1, x2, y2, cls) =>
	`<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="${cls}"/>`;

function legend(x, y, items) {
	let out = '';
	for (const [cls, label] of items) {
		out += rect(x, y - 13, 16, 14, cls, 2) + text(x + 22, y, label, { cls: 't2', size: S.legend });
		x += 22 + textWidth(label, S.legend) + 24;
	}
	if (x - 24 > W - PAD) throw new Error('legend does not fit');
	return out;
}

function header(title, subtitle) {
	fits(PAD, title, S.title, 600);
	fits(PAD, subtitle, S.sub);
	return (
		text(PAD, 42, title, { size: S.title, weight: 600 }) +
		text(PAD, 70, subtitle, { cls: 't2', size: S.sub })
	);
}

// The source note at the foot of a chart: sentences, filled into as few lines as fit. Returns the
// markup and the y of the last line.
function source(y, sentences) {
	const lines = [];
	for (const s of sentences) {
		const last = lines.length ? `${lines[lines.length - 1]} ${s}` : s;
		if (lines.length && textWidth(last, S.source) <= W - 2 * PAD) lines[lines.length - 1] = last;
		else lines.push(s);
	}
	let out = '';
	lines.forEach((l, i) => {
		fits(PAD, l, S.source);
		out += text(PAD, y + i * 26, l, { cls: 't2', size: S.source });
	});
	return { markup: out, last: y + (lines.length - 1) * 26 };
}

function doc(name, height, title, desc, body) {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="title desc">\n` +
		`<title id="title">${esc(title)}</title>\n` +
		`<desc id="desc">${esc(desc)}</desc>\n` +
		`<style>${STYLE}</style>\n` +
		`<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="10" class="card"/>\n` +
		body.replace(/></g, '>\n<') +
		`\n</svg>\n`;
	for (const ch of svg) {
		if (ch.codePointAt(0) > 0xffff) throw new Error(`${name}: unexpected character ${ch}`);
	}
	writeFileSync(join(OUT, name), svg);
	return name;
}

const LEGEND = [
	['old', '0.1.5'],
	['new', '0.2.0'],
];

const fileName = (chart, platform) =>
	platform === 'desktop' ? `${chart}-0.2.0.svg` : `${chart}-${platform}-0.2.0.svg`;

// The desktop charts say that nothing was measured on a phone for as long as that is true.
const phoneNote = (block) => (block.iphone ? [] : ['Not measured on a phone yet.']);

// One sentence on how the 0.2.0 bars compare with the 0.1.5 bars, worked out from what is drawn.
function compare(pairs) {
	const shorter = pairs.filter(([before, after]) => after < before).length;
	const pct = pairs.map(([before, after]) => Math.round((after / before) * 100));
	if (shorter === pairs.length) {
		const lo = Math.min(...pct);
		const hi = Math.max(...pct);
		return `Every blue bar is shorter than the grey bar above it, ${lo === hi ? `${lo} percent` : `between ${lo} and ${hi} percent`} of its length.`;
	}
	if (shorter === 0) return 'No blue bar is shorter than the grey bar above it.';
	return `${shorter} of the ${pairs.length} blue bars are shorter than the grey bar above them.`;
}

// ---------------------------------------------------------------------------------------------
// 1. TeX time per diagram, 0.1.5 and 0.2.0, with the total over all of them.
// ---------------------------------------------------------------------------------------------

function texTime(platform) {
	const d = DATA.texTime[platform];
	const all = d.rows.map(([name, before, after, pct]) => [
		name,
		before,
		after,
		pct ?? change(before, after),
	]);
	const byName = new Map(all.map((r) => [r[0], r]));
	const rows = TEX_CHART_ROWS.map((n) => byName.get(n)).filter(Boolean);
	if (rows.length === 0) throw new Error(`texTime ${platform}: none of TEX_CHART_ROWS in the data`);
	if (rows.length > 8) throw new Error('texTime: more than 8 rows');
	const label = (name) => LABEL[name] ?? name;

	const labelW = Math.max(...rows.map((r) => textWidth(label(r[0]), S.label)));
	const labelRight = PAD + labelW;
	const x0 = labelRight + 14;
	const colPct = W - PAD;
	const pctW = Math.max(...rows.map((r) => textWidth(`${signed(r[3])}%`, S.value)));
	const valW = Math.max(
		...rows.flatMap((r) => [textWidth(`${r[1]}`, S.value), textWidth(`${r[2]}`, S.value, 600)]),
	);
	const x1 = colPct - pctW - 22 - valW - 8;
	const scale = (x1 - x0) / Math.max(...rows.flatMap((r) => [r[1], r[2]]));

	const top = 122;
	const pitch = 48;
	const barH = 15;
	const shown =
		rows.length === all.length
			? `${all.length} test diagrams`
			: `${rows.length} of the ${all.length} test diagrams`;
	const runs = d.runs ? `, best of ${d.runs} runs` : '';
	let body = header(`TeX time, ${shown}`, `Milliseconds${runs}. Shorter is better.`);
	body += legend(PAD, 104, LEGEND);
	const bottom = top + rows.length * pitch;
	body += line(x0, top, x0, bottom - 6, 'base');

	rows.forEach(([name, before, after, pct], i) => {
		const y = top + i * pitch;
		body += text(labelRight, y + 4 + barH + 1.5 + MID, label(name), { anchor: 'end' });
		const a = before * scale;
		const b = after * scale;
		body += hbar(x0, y + 4, a, barH, 'old');
		body += hbar(x0, y + 4 + barH + 3, b, barH, 'new');
		body += text(x0 + a + 7, y + 4 + barH / 2 + MID, `${before}`, { cls: 't2', num: true });
		body += text(x0 + b + 7, y + 4 + barH + 3 + barH / 2 + MID, `${after}`, { weight: 600, num: true });
		fits(x0 + Math.max(a, b) + 7, `${Math.max(before, after)}`, S.value, 600, colPct - pctW - 12);
		body += text(colPct, y + 4 + barH + 1.5 + MID, `${signed(pct)}%`, {
			cls: 't2',
			anchor: 'end',
			num: true,
		});
	});

	let yNext = bottom + 34;
	let sumSentence = '';
	if (d.total) {
		const [sumBefore, sumAfter, given] = d.total;
		const sumPct = given ?? change(sumBefore, sumAfter);
		body += line(PAD, bottom + 4, W - PAD, bottom + 4, 'rule');
		const sumText = `All ${all.length} test diagrams: ${fmt(sumBefore)} ms → ${fmt(sumAfter)} ms`;
		fits(PAD, sumText, S.value, 600, colPct - pctW - 12);
		body += text(PAD, yNext, sumText, { weight: 600, num: true });
		body += text(colPct, yNext, `${signed(sumPct)}%`, { weight: 600, anchor: 'end', num: true });
		yNext += 36;
		const pcts = all.map((r) => r[3]);
		const lo = Math.min(...pcts);
		const hi = Math.max(...pcts);
		sumSentence =
			hi < 0
				? ` Over all ${all.length} diagrams the time falls by ${-sumPct} percent (${-hi} to ${-lo} percent per diagram).`
				: ` Over all ${all.length} diagrams the time changes by ${signed(sumPct)} percent (${signed(lo)} to ${signed(hi)} percent per diagram).`;
	} else {
		yNext = bottom + 16;
	}
	const notes = [`${d.platform}.`];
	if (d.unrounded) notes.push('Changes from unrounded times.');
	if (platform === 'desktop') notes.push(...phoneNote(DATA.texTime));
	const src = source(yNext, notes);
	body += src.markup;
	const height = src.last + 22;

	const slowestFirst = rows.every((r, i) => i === 0 || rows[i - 1][1] >= r[1]);
	return doc(
		fileName('tex-time', platform),
		height,
		`TeX time per diagram, 0.1.5 and 0.2.0, ${d.platform}`,
		`Paired horizontal bars for ${shown}${slowestFirst ? ', slowest first' : ''}: a grey bar for 0.1.5 and a ` +
			`blue bar for 0.2.0, each labelled in milliseconds. ${compare(rows.map((r) => [r[1], r[2]]))}${sumSentence}`,
		body,
	);
}

// ---------------------------------------------------------------------------------------------
// 2. Engine start, a small diagram, and memory. Each pair on its own scale.
// ---------------------------------------------------------------------------------------------

function engine(platform) {
	const d = DATA.engine[platform];
	const rows = d.rows.map(([label, unit, before, after]) => [
		label,
		`${before} ${unit}`,
		`${after} ${unit}`,
		change(before, after),
		before,
		after,
		unit,
	]);
	if (rows.length === 0) throw new Error(`engine ${platform}: no rows`);
	if (rows.length * 2 > 8) throw new Error('engine: more than 8 bars');
	const memory = rows.some((r) => r[6] === 'MiB');
	const title = memory ? 'Engine start and memory' : 'Engine start and compile time';

	const colPct = W - PAD;
	const pctW = Math.max(...rows.map((r) => textWidth(`${signed(r[3])}%`, S.value)));
	const valW = Math.max(...rows.flatMap((r) => [textWidth(r[1], S.value), textWidth(r[2], S.value, 600)]));
	const x0 = PAD;
	const x1 = colPct - pctW - 22 - valW - 8;

	const top = 124;
	const pitch = 82;
	const barH = 15;
	let body = header(title, 'Each pair drawn to its own scale. Shorter is better.');
	body += legend(PAD, 104, LEGEND);

	rows.forEach(([label, vBefore, vAfter, pct, before, after], i) => {
		const y = top + i * pitch;
		fits(PAD, label, S.label, 600, colPct - pctW - 12);
		body += text(PAD, y + 17, label, { weight: 600 });
		const scale = (x1 - x0) / Math.max(before, after);
		const yA = y + 28;
		const yB = yA + barH + 3;
		body += hbar(x0, yA, before * scale, barH, 'old');
		body += hbar(x0, yB, after * scale, barH, 'new');
		body += text(x0 + before * scale + 7, yA + barH / 2 + MID, vBefore, { cls: 't2', num: true });
		body += text(x0 + after * scale + 7, yB + barH / 2 + MID, vAfter, { weight: 600, num: true });
		body += text(colPct, yB - 1.5 + MID, `${signed(pct)}%`, { cls: 't2', anchor: 'end', num: true });
	});

	const bottom = top + rows.length * pitch;
	const notes = [`${d.platform}.`];
	if (d.method) notes.push(`${d.method}.`);
	if (platform === 'desktop') notes.push(...phoneNote(DATA.engine));
	const src = source(bottom + 18, notes);
	body += src.markup;
	const height = src.last + 22;

	return doc(
		fileName('engine', platform),
		height,
		`${title}, 0.1.5 and 0.2.0, ${d.platform}`,
		`${WORDS[rows.length] ?? rows.length} pairs of horizontal bars, a grey bar for 0.1.5 and a blue bar for ` +
			`0.2.0, each pair on its own scale: ` +
			rows.map((r) => `${lowerFirst(r[0])}, ${r[1]} and ${r[2]}`).join('; ') +
			`. ${compare(rows.map((r) => [r[4], r[5]]))}`,
		body,
	);
}

// ---------------------------------------------------------------------------------------------
// 3. Releases so far and the plan, top to bottom.
// ---------------------------------------------------------------------------------------------

function plan() {
	const rows = DATA.plan;
	const top = 104;
	const pitch = 62;
	const cx = PAD + 9;
	const verW = Math.max(...rows.map((r) => textWidth(r[0], S.label, 600)));
	const xText = PAD + 32;
	const xWhat = xText + verW + 14;
	let body = header('Releases and what comes next', 'No dates: each one comes out when it is done.');

	rows.forEach(([version, what, state, kind], i) => {
		const y = top + i * pitch;
		const cy = y + 12;
		if (i < rows.length - 1) {
			const next = rows[i + 1][3];
			body += line(cx, cy + 11, cx, cy + pitch - 11, next === 'next' ? 'open' : 'link');
		}
		if (kind === 'now') body += `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="10" class="ring"/>`;
		body += `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${kind === 'now' ? 6 : 7}" class="${kind === 'next' ? 'todo' : 'dot'}"/>`;
		fits(xWhat, what, S.label);
		fits(xWhat, state, S.label);
		body += text(xText, y + 18.5, version, { weight: 600 });
		body += text(xWhat, y + 18.5, what);
		body += text(xWhat, y + 43, state, { cls: 't2' });
	});

	const filled = rows.filter((r) => r[3] !== 'next').length;
	const height = top + rows.length * pitch - 4;
	return doc(
		'roadmap-0.2.0.svg',
		height,
		'Releases and what comes next',
		`A vertical line of ${WORDS[rows.length]?.toLowerCase() ?? rows.length} steps. ` +
			rows.map(([v, w, s]) => `${v}: ${w} (${s})`).join('; ') +
			`. The first ${WORDS[filled]?.toLowerCase() ?? filled} are filled in, the rest are open circles joined by a dashed line.`,
		body,
	);
}

// ---------------------------------------------------------------------------------------------
// The README's folded table of all 26 diagrams, printed so it never has to be typed by hand.
// ---------------------------------------------------------------------------------------------

function table() {
	const d = DATA.texTime.desktop;
	const rows = d.rows
		.map(([n, a, b, p]) => {
			const note = NOTE[n] ? ` (${NOTE[n]})` : '';
			const pct = p ?? change(a, b);
			return `<tr><td><code>${n}</code>${note}</td><td align="right">${a}</td><td align="right">${b}</td><td align="right">${signed(pct)}%</td></tr>`;
		})
		.join('\n');
	const [a, b, p] = d.total;
	return (
		'<table>\n<thead><tr><th>Test diagram</th><th>0.1.5 (ms)</th><th>0.2.0 (ms)</th><th>Change</th></tr></thead>\n<tbody>\n' +
		rows +
		`\n<tr><td>All ${d.rows.length}</td><td align="right">${fmt(a)}</td><td align="right">${fmt(b)}</td><td align="right">${signed(p ?? change(a, b))}%</td></tr>\n` +
		'</tbody>\n</table>\n'
	);
}

mkdirSync(OUT, { recursive: true });
const written = [];
for (const platform of ['desktop', 'iphone']) {
	if (DATA.texTime[platform]) written.push(texTime(platform));
	if (DATA.engine[platform]) written.push(engine(platform));
}
written.push(plan());
console.log(`wrote ${written.join(', ')}`);
if (ARGS.includes('--table')) process.stdout.write(table());
