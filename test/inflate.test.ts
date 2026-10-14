import { gzip, Inflate, ungzip } from 'pako';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipExactly, inflateExactly } from '../engine-src/inflate';

/*
 * The worker inflates its core dump once, at boot: its 22.3 MiB of non-zero runs since 0.2.0, the
 * whole 156.25 MiB before. pako's ungzip collects the output in 64 KiB chunks and then glues them
 * into a new array of the total length, so for that moment the bytes exist twice; with the whole
 * dump the boot peaked at about 313 MiB of ArrayBuffers instead of 156 — on a phone whose whole
 * budget for the worker is not much more than that. inflateExactly writes the stream into one
 * buffer of the size the result must have, and hands that buffer back.
 */

/** Bytes that compress, but not to nothing, so the stream has real blocks to decode. */
const bytes = (length: number): Uint8Array =>
	Uint8Array.from({ length }, (_, i) => (i * 7 + (i >> 9)) & 0xff);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('inflateExactly', () => {
	it('returns exactly the bytes ungzip would', () => {
		const data = bytes(3 * 65536 + 17);
		expect(inflateExactly(gzip(data), data.length)).toEqual(ungzip(gzip(data)));
	});

	it('hands back the one buffer pako inflated into, never a glued copy of chunks', () => {
		// Inflate's own onEnd is where pako copies its chunks into a fresh array of the total length.
		const glue = vi.spyOn(Inflate.prototype, 'onEnd');
		const data = bytes(5 * 65536);
		const out = inflateExactly(gzip(data), data.length);
		expect(glue).not.toHaveBeenCalled();
		expect(out.byteOffset).toBe(0);
		expect(out.buffer.byteLength).toBe(data.length);
	});

	it('refuses a stream that inflates to fewer bytes than the size it must have', () => {
		// The worker sets the dump over the whole non-growable Memory. A short one would leave live TeX
		// state uninitialised, to surface much later as garbage rather than as an error at boot.
		const data = bytes(65536);
		expect(() => inflateExactly(gzip(data), data.length + 1)).toThrow(
			`inflated to ${data.length} B, expected ${data.length + 1} B`,
		);
	});

	it('refuses a stream that inflates to more', () => {
		const data = bytes(65536 + 1);
		expect(() => inflateExactly(gzip(data), 65536)).toThrow(
			`inflated to ${data.length} B, expected 65536 B`,
		);
	});

	it('refuses a stream that is not gzip at all', () => {
		expect(() => inflateExactly(Uint8Array.of(1, 2, 3, 4), 4)).toThrow('could not be inflated');
	});

	it('refuses a stream cut short', () => {
		const gz = gzip(bytes(65536));
		expect(() => inflateExactly(gz.subarray(0, gz.length >> 1), 65536)).toThrow('could not be inflated');
	});
});

/*
 * Since 0.2.1 the worker inflates its dump and tex.wasm by the platform's own zlib, DecompressionStream,
 * where it has one, at less than half pako's time, and by pako where it has none (iOS before 16.4) or
 * once after the native attempt failed (internal/DECISIONS.md D30). Either way the result is exactly
 * `size` bytes, or an error: never a dump that is not the build's.
 */
describe('gunzipExactly', () => {
	it('inflates by the platform where it has DecompressionStream, to the bytes pako gives', async () => {
		const data = bytes(3 * 65536 + 17);
		const out = await gunzipExactly(gzip(data), data.length);
		expect(out.native).toBe(true);
		expect(out.bytes).toEqual(ungzip(gzip(data)));
		expect(out.bytes.byteLength).toBe(out.bytes.buffer.byteLength);
	});

	it('inflates by pako where there is no DecompressionStream, as on iOS before 16.4', async () => {
		vi.stubGlobal('DecompressionStream', undefined);
		const data = bytes(65536 + 3);
		const out = await gunzipExactly(gzip(data), data.length);
		expect(out).toEqual({ bytes: ungzip(gzip(data)), native: false });
	});

	it("falls back to pako, once, when the platform's attempt fails", async () => {
		let made = 0;
		class Broken {
			constructor() {
				made++;
				throw new TypeError('gzip is not supported here');
			}
		}
		vi.stubGlobal('DecompressionStream', Broken);
		const data = bytes(70_000);
		const out = await gunzipExactly(gzip(data), data.length);
		expect(out).toEqual({ bytes: ungzip(gzip(data)), native: false });
		expect(made).toBe(1);
	});

	it("falls back to pako when the platform's stream gives other bytes than the size says", async () => {
		// A platform that inflated and then disagreed about the length: pako has the last word.
		class Short extends DecompressionStream {
			constructor() {
				super('gzip');
				const reader = this.readable.getReader();
				Object.defineProperty(this, 'readable', {
					value: new ReadableStream({
						async pull(controller) {
							const { done, value } = await reader.read();
							if (done) controller.close();
							else controller.enqueue(value.subarray(1));
						},
					}),
				});
			}
		}
		vi.stubGlobal('DecompressionStream', Short);
		const data = bytes(4096);
		expect(await gunzipExactly(gzip(data), data.length)).toEqual({
			bytes: ungzip(gzip(data)),
			native: false,
		});
	});

	for (const [what, gz, size] of [
		['a stream that is not gzip at all', Uint8Array.of(1, 2, 3, 4), 4],
		['a stream cut short', gzip(bytes(65536)).subarray(0, 300), 65536],
		['a stream that inflates to fewer bytes than the size it must have', gzip(bytes(4096)), 4097],
		['a stream that inflates to more', gzip(bytes(4097)), 4096],
	] as const) {
		it(`refuses ${what}, by either way`, async () => {
			await expect(gunzipExactly(gz, size)).rejects.toThrow();
			vi.stubGlobal('DecompressionStream', undefined);
			await expect(gunzipExactly(gz, size)).rejects.toThrow();
		});
	}
});
