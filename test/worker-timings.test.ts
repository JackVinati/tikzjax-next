import { beforeAll, describe, expect, it } from 'vitest';
import type {
	ErrorMessage,
	OkMessage,
	RenderOptions,
	WorkerRequest,
	WorkerResponse,
} from '../engine-src/protocol';
import { buildWorker } from '../scripts/engine-assets.mjs';

/*
 * The worker says, with every render, how long each of its steps took: setting up TeX's memory,
 * TeX, and drawing the DVI as SVG. The diagnostics view shows them beside what the plugin times
 * itself.
 *
 * Asked of the worker that ships, built by the build's own function and run in this realm with
 * `self` shimmed, as scripts/verify-worker.mjs runs it, on the committed engine.
 */

let send: (source: string, options?: RenderOptions) => Promise<OkMessage | ErrorMessage>;

beforeAll(async () => {
	const { source } = await buildWorker('.');
	const inbox: WorkerResponse[] = [];
	let onmessage: ((event: { data: WorkerRequest }) => void) | null = null;
	(globalThis as { self?: unknown }).self = {
		postMessage: (message: WorkerResponse) => inbox.push(message),
		set onmessage(fn: typeof onmessage) {
			onmessage = fn;
		},
		get onmessage() {
			return onmessage;
		},
	};
	new Function(source)();
	expect(inbox[0]?.type).toBe('ready');

	let id = 0;
	send = (tex, options = {}) =>
		new Promise((resolve) => {
			const request: WorkerRequest = { type: 'render', id: ++id, source: tex, options };
			const settle = () => {
				const reply = inbox.find(
					(m): m is OkMessage | ErrorMessage =>
						(m.type === 'ok' || m.type === 'error') && m.id === request.id,
				);
				if (reply) resolve(reply);
				else setTimeout(settle, 5);
			};
			onmessage?.({ data: request });
			settle();
		});
}, 120_000);

/** Whole milliseconds, none negative, and together no more than the render took. */
function expectSane(reply: OkMessage | ErrorMessage): void {
	const t = reply.timings;
	expect(t).toBeDefined();
	if (!t) return;
	for (const ms of [t.resetMs, t.texMs, t.svgMs]) {
		expect(Number.isInteger(ms)).toBe(true);
		expect(ms).toBeGreaterThanOrEqual(0);
	}
	// Each is rounded on its own, so the three may come to a millisecond or two over the total.
	expect(t.resetMs + t.texMs + t.svgMs).toBeLessThanOrEqual(reply.durationMs + 2);
}

describe("the worker's timings", () => {
	it('come with a diagram, for one pass of TeX', async () => {
		const reply = await send('\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}');
		expect(reply.type).toBe('ok');
		expectSane(reply);
		expect(reply.timings?.passes).toBe(1);
		expect(reply.timings?.texMs).toBeGreaterThan(0);
	}, 60_000);

	it('add up both passes when TeX runs twice', async () => {
		// A reference resolves only on a second pass, which reads the .aux the first one wrote.
		const reply = await send(
			'\\refstepcounter{equation}\\label{e}\n\\begin{tikzpicture}\\node {\\ref{e}};\\end{tikzpicture}',
			{ twoPass: true },
		);
		expect(reply.type).toBe('ok');
		expectSane(reply);
		expect(reply.timings?.passes).toBe(2);
	}, 60_000);

	it('come with a failure too, which spent its time all the same', async () => {
		// TeX stops at the missing file before any page, so there is no DVI to draw, and no time
		// spent drawing one. Not `\relax`, which this used to send: \end{document} ships an empty
		// page, the worker draws it, and the time that takes rounds to 0 or 1 ms by chance.
		const reply = await send('\\input{nosuchfile}');
		expect(reply.type).toBe('error');
		expect(reply.log).toContain('No pages of output.');
		expectSane(reply);
		expect(reply.timings?.passes).toBe(1);
		expect(reply.timings?.svgMs).toBe(0);
	}, 60_000);
});
