import { describe, expect, it } from 'vitest';
import type { CompileTimings } from '../src/types';
import {
	diagnosticsText,
	engineLife,
	timingSteps,
	type DiagnosticsSnapshot,
	type RenderRecord,
} from '../src/ui/report';

/*
 * The diagnostics view's Copy button puts this text on the clipboard so that it can be pasted into
 * a bug report, which anyone can read. It says everything about the device, the plugin and where
 * each diagram's time went, and nothing about what the diagrams or the notes are.
 */

const SECRET_SOURCE = '\\node {Quarterly figures for Acme};';
const SECRET_PATH = 'Private/Clients/Acme preamble.tex';

const record = (over: Partial<RenderRecord>): RenderRecord => ({
	key: '0123456789abcdef0123456789abcdef',
	sourcePreview: SECRET_SOURCE,
	state: 'ok',
	at: 10_000,
	...over,
});

function snapshot(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
	return {
		about: {
			plugin: '0.2.1',
			obsidian: '1.7.2',
			platform: 'phone',
			os: 'iOS',
			webView: { decompressionStream: false, fromBase64: false, cores: 6, memoryGiB: null },
			engineId: '5e861510239768c57ca2965eb2329bd2bafc1370df4821cd8d3b7088ce60efde',
			outputRevision: '5e861510239768c57ca2965eb2329bd2bafc1370df4821cd8d3b7088ce60efde',
		},
		engine: {
			starts: 3,
			lives: [
				{ startMs: 230, boot: null, snapshots: null, stop: 'idle' },
				{ startMs: 214, boot: null, snapshots: null, stop: 'background' },
				{
					startMs: 221,
					boot: {
						decodeMs: 21,
						inflateMs: 114,
						compileMs: 3,
						totalMs: 138,
						nativeInflate: false,
						nativeBase64: false,
					},
					snapshots: null,
					stop: null,
				},
			],
			lastStop: 'background',
			poolSize: 1,
		},
		memory: { entries: 4, bytes: 2 * 1048576 },
		stored: { entries: 40, bytes: 3 * 1048576 },
		queueDepth: 1,
		records: [
			record({ key: 'aaaaaaaa11111111', state: 'cached', tier: 'l2', at: 1_000 }),
			record({
				key: 'bbbbbbbb22222222',
				state: 'error',
				reason: 'tex-error',
				message: `Preamble file not found: ${SECRET_PATH}`,
				log: [`! Undefined control sequence.`, `l.3 ${SECRET_SOURCE}`, `(${SECRET_PATH})`],
				at: 4_000,
			}),
			record({
				key: 'cccccccc33333333',
				durationMs: 80,
				timings: {
					waitedMs: 0,
					queueMs: 3,
					startMs: 221,
					resetMs: 5,
					texMs: 63,
					svgMs: 9,
					passes: 1,
					postMs: 7,
					mountMs: 31,
					totalMs: 339,
				},
				at: 9_000,
			}),
		],
		now: 10_000,
		...over,
	};
}

