/**
 * Which engine a job goes to, when more than one could take it (internal/DECISIONS.md D32).
 *
 * Each engine keeps the runs it saved at the end of a diagram's \begin{document}, and a diagram
 * whose input is the same up to there starts from one of them and compiles only its body. With two
 * engines on a computer (D24), a diagram that went to the engine without its preamble's run compiled
 * the preamble again, and saved it a second time: in a note of 74 diagrams, every one twice, only 32
 * of the 52 that could have started from a saved run did, measured with the snapshot's prototype.
 *
 * So the host names each job's run as the worker names the runs it holds (engine-src/document.ts
 * routeOf), and gives the job to the idle engine that holds it. If none does, to an idle engine
 * that holds none of the runs the other waiting jobs want, so as not to take an engine another job
 * would resume in; and else to the first idle engine. A job never waits for a busy engine that holds
 * its run: an engine standing idle while a job waits costs more than the preamble does.
 *
 * Kept apart from the host so that the measurement harness runs the same choice.
 */

/** An engine, as the choice sees it: the names of the runs it holds. */
export interface RouteCandidate {
	readonly held: ReadonlySet<string>;
}

/**
 * The engine of `idle` to give a job whose run is named `route` (undefined: no run can be named),
 * when the other jobs waiting want `others`. Undefined only when `idle` is empty.
 */
export function pickEngine<T extends RouteCandidate>(
	route: string | undefined,
	idle: readonly T[],
	others: readonly (string | undefined)[],
): T | undefined {
	if (route !== undefined) {
		const holder = idle.find((engine) => engine.held.has(route));
		if (holder !== undefined) return holder;
	}
	const wanted = others.filter((name): name is string => name !== undefined && name !== route);
	return idle.find((engine) => !wanted.some((name) => engine.held.has(name))) ?? idle[0];
}
