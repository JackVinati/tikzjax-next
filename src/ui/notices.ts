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
 * How many engine starts of a session must have found the JIT off, and none on, before the notice
 * says so. One probe is one moment: a phone in Low Power Mode, hot, or busy launching the app can be
 * slow enough for that moment to read as one without a JIT, where a second start, after the engine's
 * idle stop or a return from the background, is another (internal/DECISIONS.md D33).
 */
export const JIT_OFF_STARTS = 2;

/**
 * The notice that TeX seems to run without the JIT, for an engine that has just started: only on
 * iOS and iPadOS, where Lockdown Mode is the likely cause and can be told what to do about; only
 * when JIT_OFF_STARTS of this session's engine starts found the JIT off, and none on, as `starts`
 * counts them; and only if it has not been shown before. Elsewhere,
 * and on Android above all, the diagnostics view says what the probe found and nothing interrupts
 * anyone: nothing there turns the JIT off that a user would know of, and a slow phone is the device
 * the probe is likeliest to take for one without a JIT.
 */
export function noJitNotice(
	starts: { readonly on: number; readonly off: number },
	os: Device['os'],
	shown: boolean,
): DocumentFragment | null {
	if (shown || os !== 'iOS' || starts.on > 0 || starts.off < JIT_OFF_STARTS) return null;
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
