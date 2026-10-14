import { describe, expect, it } from 'vitest';
import { budgetsFor, engineCount, snapshotBytes, storedRunBytes } from '../src/platform/budgets';

/*
 * How many engines run at once (internal/DECISIONS.md D24): two on a computer, while diagrams queue
 * up, and one on a phone or tablet, on a computer short of memory, or wherever the second engine is
 * turned off.
 */

const DESKTOP = budgetsFor(false);
const MOBILE = budgetsFor(true);
const ROOMY = { memoryGiB: 8, cores: 16 };

describe('engineCount', () => {
	it('is two on a computer, and one on a phone or a tablet whatever the setting says', () => {
		expect(engineCount(DESKTOP, true, ROOMY)).toBe(2);
		expect(engineCount(MOBILE, true, ROOMY)).toBe(1);
		expect(engineCount(MOBILE, false, ROOMY)).toBe(1);
	});

	it('is one where the second engine is turned off', () => {
		expect(engineCount(DESKTOP, false, ROOMY)).toBe(1);
	});

	it('is one on a computer that reports less than 8 GiB of memory', () => {
		expect(engineCount(DESKTOP, true, { memoryGiB: 4, cores: 16 })).toBe(1);
		expect(engineCount(DESKTOP, true, { memoryGiB: 0.5, cores: 16 })).toBe(1);
		expect(engineCount(DESKTOP, true, { memoryGiB: 8, cores: 2 })).toBe(2);
	});

	it('goes by the cores where the memory is not reported: fewer than four keep one engine', () => {
		expect(engineCount(DESKTOP, true, { memoryGiB: null, cores: 2 })).toBe(1);
		expect(engineCount(DESKTOP, true, { memoryGiB: null, cores: 4 })).toBe(2);
	});

	it('keeps two on a computer that reports neither', () => {
		expect(engineCount(DESKTOP, true, { memoryGiB: null, cores: null })).toBe(2);
	});
});

describe('saved preambles', () => {
	it('may hold 32 MiB an engine on a computer, and 12 on a phone or a tablet', () => {
		expect(budgetsFor(false).snapshotBytes).toBe(32 * 1024 * 1024);
		expect(budgetsFor(true).snapshotBytes).toBe(12 * 1024 * 1024);
	});

	it('hold 12 MiB, as on a phone, on a computer that reports less than 8 GiB, and else the platform budget', () => {
		expect(snapshotBytes(DESKTOP, { memoryGiB: 4 })).toBe(12 * 1024 * 1024);
		expect(snapshotBytes(DESKTOP, { memoryGiB: 8 })).toBe(32 * 1024 * 1024);
		expect(snapshotBytes(DESKTOP, { memoryGiB: null })).toBe(32 * 1024 * 1024);
		expect(snapshotBytes(MOBILE, { memoryGiB: 2 })).toBe(12 * 1024 * 1024);
		expect(snapshotBytes(MOBILE, { memoryGiB: null })).toBe(12 * 1024 * 1024);
	});
});

describe('saved preambles kept across the engine’s stops', () => {
	it('may take 64 MiB of storage on a computer, and 16 on a phone or a tablet', () => {
		expect(budgetsFor(false).storedRunBytes).toBe(64 * 1024 * 1024);
		expect(budgetsFor(true).storedRunBytes).toBe(16 * 1024 * 1024);
	});

	it('take 16 MiB, as on a phone, on a computer that reports less than 8 GiB, and else the platform budget', () => {
		expect(storedRunBytes(DESKTOP, { memoryGiB: 4 })).toBe(16 * 1024 * 1024);
		expect(storedRunBytes(DESKTOP, { memoryGiB: 8 })).toBe(64 * 1024 * 1024);
		expect(storedRunBytes(DESKTOP, { memoryGiB: null })).toBe(64 * 1024 * 1024);
		expect(storedRunBytes(MOBILE, { memoryGiB: null })).toBe(16 * 1024 * 1024);
	});
});
