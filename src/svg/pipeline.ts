/**
 * The SVG pipeline runner. See internal/DESIGN.md §7.2.
 *
 * An ordered array of pure stages over a parsed document. The runner's whole job is error
 * isolation: a stage that throws is SKIPPED, the last good document is kept, and the result is
 * marked degraded with a message naming the stage. There is never a silent fall-through to the raw
 * SVG — that is #15 (a diagram that renders as a black-on-black box because one pass half-ran) and
 * #48 (a third-party plugin monkey-patching `String.prototype.replaceAll` killed both inversion
 * and SVGO with no error reported anywhere).
 *
 * The runner does not mutate the document it is handed. Each stage runs against a snapshot which
 * is only committed if the stage returns, so a stage that throws half-way through its edits cannot
 * leave the artifact partly rewritten — "keep the previous output" has to mean the output, not
 * whatever the failing stage had managed to write.
 */

export interface Stage {
	/** Used verbatim in the degraded warning, so it must survive minification: a literal, not `fn.name`. */
	readonly name: string;
	/** `sanitize` and `ids`; see `isMandatory`. */
	readonly mandatory?: boolean | undefined;
	run(doc: Document): void;
}

export interface PipelineOptions {
	/**
	 * The `%!tikz raw` escape hatch: run only the mandatory stages. Not a degradation — the user
	 * asked for it — so it produces no warning.
	 */
	readonly raw?: boolean | undefined;
}

export interface PipelineResult<D extends Document = Document> {
	/** The final document. A different object from the input unless no stage ran. */
	doc: D;
	degraded: boolean;
	/** One human-readable line per skipped stage, for the `MOUNTED(degraded)` chip and `Artifact.warn`. */
	warnings: string[];
	/** The names of the stages that threw, in order. */
	skipped: string[];
}

/** Raised when a stage that may not be skipped fails. The document is not mountable. */
export class PipelineError extends Error {
	readonly stage: string;

	constructor(stage: string, cause: unknown) {
		super(`the ${stage} stage failed: ${describe(cause)}`, { cause });
		this.name = 'PipelineError';
		this.stage = stage;
	}
}

/**
 * Stages that always run: not disabled by `raw`, not skipped when they throw.
 *
 * Matching on the name as well as on the flag is deliberate. A stage array is assembled elsewhere,
 * and forgetting `mandatory: true` on `sanitize` would silently demote the one stage whose whole
 * purpose is to keep author markup that arrived through a `dvisvgm:raw` special out of a
 * persisted, replayed artifact (§7.2, defect 17). Belt and braces, in the direction of safety.
 */
const ALWAYS_RUN: ReadonlySet<string> = new Set(['sanitize', 'ids']);

export function isMandatory(stage: Stage): boolean {
	return stage.mandatory === true || ALWAYS_RUN.has(stage.name);
}

export function runPipeline<D extends Document>(
	doc: D,
	stages: readonly Stage[],
	options: PipelineOptions = {},
): PipelineResult<D> {
	let current = doc;
	const warnings: string[] = [];
	const skipped: string[] = [];

	for (const stage of stages) {
		const mandatory = isMandatory(stage);
		if (options.raw === true && !mandatory) continue;

		const candidate = snapshot(current);
		const target = candidate ?? current;

		try {
			stage.run(target);
		} catch (error) {
			if (mandatory) {
				// No safe degraded output exists. Without `sanitize` we cannot certify the markup
				// we are about to persist and replay; without `ids` the placeholders collide
				// between instances and every clip-path, mask, marker and gradient on the page
				// resolves to the wrong definition (#12). An error card beats either.
				throw new PipelineError(stage.name, error);
			}
			skipped.push(stage.name);
			warnings.push(
				candidate === null
					? `the ${stage.name} stage failed and was skipped, but the document could not be ` +
							`snapshotted first, so part of it may have been applied: ${describe(error)}`
					: `the ${stage.name} stage failed and was skipped: ${describe(error)}`,
			);
			continue;
		}

		if (candidate !== null) current = candidate;
	}

	return { doc: current, degraded: warnings.length > 0, warnings, skipped };
}

/**
 * A per-stage copy to roll back to. Returns null if the host cannot clone a document, in which
 * case the runner falls back to mutating in place: still isolated, but honest in the warning that
 * a partial edit may survive.
 */
function snapshot<D extends Document>(doc: D): D | null {
	try {
		return doc.cloneNode(true) as D;
	} catch {
		return null;
	}
}

/**
 * Never throws. This runs inside the catch that is the module's entire reason to exist, so a
 * value that cannot be stringified — a null-prototype throw, an `Error` whose `message` is not a
 * string, a monkey-patched `Object.prototype.toString` (#48 is that exact shape) — must degrade
 * to a vague warning, not turn the isolation layer into the thing that crashes the render.
 */
function describe(error: unknown): string {
	try {
		if (error instanceof Error) return `${String(error.name)}: ${String(error.message)}`;
		return String(error);
	} catch {
		return 'a value that could not be described';
	}
}
