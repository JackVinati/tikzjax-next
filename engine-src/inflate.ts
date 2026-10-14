import { Inflate } from 'pako';

/**
 * A gzip stream inflated into one buffer of exactly `size` bytes, or an error.
 *
 * For the core dump, at every worker boot: its non-zero runs since 0.2.0, 22.3 MiB, and the whole
 * 156.25 MiB before that (./core-dump). pako's `ungzip` collects its output in 64 KiB chunks and at
 * the end copies them into a new array of the total length, so for that moment the bytes exist
 * twice — with the whole dump the boot peaked at about 313 MiB of ArrayBuffers instead of 156 (V8,
 * measured), against an iOS budget that allows a worker not much more than the dump itself.
 *
 * With the chunk size set to the size the result has to have anyway, pako allocates one output
 * buffer, writes the whole stream into it and passes that buffer itself to onData. Leaving its
 * onEnd out, which is the step that copies, makes that buffer the result.
 *
 * The size is asserted as well as used. A stream that inflates short or long is not what the build
 * packed, and starting TeX from it would corrupt live TeX state, to surface much later as garbage
 * output; refused here, it fails at boot instead.
 */
export function inflateExactly(gz: Uint8Array, size: number): Uint8Array {
	const inflator = new Inflate({ chunkSize: size });
	inflator.onEnd = () => {
		// Deliberately nothing: pako's own onEnd glues the chunks into a copy. See above.
	};
	inflator.push(gz, true);
	if (inflator.err) throw new Error(`the stream could not be inflated: ${inflator.msg}`);

	const [whole, ...rest] = inflator.chunks;
	if (whole === undefined || rest.length > 0 || whole.length !== size) {
		const inflated = inflator.chunks.reduce((n, chunk) => n + chunk.length, 0);
		throw new Error(`inflated to ${inflated} B, expected ${size} B`);
	}
	return whole;
}

/** Whether the platform inflates gzip itself: Safari and iOS 16.4, Chrome 80, Node 18. */
export const hasNativeGunzip = (): boolean => typeof DecompressionStream === 'function';

/**
 * inflateExactly by the platform's own zlib, DecompressionStream, where there is one, read a chunk at
 * a time into the one buffer of exactly `size` bytes, so the bytes are never held twice. pako is
 * zlib written in JavaScript: it took 105 to 114 ms of the desktop's 192 to 205 ms engine start in
 * WebKit and Chromium, and the platform's takes less than half that (internal/DECISIONS.md D30).
 *
 * pako inflates instead where there is no DecompressionStream, iOS before 16.4 above all, and after
 * any failure of the native attempt, once: a platform that has the API and gets it wrong costs a
 * start some time, not the engine. A stream that really is wrong then fails in pako too, with the
 * same checks as before, and the start fails with it.
 */
export async function gunzipExactly(
	gz: Uint8Array,
	size: number,
): Promise<{ bytes: Uint8Array; native: boolean }> {
	if (hasNativeGunzip()) {
		try {
			return { bytes: await nativeGunzip(gz, size), native: true };
		} catch {
			// pako, below.
		}
	}
	return { bytes: inflateExactly(gz, size), native: false };
}

async function nativeGunzip(gz: Uint8Array, size: number): Promise<Uint8Array> {
	const out = new Uint8Array(size);
	const stream = new DecompressionStream('gzip');
	const writer = stream.writable.getWriter();
	// Not awaited: a write settles only as the readable side is drained, below, and a stream that
	// fails says so there, as a read that rejects.
	writer.write(gz as Uint8Array<ArrayBuffer>).catch(() => undefined);
	writer.close().catch(() => undefined);
	const reader = stream.readable.getReader();
	let at = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (at + value.length > size) throw new Error(`inflated past ${size} B`);
			out.set(value, at);
			at += value.length;
		}
	} catch (error) {
		reader.cancel().catch(() => undefined);
		throw error;
	}
	if (at !== size) throw new Error(`inflated to ${at} B, expected ${size} B`);
	return out;
}
