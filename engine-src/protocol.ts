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
	/**
	 * What the worker may hold of saved runs, in bytes: TeX as a first pass stood at the end of its
	 * \begin{document}, which a later diagram with the same input up to there starts from
	 * (internal/DECISIONS.md D32). The host sends the platform's budget, or 0 when they are turned
	 * off, and the worker then neither saves nor resumes and lets every saved run go. Absent is 0.
	 * Not one of the RenderOptions, which are what TeX draws: a run resumed draws what a run from
	 * the start draws.
	 */
	snapshots?: number | undefined;
	/**
	 * A run the host kept of an earlier engine's (./stored-run, internal/DECISIONS.md D36), for this
	 * render's first pass to start from when the worker holds no run for it. Its `data` is
	 * transferred, not copied. Ignored when `snapshots` is 0.
	 */
	stored?: StoredRun | undefined;
	/**
	 * The host keeps the runs a worker saves: once the render has replied, the worker hands over the
	 * run it saved, if it saved one the host can name (SavedRunMessage). Absent is false.
	 */
	persist?: boolean | undefined;
	/**
	 * Where the host's store of runs stood when it posted the render, which every clear of it moves:
	 * handed back with the run the render saved (SavedRunMessage), so that a run saved before the
	 * diagram cache was cleared, or saved preambles turned off, and handed over after, is not kept.
	 * Absent is 0.
	 */
	epoch?: number | undefined;
}

/** A saved run as the host keeps it, in IndexedDB, across the engine's stops (./stored-run, D36). */
export interface StoredRun {
	/** The name the host gives the diagrams that start from it (./document routeOf). */
	route: string;
	/** Its bytes, gzipped when `compressed`. */
	data: ArrayBuffer;
	compressed: boolean;
	/** How many bytes `data` holds once inflated. */
	rawBytes: number;
}

/**
 * A run the worker saved for a render, written out as bytes for the host to keep, posted once that
 * render has replied, so that writing it out never holds up its diagram. `data` is transferred.
 */
export interface SavedRunMessage {
	type: 'saved-run';
	/** The render that saved it. */
	id: number;
	/** The render's RenderRequest.epoch. */
	epoch: number;
	run: StoredRun;
	/**
	 * TeX's time, in that render's first pass, from its start to where it was saved: what a diagram
	 * that starts from the run does not spend.
	 */
	preambleMs: number;
	/** What saving it took in that render, which a diagram that starts from the run does not pay either. */
	saveMs: number;
	/** What writing it out as bytes and compressing them took, after the reply. */
	encodeMs: number;
	/**
	 * What writing it out took of that, in one step before the slices of the rest: the longest a
	 * render posted meanwhile waits for it (worker.ts handOver).
	 */
	writeMs?: number | undefined;
}

export interface PingRequest {
	type: 'ping';
	id: number;
}

/**
 * The engine's payload, as base64 text: what main.js carries of tex.wasm, of the core dump and of
 * the bundled TeX files. The host sends it to the worker as data, in the first message, rather than
 * the build writing it into the worker's script, which every start had to parse, 9.7 MB of string
 * literals, before it could run a line of it (internal/DECISIONS.md D30).
 */
export interface EngineAssets {
	/** tex.wasm, gzipped. */
	wasm: string;
	/** The core dump's non-zero runs back to back, gzipped (scripts/engine-assets.mjs `packCoreDump`). */
	dump: string;
	/** TeX input file name -> its contents, gzipped. */
	files: Record<string, string>;
}

/** Always the first message a worker is sent, and only once; it answers `ready` when it has started. */
export interface BootRequest {
	type: 'boot';
	assets: EngineAssets;
}

export type WorkerRequest = RenderRequest | PingRequest | BootRequest;

/**
 * Where the engine's start went inside the worker, in whole milliseconds, and which of the
 * platform's own decoders it had, for the diagnostics view. The host times the start as a whole,
 * thread and all; this is the part of it the worker spent after the payload arrived.
 */
export interface BootTimings {
	/** base64 to bytes: tex.wasm's and the dump's. The TeX files are decoded when TeX first opens one. */
	decodeMs: number;
	/** The dump's runs inflated and checked. */
	inflateMs: number;
	/** What compiling tex.wasm took after the dump was ready: it runs while the dump inflates. */
	compileMs: number;
	/** From the payload's arrival to `ready`. */
	totalMs: number;
	/** Whether the platform's DecompressionStream inflated the dump, rather than pako. */
	nativeInflate: boolean;
	/** Whether the platform's Uint8Array.fromBase64 decoded, rather than the worker's own loop. */
	nativeBase64: boolean;
	/**
	 * Whether WebAssembly runs with a JIT here, probably, from a loop the worker timed once tex.wasm
	 * was compiled (./jit). Absent where it could not be timed, and from a worker before
	 * 0.2.1-beta.3, which did not time it.
	 */
	jit?: JitProbe | undefined;
}

/** What the worker's timing of a loop of known cost found (./jit, internal/DECISIONS.md D33). */
export interface JitProbe {
	/** The loop ran as compiled code runs: false when every attempt was slow, as without a JIT. */
	on: boolean;
	/** The fastest attempt by the worker's clock, in ms, cut short at the threshold when slow. */
	fastestMs: number;
	/** How many attempts it took: 1 unless the first was slow. */
	attempts: number;
	/** What the probe took of the start, in all. */
	spentMs: number;
}

