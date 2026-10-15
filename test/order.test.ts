import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real module is the worker string and its payload, produced by the build; a payload of short
// strings stands in for it.
vi.mock('virtual:engine', () => ({
	WORKER_SOURCE: '',
	ENGINE_ASSETS: { wasm: 'd2FzbQ==', dump: 'ZHVtcA==', files: {} },
	ENGINE_ID: 'test-engine',
	ENGINE_INVENTORY: null,
}));

import { phone, type Diagram } from './support/order-sim';

/*
 * The iPhone's beta.6 diagnostics after a start, a note of four diagrams in this order
 * (internal/DECISIONS.md D40):
 *
 *   #1 small plain tikzpicture  queue 270  memory reset 1, TeX 13, saved 8, DVI 0, drawing 1          seen to drawn 296
 *   #2 circuitikz               queue   0  engine start 36, new memory 4, TeX 87, read 16, put back 10,
 *                                          DVI 10, pipeline 1, drawing 18                             170
 *   #3 pgfplots                 queue 150  memory reset 2, TeX 69, read 23, put back 11, DVI 2,
 *                                          pipeline 1, drawing 1                                      259
 *   #4 pgfplotstable            queue 257  memory reset 1, TeX 35, read 7, put back 8, DVI 1,
 *                                          pipeline 1, drawing 1                                      312
 *
 * The engine "started in 38 ms" and #2 waited 36 of it, so it was created 2 ms before #2 asked. #3
 * started when #2 was done (150), #4 when #3 was (150 + 23 + 2 + 69 + 11 + 2 = 257), and #1 when #4
 * was (257 + 7 + 1 + 35 + 8 + 1 = 309): #1, 270 ms in the queue, asked at about 39, three ms after the
 * engine came up and #2 went into it. #2, #3 and #4 asked at 0.
 */
const NOTE: Diagram[] = [
	{ name: '#1', place: 1, packages: {}, workMs: 1 + 13 + 8 + 0, readMs: undefined, afterMs: 0 + 1 },
	{
		name: '#2',
		place: 2,
		packages: { circuitikz: '' },
		workMs: 4 + 87 + 10 + 10,
		readMs: 16,
		afterMs: 1 + 18,
	},
	{ name: '#3', place: 3, packages: { pgfplots: '' }, workMs: 2 + 69 + 11 + 2, readMs: 23, afterMs: 1 + 1 },
	{
		name: '#4',
		place: 4,
		packages: { pgfplotstable: '' },
		workMs: 1 + 35 + 8 + 1,
		readMs: 7,
		afterMs: 1 + 1,
	},
];

function diagram(name: string): Diagram {
	const found = NOTE.find((d) => d.name === name);
	if (found === undefined) throw new Error(name);
	return found;
}

let realWorker: unknown;
beforeEach(() => {
	realWorker = (globalThis as { Worker?: unknown }).Worker;
});
afterEach(() => {
	(globalThis as { Worker?: unknown }).Worker = realWorker;
});

/**
 * The note as beta.6 met it: the three blocks that load a package missed the cache at once, the
 * first of them started the engine, and the small one at the top missed `late` ms after them. With
 * `place`, each says where it is in the note, as the processor now has it say.
 */
async function open(opts: { late: number; bootMs?: number; place?: boolean; engines?: number }) {
	const p = phone(NOTE, { bootMs: opts.bootMs ?? 38, place: opts.place, engines: opts.engines });
	p.miss();
	await p.sim.run(2);
	for (const name of ['#2', '#3', '#4']) p.submit(diagram(name));
	await p.sim.run(2 + opts.late);
	p.submit(diagram('#1'));
	await p.sim.run(10_000);
	return p;
}

/** How long the diagram waited for the queue to start it, as its diagnostics say. */
function queued(p: Awaited<ReturnType<typeof open>>, name: string): number {
	const outcome = p.outcomes.find((o) => o.name === name);
	if (outcome?.started === undefined) throw new Error(`${name} never started`);
	return outcome.started - outcome.asked;
}

describe('the order a phone draws a note in after a start', () => {
	it('was beta.6’s: the small diagram at the top, which asked last, drawn last', async () => {
		const p = await open({ late: 39 });
		expect(p.posted).toEqual(['#2', '#3', '#4', '#1']);
		// The diagnostics said 270.
		expect(queued(p, '#1')).toBeGreaterThanOrEqual(260);
	});

	it('draws the diagram at the top before the heavier ones below it that were waiting', async () => {
		const p = await open({ late: 39, place: true });
		// #2 was in the engine before #1 asked; no TeX run is stopped for another.
		expect(p.posted).toEqual(['#2', '#1', '#3', '#4']);
		expect(queued(p, '#1')).toBeLessThan(120);
	});

	it('on a computer with two engines, puts the top one in the first engine free', async () => {
		const before = await open({ late: 39, engines: 2 });
		expect(before.posted.slice(0, 3)).toEqual(['#2', '#3', '#4']);
		const after = await open({ late: 39, engines: 2, place: true });
		expect(after.posted.slice(0, 3)).toEqual(['#2', '#3', '#1']);
	});
});
