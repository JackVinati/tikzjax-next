/**
 * The wire protocol between the plugin and the TeX worker.
 *
 * Upstream speaks threads.js. We do not: the master side of that protocol is ~120 lines of
 * frame handling to talk to a worker we now compile ourselves, and its one genuinely awkward
 * property — TeX stdout arrives as a BARE STRING postMessage rather than a protocol frame, so a
 * handler that switches on `type` first silently drops every log line — disappears once both ends
 * are ours. Every message here is a tagged object.
 *
 * Correlation is by `id`. A worker runs one job at a time, but ids make a late reply from a job
 * that was abandoned (timeout, unload) unambiguous rather than something to guess about.
 */

export type TexErrorKind =
	| 'tex-error' //      TeX reported `! ...` and produced no usable DVI
	| 'missing-file' //   a \usepackage or \input names something not in the bundle
	| 'capacity' //       TeX capacity exceeded
	| 'empty-output' //   TeX finished but wrote no DVI, or the DVI produced no SVG
	| 'timeout' //        the master gave up; the worker is terminated, never reused
	| 'aborted' //        the block went away before the job started; never surfaced to the user
	| 'engine-unavailable'; //  the worker failed to boot at all

/** Everything that changes the bytes TeX produces. Anything not here is presentation. */
export interface RenderOptions {
	/** `{ pgfplots: '', circuitikz: 'siunitx' }` -> \usepackage[siunitx]{circuitikz} */
	texPackages?: Record<string, string>;
	/** Comma-separated, as \usetikzlibrary takes it. */
	tikzLibraries?: string;
	/** Raw TeX spliced into the preamble, after packages and libraries. */
	addToPreamble?: string;
	/**
	 * Whether to wrap the source in \begin{document}...\end{document}.
	 *
	 * Upstream wraps unconditionally. Every existing Obsidian ```tikz block writes its own
	 * (README:29), so wrapping those would nest document environments in every note in every
	 * vault. 'auto' wraps only when the source has none, which is the only safe default for a
	 * plugin inheriting other people's vaults.
	 */
	wrap?: 'auto' | 'always' | 'never';
	/** Capture TeX's terminal output. Off costs nothing; on is what makes errors explainable. */
	captureLog?: boolean;
	/**
	 * Run TeX twice, with the files the first run wrote — `input.aux` above all — present for the
	 * second, and draw the second run's DVI.
	 *
	 * This is what `\label`/`\ref`/`\pageref` and the `remember picture` family need: they resolve
	 * against an `.aux` that only exists once a run has already happened. It costs a second full
	 * compile, so it is per-block and never a default. The worker still runs one pass when the
	 * first wrote nothing a second could read back, so the flag on a block that cannot benefit is
	 * free rather than 2x.
	 */
	twoPass?: boolean | undefined;
}

export interface RenderRequest {
	type: 'render';
	id: number;
	source: string;
	options: RenderOptions;
}

export interface PingRequest {
	type: 'ping';
	id: number;
}

export type WorkerRequest = RenderRequest | PingRequest;

export interface ReadyMessage {
	type: 'ready';
	engineId: string;
	/** Package versions and file list, so error messages can be specific about what is bundled. */
	inventory: EngineInventory;
}

export interface LogMessage {
	type: 'log';
	id: number;
	line: string;
}

export interface OkMessage {
	type: 'ok';
	id: number;
	svg: string;
	log: string[];
	/** Bundled-file misses. Mostly benign probes; the diagnostic value is on the failure path. */
	missing: string[];
	durationMs: number;
	/**
	 * TeX reported an error but recovered and still produced a diagram.
	 *
	 * This combination did not exist before \nonstopmode: without it TeX stops at the interactive
	 * prompt and there is no output to have an opinion about. With it, the common case for a
	 * mistyped macro is a diagram that renders with a piece missing — so staying quiet because
	 * "it worked" would hide exactly the failure the user is looking at. The plugin mounts the
	 * diagram AND shows the diagnostic.
	 */
	firstError?: string | undefined;
	/** The `l.NN` line TeX blamed. */
	line?: number | undefined;
}

export interface ErrorMessage {
	type: 'error';
	id: number;
	kind: TexErrorKind;
	message: string;
	/** The first `! ...` line, when there is one. */
	firstError?: string | undefined;
	/** The `l.NN` line number TeX blamed, when it gave one. */
	line?: number | undefined;
	log: string[];
	missing: string[];
	durationMs: number;
}

export type WorkerResponse = ReadyMessage | LogMessage | OkMessage | ErrorMessage;

export interface EngineInventory {
	engineId: string;
	/** e.g. 'etex-3.141592653-2.6' */
	engine: string;
	/** Built from the image's TeX distribution at build time; never hand-maintained. */
	packages: Record<string, string>;
	/** Every name the virtual filesystem can serve. Drives the pre-flight "not bundled" lint. */
	files: string[];
	capabilities: {
		/** True on our build: web2js applies changes/expanded.ch and changes/strcmp.ch. */
		expl3: boolean;
		/** A second TeX pass for \label/remember picture. Not implemented yet. */
		twoPass: boolean;
	};
}
