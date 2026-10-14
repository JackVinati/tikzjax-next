/*
 * Which characters the Unicode bridge (./unicode) declares: the ones nothing else draws.
 *
 * A module of its own, importing only the two tables it reads, because the cache key asks it of a
 * block on the main thread (src/cache/key.ts, internal/DECISIONS.md D26), and the rest of ./unicode,
 * the TeX it declares and the SVG it rewrites, belongs to the worker.
 */

import { isNativeUnicode } from '../src/source/native-unicode';
import { isTs1Symbol } from './ts1-shim';

/**
 * What the engine draws without the bridge: ASCII, what the scan measured native on the bare
 * engine, and what ./ts1-shim redefines into Computer Modern. The scan measures the bare engine,
 * which cannot draw the shim's symbols, so ° × ± µ £ € © and the rest are not in its table.
 */
const drawnByEngine = (cp: number): boolean => cp <= 0x7f || isNativeUnicode(cp) || isTs1Symbol(cp);

/**
 * The character TeX reads for `ch`, one codepoint as `for..of` gives them, when the bridge declares
 * it; undefined when the engine draws it. An astral character is one codepoint. A lone surrogate is
 * one too, and TextEncoder writes U+FFFD in its place, so that is the character TeX reads.
 */
export function bridgedCodepoint(ch: string): number | undefined {
	const cp = ch.codePointAt(0) ?? 0;
	const read = cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
	return drawnByEngine(read) ? undefined : read;
}

/** Whether ./unicode declares anything for `text`: whether TeX reading it meets the bridge. */
export function hasBridgedCharacter(text: string): boolean {
	for (const ch of text) if (bridgedCodepoint(ch) !== undefined) return true;
	return false;
}
