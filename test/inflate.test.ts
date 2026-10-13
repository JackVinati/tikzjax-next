import { gzip, Inflate, ungzip } from 'pako';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inflateExactly } from '../engine-src/inflate';

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
