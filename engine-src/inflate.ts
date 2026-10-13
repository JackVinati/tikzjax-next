import { Inflate } from 'pako';

/**
 * A gzip stream inflated into one buffer of exactly `size` bytes, or an error.
 *
 * For the core dump, at every worker boot: its non-zero runs since 0.2.0, 21.5 MiB, and the whole
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