describe('the text the diagnostics view copies', () => {
	const text = diagnosticsText(snapshot());

	it('says which plugin, which Obsidian, which device, what its WebView has, and which engine', () => {
		expect(text).toContain('Plugin: 0.2.1');
		expect(text).toContain('Obsidian: 1.7.2');
		expect(text).toContain('Platform: phone, iOS');
		expect(text).toContain(
			'WebView: DecompressionStream no, Uint8Array.fromBase64 no, 6 cores, deviceMemory unknown',
		);
		expect(text).toContain('Engine: 5e861510239768c57ca2965eb2329bd2bafc1370df4821cd8d3b7088ce60efde');
		expect(text).toContain(
			'Output revision: 5e861510239768c57ca2965eb2329bd2bafc1370df4821cd8d3b7088ce60efde',
		);
	});

	it('says how often the engine started, how long each start took, and why it stopped', () => {
		expect(text).toContain('The engine started 3 times this session.');
		expect(text).toContain('  1. started in 230 ms, stopped after it had nothing to do');
		expect(text).toContain('  2. started in 214 ms, stopped when the app went to the background');
		expect(text).toContain(
			'  3. started in 221 ms (in the worker 138 ms: decode 21 ms, inflate 114 ms, compile 3 ms; ' +
				'native gzip no, native base64 no), running',
		);
		expect(text).toContain('Last stopped: stopped when the app went to the background.');
		expect(text).toContain('One engine compiles at a time.');
	});

	it('numbers the starts it still lists from the first of them, when older ones were dropped', () => {
		const later = diagnosticsText(
			snapshot({
				engine: {
					starts: 25,
					lives: [{ startMs: null, boot: null, snapshots: null, stop: 'error' }],
					lastStop: 'error',
					poolSize: 2,
				},
			}),
		);
		expect(later).toContain('  25. never finished starting, stopped by an error');
		expect(later).toContain('Up to 2 engines compile at once.');
	});

	it('lists every recent render, newest first, with each step of its time', () => {
		const renders = text.slice(text.indexOf('Recent renders'));
		const lines = renders.split('\n').slice(1, 4);
		expect(lines).toEqual([
			'#3 cccccccc, 1 s ago: ok · waited 0 ms · queue 3 ms · engine start 221 ms · memory reset 5 ms · ' +
				'TeX 63 ms · DVI to SVG 9 ms · SVG pipeline 7 ms · drawing 31 ms · seen to drawn 339 ms',
			'#2 bbbbbbbb, 6 s ago: error (tex-error)',
			'#1 aaaaaaaa, 9 s ago: cached from l2',
		]);
	});

	it('says of a render whether it resumed from a saved preamble, or saved its own and in how long', () => {
		const steps = (timings: Partial<CompileTimings>) =>
			timingSteps({ queueMs: 1, postMs: 2, texMs: 9, passes: 1, ...timings });
		expect(steps({ resumed: true })).toEqual([
			'queue 1 ms',
			'TeX 9 ms',
			'resumed from a saved preamble',
			'SVG pipeline 2 ms',
		]);
		expect(steps({ saveMs: 4 })).toContain('preamble saved in 4 ms');
		expect(steps({ saveFailed: true })).toContain('saving the preamble failed');
		expect(steps({})).not.toContain('resumed from a saved preamble');
	});

	it('says what each engine holds of saved preambles, and how many of its saves failed', () => {
		const held = diagnosticsText(
			snapshot({
				engine: {
					starts: 1,
					lives: [
						{
							startMs: 50,
							boot: null,
							snapshots: { runs: 3, bytes: 9.5 * 1048576, failures: 0 },
							stop: null,
						},
					],
					lastStop: null,
					poolSize: 1,
				},
			}),
		);
		expect(held).toContain('  1. started in 50 ms; 3 saved preambles, 9.5 MB, running');
		expect(
			engineLife({
				startMs: 50,
				boot: null,
				snapshots: { runs: 1, bytes: 0, failures: 2 },
				stop: 'idle',
			}),
		).toBe(
			'started in 50 ms; 1 saved preamble, 0.0 MB, 2 saves failed, stopped after it had nothing to do',
		);
	});

	it('has the cache and the queue in it', () => {
		expect(text).toContain('In memory: 4 diagrams, 2.0 MB');
		expect(text).toContain('On disk: 40 diagrams, 3.0 MB');
		expect(text).toContain('Queue depth: 1');
		expect(diagnosticsText(snapshot({ stored: null }))).toContain('On disk: unavailable');
	});

	it('never has a diagram source, an error message, a transcript or a path in it', () => {
		expect(text).not.toContain('Acme');
		expect(text).not.toContain('Quarterly');
		expect(text).not.toContain('Private/');
		expect(text).not.toContain('Undefined control sequence');
		expect(text).not.toContain('\\node');
		// A render is told apart by its first eight characters of cache key, and no more of it.
		expect(text).not.toContain('cccccccc3');
	});
});
