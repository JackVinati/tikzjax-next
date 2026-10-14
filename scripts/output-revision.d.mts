/**
 * Types for output-revision.mjs, so the tests read the corpus and the record with the same code that
 * writes the record. Keep it in step with the .mjs beside it.
 */

export interface OutputRecord {
	/** OUTPUT_REVISION when the outputs were recorded. */
	revision: string;
	/** ENGINE_ID of the worker the corpus was last checked against. */
	engine: string;
	/** Fixture name -> sha256 of its DVI's sha256, transcript and SVG. */
	outputs: Record<string, string>;
}

export declare function outputRevision(root: string): string;

export declare function goldenOutputs(root: string): Record<string, string>;

export declare function readRecord(root: string): OutputRecord | null;

export declare function compare(
	record: OutputRecord | null,
	outputs: Record<string, string>,
): { changed: string[]; added: string[]; gone: string[] };

export declare function record(
	root: string,
	engine: string,
): { written: boolean; refused: string[]; changed: string[]; added: string[]; gone: string[] };

export declare function bumpAdvice(changed: string[]): string;
