import { gzip } from 'pako';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineAssets } from '../engine-src/protocol';
import { buildWorker } from '../scripts/engine-assets.mjs';
import { startWorker } from './support/start-worker.mjs';

/*
 * How the engine starts, since 0.2.1 (internal/DECISIONS.md D30): the host sends the worker its
 * payload, tex.wasm, the core dump and the TeX files, as the first message, and the worker answers
 * `ready`, with where its start went, once it has inflated the dump and compiled tex.wasm.
 *
 * A payload it cannot start from must end in the worker's error event, which is how the host has
 * always learned that a start failed (src/engine/worker-host.ts `crashed`), and never in silence:
 * the host would then wait for a `ready` that does not come, and every diagram with it, until its
 * startup allowance gave up. Each case runs the worker that ships on a thread of its own, as a
 * browser runs it, with the payload changed.
 */

let source: string;
let payload: EngineAssets;

beforeAll(async () => {
	({ source, assets: payload } = await buildWorker('.'));
}, 120_000);

const toBase64 = (bytes: Uint8Array): string => {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
};

/** `text` with the four characters at its middle replaced by four others, still valid base64. */
const corrupt = (text: string): string => {
	const at = (text.length >> 3) * 4;
	return `${text.slice(0, at)}${text.slice(at, at + 4) === 'AAAA' ? 'BBBB' : 'AAAA'}${text.slice(at + 4)}`;
};

describe('the engine starting from the payload the host sends it', { timeout: 120_000 }, () => {
	it('answers ready, with where its start went, inflated by the platform where it has DecompressionStream', async () => {
		const outcome = await startWorker(source, payload);
		expect(outcome.type).toBe('ready');
		if (outcome.type !== 'ready') return;
		expect(outcome.boot).toMatchObject({ nativeInflate: true });
		const boot = outcome.boot!;
		for (const ms of [boot.decodeMs, boot.inflateMs, boot.compileMs]) {
			expect(Number.isInteger(ms)).toBe(true);
			expect(ms).toBeGreaterThanOrEqual(0);
		}
		expect(boot.decodeMs + boot.inflateMs + boot.compileMs).toBeLessThanOrEqual(boot.totalMs + 2);
		expect(boot.nativeBase64).toBe(
			typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 === 'function',
		);
		// Node runs WebAssembly with a JIT, and the probe that says so is part of the start
		// (engine-src/jit.ts, internal/DECISIONS.md D33).
		expect(boot.jit).toMatchObject({ state: 'on' });
		expect(boot.jit!.spentMs).toBeLessThanOrEqual(boot.totalMs + 1);
		// What it is weighed against when its loop is slow: the platform's inflate of the dump, a byte.
		expect(boot.jit!.inflateNsPerByte).toBeGreaterThan(0);
	});

	it('answers ready without DecompressionStream and Uint8Array.fromBase64, as on iOS 14.5 to 16.3', async () => {
		const outcome = await startWorker(source, payload, { legacy: true });
		expect(outcome.type).toBe('ready');
		if (outcome.type === 'ready') {
			expect(outcome.boot).toMatchObject({ nativeInflate: false, nativeBase64: false });
			// pako is JavaScript, and slows without a JIT as the probe's loop does: not weighed against.
			expect(outcome.boot?.jit?.inflateNsPerByte).toBeUndefined();
		}
	});

	const broken: [string, () => Record<string, unknown>][] = [
		['a core dump whose bytes were changed', () => ({ ...payload, dump: corrupt(payload.dump) })],
		[
			'a core dump cut short',
			() => ({ ...payload, dump: payload.dump.slice(0, (payload.dump.length >> 3) * 4) }),
		],
		[
			'a core dump that inflates to the wrong size',
			() => ({ ...payload, dump: toBase64(gzip(new Uint8Array(4096).fill(7))) }),
		],
		['a core dump that is not base64', () => ({ ...payload, dump: 'not base64 at all' })],
		['a tex.wasm whose bytes were changed', () => ({ ...payload, wasm: corrupt(payload.wasm) })],
		['a tex.wasm that is not gzip', () => ({ ...payload, wasm: toBase64(new Uint8Array(64).fill(1)) })],
		['no payload at all', () => ({})],
	];
	for (const [what, make] of broken) {
		for (const legacy of [false, true]) {
			it(`fails, with the worker's error event, on ${what}${legacy ? ', without the platform decoders' : ''}`, async () => {
				const outcome = await startWorker(source, make(), { legacy, timeoutMs: 30_000 });
				expect(outcome.type).toBe('error');
			});
		}
	}
});
