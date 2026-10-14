import type { BootTimings } from '../../engine-src/protocol';
import type { Device } from '../platform/device';
import { outOfStep, versionPair } from '../platform/version';
import { README_LOCKDOWN, README_OUT_OF_STEP, STRINGS } from './strings';

/**
 * The two things the plugin tells someone unasked, once, about the device rather than a diagram:
 * that TeX runs without the JIT on their iPhone or iPad (internal/DECISIONS.md D33), and that the
 * main.js this device runs is not the version its manifest.json says (D34). Each decides here, from
 * what it is given, whether there is anything to say, and main.ts shows it and remembers it in
 * data.json.
 */

/** A sentence, then a link to the README that says more, into a notice's message or a line of the view. */
export function withReadme(
	parent: DocumentFragment | HTMLElement,
	text: string,
	link: string,
	href: string,
): void {
	parent.appendText(`${text} `);
	parent.createEl('a', { text: link, attr: { href, target: '_blank', rel: 'noopener' } });
}

/**
 * The notice that TeX runs without the JIT, for an engine that has just started: only on iOS and
 * iPadOS, where Lockdown Mode is the usual cause and can be told what to do about, only when the
 * engine's probe found the JIT off, and only if it has not been shown before. Elsewhere, and on
 * Android above all, the diagnostics view says what the probe found and nothing interrupts anyone:
 * nothing there turns the JIT off that a user would know of, and a slow phone is the device the
 * probe is likeliest to take for one without a JIT.
 */
export function noJitNotice(
	boot: BootTimings | null,
	os: Device['os'],
	shown: boolean,
): DocumentFragment | null {
	if (shown || os !== 'iOS' || boot?.jit?.on !== false) return null;
	return createFragment((message) =>
		withReadme(message, STRINGS.jitNotice, STRINGS.readMore, README_LOCKDOWN),
	);
}

/**
 * The notice that main.js and manifest.json are of different versions, with the pair it is for, or
 * null when they are the same, when either is unknown, or when it was last shown for this pair.
 */
export function outOfStepNotice(
	built: string | null,
	manifest: string,
	shownFor: string,
): { message: DocumentFragment; pair: string } | null {
	if (built === null || !outOfStep(built, manifest)) return null;
	const pair = versionPair(built, manifest);
	if (pair === shownFor) return null;
	return {
		message: createFragment((message) =>
			withReadme(
				message,
				STRINGS.outOfStepNotice(built, manifest),
				STRINGS.readMore,
				README_OUT_OF_STEP,
			),
		),
		pair,
	};
}
