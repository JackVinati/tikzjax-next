import { afterEach, describe, expect, it } from 'vitest';
import * as library from '../engine-src/library';

/*
 * What \filesize is told about a file.
 *
 * TeX's \filesize asks the host's getfilesize for a size and prints it, and since 0.2.0 prints
 * nothing when the host answers -1 (engine-build/changes/filesize-missing.ch), which is what pdfTeX
 * does for a file that does not exist. LaTeX's \IfFileExists asks \filesize and takes any answer
 * that is not empty for a file that exists. The host used to answer 0 for a file it did not have, so
 * every missing package and every \input of a missing file was found, and read as an empty file.
 */

afterEach(() => {
	library.deleteEverything();
	library.setMissingFileSink(null);
});

/** A file name as TeX hands it to the host: in TeX's memory, padded with spaces to a fixed width. */
const named = (name: string): [number, number] => {
	const width = 128;
	const at = 16;
	const memory = new ArrayBuffer(at + width);
	new Uint8Array(memory).set(new TextEncoder().encode(name.padEnd(width, ' ')), at);
	library.setMemory(memory);
	return [width, at];
};

const sizeOf = (name: string) => library.getfilesize(...named(name));

describe('getfilesize', () => {
	it('gives the size of a file the run was given', () => {
		library.writeFileSync('input.tex', new TextEncoder().encode('\\relax\n'));
		expect(sizeOf('input.tex')).toBe(7);
	});

	it('gives the size of a bundled file as TeX reads it, inflated', () => {
		const inflated = new TextEncoder().encode('\\ProvidesPackage{bundled-for-filesize}\n');
		library.setBundledFiles(
			new Map([['bundled-for-filesize.sty', new Uint8Array([1, 2, 3])]]),
			() => inflated,
		);
		expect(sizeOf('bundled-for-filesize.sty')).toBe(inflated.length);
	});

	it('gives the size of the metrics the converter has for a font', () => {
		expect(sizeOf('cmr10.tfm')).toBeGreaterThan(0);
	});

	it('answers -1 for a file there is none of, and reports a package that is missing', () => {
		const missing: string[] = [];
		library.setMissingFileSink((name) => missing.push(name));
		expect(sizeOf('nosuchpackage.sty')).toBe(-1);
		expect(sizeOf('nosuchdata.csv')).toBe(-1);
		// Asked for on every run, and absent on every first pass: not worth a word.
		expect(sizeOf('input.aux')).toBe(-1);
		expect(missing).toEqual(['nosuchpackage.sty']);
	});

	it('counts a file written earlier in the run, which TeX reads back empty', () => {
		const out = library.rewrite(...named('written.dat'));
		library.printChar(out, 65);
		expect(sizeOf('written.dat')).toBe(0);
	});
});
