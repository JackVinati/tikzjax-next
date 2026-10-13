import { describe, expect, it } from 'vitest';
import { readText } from './support/read-text';

/*
 * TeX's hash table, as the engine is built with it (engine-build/build-engine.sh, D15).
 *
 * TeX hashes a control sequence's name to one of hash_prime slots and chains a name whose slot is
 * taken into a free one elsewhere in the table. web2js sized the table for 600,000 names and left
 * hash_prime at tex.web's 1777, so the 33,822 names in the dump hung in chains 19 long. The build
 * raises it. The engine is a committed artifact, so the value the build script sets has to be the
 * one the committed engine says it was built with, or the script describes an engine nobody built.
 */

const HASH_SIZE = 600000;

const field = (manifest: string, name: string): string | undefined =>
	new RegExp(`^${name} +(.+)$`, 'm').exec(manifest)?.[1];

const isPrime = (n: number): boolean => {
	if (n < 2) return false;
	for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
	return true;
};

describe("TeX's hash table", () => {
	const script = readText('engine-build/build-engine.sh');
	const manifest = readText('engine-build/out/BUILD-MANIFEST.txt');
	const set = Number(/^HASH_PRIME=(\d+)$/m.exec(script)?.[1]);

	it('is hashed into by a prime that fits the table and spreads the dump over many slots', () => {
		expect(isPrime(set)).toBe(true);
		expect(set).toBeLessThanOrEqual(HASH_SIZE);
		// At least twice the names the largest fixture ends with, circuitikz's 51,463.
		expect(set).toBeGreaterThan(2 * 51463);
	});

	it('is what the committed engine was built with', () => {
		expect(field(manifest, 'hash_prime')).toBe(`${set} (hash_size ${HASH_SIZE})`);
	});
});
