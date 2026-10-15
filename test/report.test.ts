import { describe, expect, it } from 'vitest';
import type { JitProbe, JitState } from '../engine-src/protocol';
import type { EngineStop } from '../src/engine/worker-host';
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
			built: '0.2.1',
			obsidian: '1.7.2',
			platform: 'phone',
			os: 'iOS',
			webView: {
				webAssembly: true,
				decompressionStream: false,
				fromBase64: false,
				cores: 6,
				memoryGiB: null,
			},
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
		expect(text).toContain('Plugin: 0.2.1, main.js 0.2.1\n');
		expect(text).toContain('Obsidian: 1.7.2');
		expect(text).toContain('Platform: phone, iOS');
		expect(text).toContain(
			'WebView: WebAssembly yes, DecompressionStream no, Uint8Array.fromBase64 no, 6 cores, deviceMemory unknown',
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
		expect(steps({ saveMs: 4, saveNotKept: true })).toContain(
			'preamble saved in 4 ms, not kept: no room',
		);
		expect(steps({ saveMs: 4, saveNotKept: true })).not.toContain('preamble saved in 4 ms');
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

	it('says which version manifest.json gives and which main.js was built as, and when they differ', () => {
		const about = snapshot().about;
		const plugin = (over: Partial<typeof about>) =>
			diagnosticsText(snapshot({ about: { ...about, ...over } })).split('\n')[1];
		expect(plugin({ plugin: '0.2.2', built: '0.2.1' })).toBe(
			'Plugin: 0.2.2, main.js 0.2.1, out of step: reinstall the plugin on this device',
		);
		expect(plugin({ plugin: '0.2.2', built: null })).toBe('Plugin: 0.2.2, main.js unknown');
	});

	it('says whether the JIT is on, as the latest engine to start found it, and what the probe took', () => {
		const started = (jit: JitProbe | undefined, stop: EngineStop | null = null) =>
			diagnosticsText(
				snapshot({
					engine: {
						starts: 2,
						lives: [jit, undefined].map((probe) => ({
							startMs: 60,
							boot: {
								decodeMs: 2,
								inflateMs: 30,
								compileMs: 1,
								totalMs: 46,
								nativeInflate: true,
								nativeBase64: true,
								...(probe === undefined ? {} : { jit: probe }),
							},
							snapshots: null,
							stop: probe === undefined ? null : stop,
						})),
						lastStop: null,
						poolSize: 1,
					},
				}),
			);
		const probe = (state: JitState, again?: JitProbe): JitProbe => ({
			state,
			fastestMs: 3,
			attempts: 4,
			spentMs: 12,
			...(again === undefined ? {} : { again }),
		});
		// An engine of a worker that does not time it says nothing, and the one before it does. Off at
		// the start, it is taken again a second later, and that is what the start says (D38).
		const off = started(probe('off', probe('off')));
		expect(off).toContain('\nJIT: off (probably)\n');
		expect(off).toContain(
			'  1. started in 60 ms (in the worker 46 ms: decode 2 ms, inflate 30 ms, compile 1 ms, JIT probe 12 ms, ' +
				'again a second later 12 ms; native gzip yes, native base64 yes; JIT off (probably)), running',
		);
		// Until then, it is being checked; an engine stopped first never was.
		const checking = started(probe('off'));
		expect(checking).toContain('\nJIT: checking again\n');
		expect(checking).toContain(
			'JIT probe 12 ms; native gzip yes, native base64 yes; JIT checking again), running',
		);
		expect(started(probe('off'), 'background')).toContain('\nJIT: unclear\n');
		// Taken again and found on, as a phone whose loop was not compiled yet at the start.
		const later = started(probe('off', { ...probe('on'), attempts: 1, spentMs: 0.6 }));
		expect(later).toContain('\nJIT: on (probably)\n');
		expect(later).toContain('JIT probe 12 ms, again a second later 0.6 ms;');
		expect(started(probe('on'))).toContain('\nJIT: on (probably)\n');
		expect(started(probe('unclear', probe('unclear')))).toContain('\nJIT: unclear\n');
		expect(started(undefined)).toContain('\nJIT: not measured yet\n');
		expect(text).toContain('\nJIT: not measured yet\n');
		// With no WebAssembly no engine starts to measure it, and the copy says why.
		const base = snapshot();
		const noWasm = diagnosticsText({
			...base,
			about: { ...base.about, webView: { ...base.about.webView, webAssembly: false } },
		});
		expect(noWasm).toContain('\nJIT: no WebAssembly\n');
		expect(noWasm).toContain('WebView: WebAssembly no, ');
	});

	it('says of a render that resumed from a stored preamble what reading and putting it back took', () => {
		const steps = (timings: Partial<CompileTimings>) =>
			timingSteps({ queueMs: 1, postMs: 2, texMs: 9, passes: 1, ...timings });
		expect(steps({ resumed: true, restored: true, fetchMs: 12, restoreMs: 5 })).toEqual([
			'queue 1 ms',
			'TeX 9 ms',
			'resumed from a stored preamble (read 12 ms, put back 5 ms)',
			'SVG pipeline 2 ms',
		]);
		expect(steps({ resumed: true, restored: true })).toContain('resumed from a stored preamble');
		// One sent that could not be started from: its time is said, and the diagram saved its own.
		expect(steps({ restoreMs: 3, saveMs: 8 })).toEqual([
			'queue 1 ms',
			'TeX 9 ms',
			'stored preamble not used, 3 ms',
			'preamble saved in 8 ms',
			'SVG pipeline 2 ms',
		]);
	});

	/*
	 * The maintainer's iPhone said of one diagram "TeX 68 ms ... seen to drawn 10 ms": a block that
	 * joined a compile already under way, for a block a re-render replaced, was shown that compile's
	 * times as its own. And a diagram that resumed from a run the engine had put back from storage
	 * for an earlier diagram said it resumed from a saved preamble, as if this engine had saved it.
	 */
	it('says a render joined a compile already running, with its TeX as the compile’s, and none of its other steps', () => {
		const joined = timingSteps({
			waitedMs: 0,
			queueMs: 0,
			resetMs: 4,
			newMemory: 0,
			texMs: 68,
			passes: 1,
			saveMs: 15,
			svgMs: 3,
			postMs: 1,
			mountMs: 3,
			totalMs: 10,
			joined: true,
		});
		expect(joined).toEqual([
			'waited 0 ms',
			'joined a compile already running, whose TeX took 68 ms',
			'SVG pipeline 1 ms',
			'drawing 3 ms',
			'seen to drawn 10 ms',
		]);
		expect(timingSteps({ queueMs: 0, postMs: 1, joined: true })).toEqual([
			'joined a compile already running',
			'SVG pipeline 1 ms',
		]);
	});

	it('says a render resumed from a stored preamble when the engine had put it back for an earlier one', () => {
		const steps = (timings: Partial<CompileTimings>) =>
			timingSteps({ queueMs: 1, postMs: 2, texMs: 9, passes: 1, ...timings });
		expect(steps({ resumed: true, fromStore: true })).toEqual([
			'queue 1 ms',
			'TeX 9 ms',
			'resumed from a stored preamble put back for an earlier diagram',
			'SVG pipeline 2 ms',
		]);
		// Put back for this one, it says what that took; saved by this engine, that it was saved.
		expect(steps({ resumed: true, restored: true, fromStore: true, restoreMs: 5 })).toContain(
			'resumed from a stored preamble (put back 5 ms)',
		);
		expect(steps({ resumed: true })).toContain('resumed from a saved preamble');
	});

	it('says what is stored of saved preambles, and what storage refused', () => {
		const line = (preambles: DiagnosticsSnapshot['preambles']) =>
			diagnosticsText(snapshot({ preambles }))
				.split('\n')
				.filter((l) => l.startsWith('Stored preambles'));
		expect(line({ available: true, read: false, runs: 0, bytes: 0, errors: 0 })).toEqual([
			'Stored preambles: not read yet, until the engine starts',
		]);
		expect(line({ available: true, read: true, runs: 3, bytes: 2.5 * 1048576, errors: 0 })).toEqual([
			'Stored preambles: 3, 2.5 MB',
		]);
		expect(line({ available: true, read: true, runs: 1, bytes: 1048576, errors: 1 })).toEqual([
			'Stored preambles: 1, 1.0 MB, 1 storage error',
		]);
		expect(line({ available: false, read: true, runs: 0, bytes: 0, errors: 2 })).toEqual([
			'Stored preambles: unavailable, 2 storage errors',
		]);
		// Off: the store is never read that session, and is not "not read yet".
		expect(line({ available: true, read: false, runs: 0, bytes: 0, errors: 0, off: true })).toEqual([
			'Stored preambles: off',
		]);
		expect(line(null)).toEqual([]);
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
