import type { Stage } from './pipeline';
import { sanitizeSvg } from './sanitize';
import { remapSoftHyphens } from './entities';
import { placeholderIds } from './ids';
import { applyColorModel } from './colors';
import { targetedTransform, type OptimizeMode } from './optimize';

/**
 * The pipeline, assembled. See internal/DESIGN.md §7.2 for the ordering rules and why each holds.
 *
 * Two stages are MANDATORY and are exempt from both skipping and the `raw` escape hatch:
 *
 *   `sanitize`  because the engine passes `\special{dvisvgm:raw ...}` through verbatim, the
 *               artifact is then PERSISTED, and a cache hit replays it on every later open. An
 *               escape hatch that could disable it would be a setting that stores an exploit.
 *   `ids`       because without it two copies of the same diagram emit byte-identical ids and
 *               `url(#id)` resolves to the first in document order, so one of them loses its
 *               clipping (#12). A degraded mount that skipped it would reintroduce the bug it
 *               degraded to avoid.
 *
 * `colors` runs AFTER `optimize`, not before. SVGO's `convertColors` collapses the value space to
 * `#000`/`#fff`, so running the colour pass first means the two cancel — which is one of the six
 * reasons the shipped plugin's dark mode misbehaves.
 *
 * Nothing here depends on the block's colour mode. The mode is not in the cache key, so a stage
 * that read it would store one block's mode and serve it to every other (see colors.ts).
 */
export interface StageOptions {
	optimize: OptimizeMode;
}

export function buildStages(options: StageOptions): Stage[] {
	const stages: Stage[] = [
		{
			name: 'sanitize',
			mandatory: true,
			// What it took out, for the chip under the diagram: the engine emits none of it, so it
			// came from a raw special, and whoever wrote one should learn why their markup is gone.
			run: (doc) => sanitizeSvg(doc).map((removal) => removal.detail),
		},
		{
			name: 'entities',
			run: (doc) => {
				remapSoftHyphens(doc);
			},
		},
		{
			name: 'ids',
			mandatory: true,
			run: (doc) => {
				placeholderIds(doc);
			},
		},
	];

	// `preset` is applied by the caller as a string pass around the DOM stages — SVGO does not
	// operate on a document — so only `targeted` appears here.
	if (options.optimize === 'targeted') {
		stages.push({ name: 'optimize', run: targetedTransform });
	}

	stages.push({
		name: 'colors',
		run: (doc) => {
			applyColorModel(doc);
		},
	});

	return stages;
}
