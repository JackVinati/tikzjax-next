/**
 * The worker started on a thread of its own, as a browser starts it: its source evaluated in a
 * worker_threads Worker with `self` shimmed, and the payload posted to it. Says how the start ended:
 * `ready`, the worker's error event, or nothing within `timeoutMs`, which is the hang this exists to
 * rule out.
 *
 * In JavaScript rather than TypeScript because it needs `node:worker_threads`, which this project
 * has no declarations for (tsconfig sets `"types": []`); start-worker.d.mts types it for the tests.
 */
import { Worker } from 'node:worker_threads';

export function startWorker(source, payload, { legacy = false, timeoutMs = 60_000 } = {}) {
	const shim =
		"const { parentPort } = require('node:worker_threads');\n" +
		(legacy ? 'delete globalThis.DecompressionStream;\ndelete Uint8Array.fromBase64;\n' : '') +
		'globalThis.self = {\n' +
		'	postMessage: (message) => parentPort.postMessage(message),\n' +
		'	setTimeout: (fn, ms) => setTimeout(fn, ms),\n' +
		"	set onmessage(fn) { parentPort.on('message', (data) => fn({ data })); },\n" +
		'};\n';
	return new Promise((resolve) => {
		const worker = new Worker(`${shim}${source}`, { eval: true });
		const started = Date.now();
		const end = (outcome) => {
			clearTimeout(timer);
			void worker.terminate();
			resolve({ ...outcome, ms: Date.now() - started });
		};
		const timer = setTimeout(() => end({ type: 'timeout' }), timeoutMs);
		worker.on('message', (message) => {
			if (message?.type === 'ready') end({ type: 'ready', boot: message.boot });
		});
		worker.on('error', (error) => end({ type: 'error', message: String(error?.message ?? error) }));
		worker.postMessage({ type: 'boot', assets: payload });
	});
}
