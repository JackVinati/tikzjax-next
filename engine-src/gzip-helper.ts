/**
 * The worker the engine's worker starts to gzip the runs it hands over on a thread of its own, while
 * TeX goes on with the next diagram (worker.ts gzipHelper, internal/DECISIONS.md D38): its whole
 * source, as text, which needs nothing but the platform's CompressionStream. It says it is up, then
 * for each run it is sent gzips it and sends the bytes back with the time it took, or, on a failure,
 * sends the run's own bytes back, for the engine's worker to gzip itself.
 */
export const GZIP_HELPER = [
	'"use strict";',
	'self.onmessage = async (event) => {',
	'\tconst { id, bytes } = event.data;',
	'\tconst started = performance.now();',
	'\ttry {',
	"\t\tconst stream = new CompressionStream('gzip');",
	'\t\tconst writer = stream.writable.getWriter();',
	'\t\twriter.write(new Uint8Array(bytes)).catch(() => undefined);',
	'\t\twriter.close().catch(() => undefined);',
	'\t\tconst reader = stream.readable.getReader();',
	'\t\tconst chunks = [];',
	'\t\tlet length = 0;',
	'\t\tfor (;;) {',
	'\t\t\tconst { done, value } = await reader.read();',
	'\t\t\tif (done) break;',
	'\t\t\tchunks.push(value);',
	'\t\t\tlength += value.length;',
	'\t\t}',
	'\t\tconst out = new Uint8Array(length);',
	'\t\tlet at = 0;',
	'\t\tfor (const chunk of chunks) {',
	'\t\t\tout.set(chunk, at);',
	'\t\t\tat += chunk.length;',
	'\t\t}',
	'\t\tself.postMessage({ id, gz: out.buffer, ms: performance.now() - started }, [out.buffer]);',
	'\t} catch (error) {',
	'\t\tself.postMessage({ id, bytes, error: String(error) }, [bytes]);',
	'\t}',
	'};',
	'self.postMessage({ up: true });',
].join('\n');