export interface ReadyMessage {
	type: 'ready';
	engineId: string;
	/** Package versions and file list, so error messages can be specific about what is bundled. */
	inventory: EngineInventory;
	/** Absent from a worker that does not say, which every worker before 0.2.1-beta.2 is. */
	boot?: BootTimings | undefined;
}

export interface LogMessage {
	type: 'log';
	id: number;
	line: string;
}

/**
 * Where a render's time went inside the worker, in whole milliseconds, added up over every pass of
 * TeX. The plugin times the rest — the queue, the engine starting, the SVG pipeline — and the
 * diagnostics view shows them together, so a slow diagram can be reported with where it was slow.
 */
export interface RenderTimings {
	/**
	 * Setting up TeX's memory for each pass: the dump written back over what the run before wrote
	 * (./reset), or, when there was no Memory to reuse, a new one with the dump written into it
	 * (./core-dump).
	 */
	resetMs: number;
	/**
	 * How many of the passes started from a new Memory rather than the worker's own, reset: the
	 * first run in a worker, and a run after one that did not end normally. Absent from a worker
	 * before 0.2.1-beta.2, which took a new one every time.
	 */
	newMemory?: number | undefined;
	/** TeX: instantiating the compiled module, and the run. */
	texMs: number;
	/** dvi2html drawing the DVI as SVG. 0 when TeX wrote no DVI. */
	svgMs: number;
	/** How many times TeX ran: 2 when a second pass was taken (RenderOptions.twoPass). */
	passes: number;
	/**
	 * The first pass started from a run saved by an earlier diagram with the same input up to the end
	 * of its \begin{document}, and TeX compiled only what comes after (engine-src/snapshot.ts).
	 */
	resumed?: boolean | undefined;
	/**
	 * The run it resumed from was one the host had kept of an earlier engine and sent with the render
	 * (RenderRequest.stored), which the worker inflated, checked and read back in `restoreMs`.
	 */
	restored?: boolean | undefined;
	/** What putting back a run the host sent took, whether or not the render could start from it. */
	restoreMs?: number | undefined;
	/** The first pass was saved for later diagrams with the same preamble, which took this long. */
	saveMs?: number | undefined;
	/**
	 * The first pass was saved, in saveMs, and not kept: within the budget there was no room for it,
	 * however much of what the worker held could go (engine-src/snapshot.ts SnapshotCache).
	 */
	saveNotKept?: boolean | undefined;
	/** Saving the first pass failed, and nothing was kept; the diagram is drawn as without it. */
	saveFailed?: boolean | undefined;
}

/** What a worker holds of saved runs once it has replied, for the host to route by and to report. */
export interface SnapshotState {
	/** The name of each run it holds (engine-src/document.ts routeKey). */
	held: string[];
	/** What they hold between them, in bytes. */
	bytes: number;
	/** Saves that failed in this worker's life, and kept nothing. */
	failures: number;
}

export interface OkMessage {
	type: 'ok';
	id: number;
	svg: string;
	log: string[];
	/** Bundled-file misses. Mostly benign probes; the diagnostic value is on the failure path. */
	missing: string[];
	durationMs: number;
	timings?: RenderTimings | undefined;
	/** Absent from a worker before 0.2.1-beta.3, which saves nothing. */
	snapshots?: SnapshotState | undefined;
	/** What became of a run the host sent with the render (StoredOutcome); absent when it sent none. */
	stored?: StoredOutcome | undefined;
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
	/** The `l.NN` line TeX blamed: a line of the whole input file. See `bodyLine`. */
	line?: number | undefined;
	/** See ErrorMessage.bodyLine. */
	bodyLine?: number | undefined;
}

export interface ErrorMessage {
	type: 'error';
	id: number;
	kind: TexErrorKind;
	message: string;
	/** The first `! ...` line, when there is one. */
	firstError?: string | undefined;
	/** The `l.NN` line number TeX blamed, when it gave one: a line of the whole input file. */
	line?: number | undefined;
	/**
	 * The line of TeX's input file on which the block's own first line sits.
	 *
	 * TeX's `l.NN` counts the assembled input — `\nonstopmode`, packages, libraries and every
	 * preamble file first — so the block's own line is `line - bodyLine + 1`, and a `line` below
	 * `bodyLine` is in the preamble rather than in the block. It is 2 only when the preamble is one
	 * line; each line a preamble file adds moves it down by one. Absent when TeX never ran: a
	 * worker that failed to boot, a ping.
	 */
	bodyLine?: number | undefined;
	log: string[];
	missing: string[];
	durationMs: number;
	/** Absent when TeX never ran: a worker that failed to boot, a ping. */
	timings?: RenderTimings | undefined;
	/** As OkMessage's. */
	snapshots?: SnapshotState | undefined;
	/** As OkMessage's. */
	stored?: StoredOutcome | undefined;
}

/**
 * What became of a run the host sent with a render: the render started from it; the worker held a
 * run for it already; its bytes did not read back as a run of this engine's (./stored-run), which the
 * host then deletes; it stands for text this diagram does not start with, under the same name; or
 * putting it back failed for want of something other than good bytes, memory above all, as inflating
 * 8.9 MiB can on a phone, which the host keeps and does not send again that session.
 */
export type StoredOutcome = 'used' | 'unneeded' | 'corrupt' | 'mismatch' | 'failed';

export type WorkerResponse = ReadyMessage | LogMessage | OkMessage | ErrorMessage | SavedRunMessage;

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
