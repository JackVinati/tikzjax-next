# TODO — TikZJax modernization

Working checklist. Ordered by dependency, not by importance.

Everything through §8 shipped in 0.1.0 unless it says otherwise below. What is left is §9 — the
release gate, which is testing on real devices rather than writing code — plus the handful of items
marked **open** in place. A few items are marked **superseded**: they solved a problem a later
decision removed, and are kept so the sequence still reads.

- **What** — `internal/DESIGN.md` (full architecture, every claim evidence-backed)
- **Why / which issues** — `internal/BACKLOG.md` (all 114 upstream issues triaged, each appearing exactly once)
- **What changed since** — `internal/DECISIONS.md` (**supersedes DESIGN.md where they disagree**)

Issue numbers refer to `artisticat1/obsidian-tikzjax`.

---

## 0 · Correctness floor

Small, independent fixes to the code as it was. The rewrite removed the file every one of them
pointed at; each is listed as done because the behaviour is now correct, not because the line was
edited.

- [x] `doc.createElement`, not `document.createElement` — the pop-out/export bug
- [x] `textContent`, not `innerText`, for the engine string
- [x] `s?.remove()` — `onunload` used to throw, so syntax highlighting was never torn down
- [x] The `tikzjax-load-finished` listener on the element rather than `document` — **closes #102 #93 #87**
- [x] Guard `window.CodeMirror?.modeInfo` and `floatingSplit?.children` — **closes #74**
- [x] Splice `modeInfo` in place instead of reassigning the array — reassigning breaks other plugins
- [x] Empty-source guard — an empty ` ```tikz ` fence used to wedge the session
- [x] SVGO overrides `removeViewBox: false`, `cleanupNumericValues: {convertToPx: false}` — live geometry regressions (#12 #42 #50 #66)
- [x] Handle SVGO's `{error}` return shape instead of `@ts-ignore`ing `.data` — it can write the literal string `"undefined"` into a note
- [x] Minimal SVG sanitizer before insertion — `special{dvisvgm:raw …}` passes author markup through verbatim (§7.2 defect 17). **No upstream issue; found in recon.**
- [x] `@media print { break-inside: avoid }` + unscope the `.block-language-tikz svg` rule

## 1 · Toolchain

- [x] `typescript@7.0.2` for `tsc --noEmit`; `oxlint@1.80` for the dev loop; `eslint@10` + `typescript-eslint@8` + `eslint-plugin-obsidianmd@0.4.2` with a `typescript@5.9.3` npm `override` for the store-rules gate (D5)
- [x] `tsconfig.json` per §9.2 — `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `types: []`, no `allowJs`
- [x] `esbuild@0.28.2`: `context()` + `watch()`, `with { type: 'text' }`, `minify` in prod
- [x] Externals: `obsidian`, `electron`, the **8** real `@codemirror/*`, `@lezer/*`, node builtins
- [x] Drop `tslib`, `builtin-modules`, `esbuild-plugin-inline-import`; pin `obsidian@1.13.1` instead of `"latest"`
- [x] Regenerate `package-lock.json` — the old one was lockfileVersion 2 stamped `0.3.0` and missing `localforage`, so `npm ci` failed
- [x] `versions.json` + truthful `minAppVersion: "1.7.2"` — derived from the API surface, after 1.13.0 turned out to lock every iPhone out (D6)
- [x] New `manifest.json` id / name / author (D1) + coexistence guard against the old plugin
- [x] Vitest 4 + an `obsidian` stub; `happy-dom` per-file only
- [x] CI: lint · store rules · format · typecheck · test · no-network guard · manifest/versions guard; engine build, fixtures, fork and worker verification on its own workflow
- [x] Release workflow that checks the tag against the manifest before it builds anything
- [x] `NOTICE` + `vendor/LICENSES/` + README licence section — GPL-3.0-or-later (D9)
- [x] Dev loop: `OBSIDIAN_PLUGIN_DIR=… npm run dev` + `.hotreload`, documented in the README

## 2 · Engine — own the worker

Straight to `WorkerHost`; no `LegacyScriptHost` (D2).

- **Superseded by D10.** The plan was to extract webpack module 147 out of the vendored
  `tikzjax.txt` and patch the extracted string. D10 replaced all of it: the engine is now built
  from pinned upstream sources in a container (`engine-build/`) and the worker is our own
  TypeScript (`engine-src/worker.ts`), so there is no blob to cut open and no patch to keep
  matching. Every fix the patches were for is in the fork, and `npm run verify:fork` proved the
  fork renders identically to upstream where it did not mean to differ. Since 0.2.0 upstream's
  host cannot run our engine, and `npm run verify:golden` holds every fixture to the output
  recorded from the last engine it could (D13).
  - [x] **P0** no `//invalid.site/img-not-found.png` — an outbound request on every failed render, from an offline-first plugin
  - [x] **P1** no `.set(ye.slice(0))` — −68.75 MiB transient per render
  - [x] **P2** `WebAssembly.compile` hoisted — no recompiling the wasm every render
  - [x] **P2b** `WebAssembly.Memory` reused — safe because the core dump is exactly the whole non-growable memory
  - [x] **P3** teardown in a `finally` — no poisoned-VFS cascade after a failure
  - [x] **P4** a missing file is reported, not swallowed by an empty `catch {}`
- [x] `engine-src/protocol.ts` — a tagged message protocol, and TeX stdout arrives on it rather than as bare strings
- [x] `WorkerHost`: Blob worker, `URL.revokeObjectURL`, timeout → `terminate()` + respawn, per-job log ring buffer
- [x] `\nonstopmode` injection — TeX used to reach the interactive `? ` prompt and suspend the asyncify'd wasm forever. **Root of #18 #23 #27 #39 #51 #82 #85 #89** (~22 reporters)
- [x] Generated inventory (bundled files, package versions, capabilities) — drives the settings table, the pre-flight lint and the error-card hints
- [x] Delete `loadTikZJax` / `unloadTikZJax` / `loadTikZJaxAllWindows` / `getAllWindows` and the `window-open` handler
- [x] No asyncify (0.2.0): the engine is optimised with `wasm-opt --mvp-features -O4` instead of upstream's asyncify step, 42% less TeX time over the fixtures in Node, and the same `core.dump` byte for byte (D14). TeX's jump out of every procedure on a fatal error is a call to `library.jumpOut`, which ends the run
- [x] WebAssembly 1.0 only (0.2.0): `--mvp-features` in the build, and `scripts/wasm-mvp.mjs` decodes the committed engine in the tests and the freshly built one in the Engine workflow (D14)
- [x] TeX's hash table (0.2.0): `hash_prime` 131,071 instead of tex.web's 1,777 in a table web2js sized for 600,000 names, so finding a macro visits 2.0 slots instead of 11.3; 1–3% less TeX time on the largest fixtures, the dump's archive 55 KB larger (D15)
- [x] `\ifincsname` (0.2.0): change files of ours in `engine-build/changes`, applied after web2js's, and the first gives the engine pdfTeX's primitive. `~` is a non-breaking space instead of three errors and a stray tilde, and LaTeX's `utf8.def` no longer falls back to `utf8-2018.def` (`test/fixtures/tex/tilde.tex`, D16)
- [x] `\filesize` of a missing file is empty (0.2.0), as in pdfTeX: both hosts' `getfilesize` answer -1 for a file they do not have, and the second change file has `\filesize` print nothing for it. LaTeX's `\IfFileExists` stops finding every file, so a missing package is reported with "File `x.sty' not found" instead of being read as empty (`filesize.tex`, `missing-package.tex`, D16). Needed before TeX Live 2026 (E1)
- [x] A missing package is an error LaTeX goes on from (0.2.0): the worker answers LaTeX's question for another name as Return does, so a diagram that loads a package it never uses, `inputenc` or `amsthm` say, draws as in 0.1.5, with LaTeX's message on it, where the engine of D16 ended in an emergency stop (`missing-package.tex`, D19)
- [x] A fatal error closes TeX's files (0.2.0): `jump_out` calls `close_files_and_terminate` before the jump, as `tex.web` §81 asks of a compiler without one and web2c's TeX does, so a page shipped before the error is drawn and the transcript ends as TeX ends it (`engine-build/changes/jump-out.ch`, `fatal-after-page.tex`, D17)
- [ ] **open** — a block with CRLF line endings reaches TeX with its CRs. The `expl3` fixture comes out 3.33 pt wider from a CRLF checkout than from an LF one, and an error's context shows a `^^M`. `npm run verify:golden` reads the fixtures with LF for that reason (D13); whether the worker should do the same for a note saved with CRLF is open, and wants a look at what Obsidian hands the processor on Windows first
- [ ] **open** — binaryen 132's -O4 measured 4% less TeX time than web2js's binaryen 99 on the same `out.wasm` (D14). It means installing a pinned binaryen in the engine image

## 3 · Block lifecycle

- [x] `TikzBlock extends MarkdownRenderChild` + `ctx.addChild` — **closes #98**
- [x] `block/machine.ts` — pure `(state, event) => [state, Effect[]]`. **Invariant: exactly one `settle()` per block**, property-tested under randomised fault injection
- [x] Async processor returning an awaited promise that **never rejects**
- [x] Cache L1 (Map + LRU) / L2 (IndexedDB, keyed per `appId`) / **L3 legacy read-through** (D1: read, never delete)
- [x] `cache/key.ts` — sha256, synchronous. `artifactRevision()` narrow and enumerated, with tests asserting **insensitivity to theme and scale**
- [x] `cache/legacy-key.ts` — frozen `md5(JSON.stringify({showConsole:'true'}) + legacyTidy(src))`. Never edited
- [x] Render queue: priority bands, dedup by key with refcounting, depth cap → manual demotion, session poison set, **every job settles in a `finally`**
- [x] Viewport gate (one `IntersectionObserver` per scroll root) **+ the 2 s zero-record escape hatch**
- [x] Debounce; pre-start cancellation on unload. Mid-flight termination only on timeout / plugin unload / backpressure
- [x] The debounce only for a block of a note being typed in (0.2.1): any other block is queued as soon as the viewport gate lets it through. A note is being typed in for a second after any editor changes its text, as `editor-change` reports it (`src/block/edits.ts`, D22)
- [x] Export detection from `el.doc` + per-block export budget — **closes #45 #114 #101 #109**
- [x] The TOTAL export budget, for real this time (0.1.5). It was ticked in 0.1.0 for code that did not exist — `exportTotalBudgetMs` was read nowhere. Now each `.print` container gets one deadline and its blocks an `expired` event that ends on a "not ready in time for the export" card; export blocks are exempt from the depth cap, so the PDF never prints a "Render diagram" button
- [x] One worker, one job in it (0.1.5): the host queues the rest, a job's clock starts when the worker takes it, a timeout takes down only its own worker, and an interruption (backgrounding, Restart, unload) puts the block back in line instead of showing a card. Desktop concurrency is 1 like mobile; the `concurrency` setting is retired
- [x] Pop-out windows are not exports (0.1.5): `isExportContext` used to call every document but the main one an export
- [x] Per-mount id stamping — **closes #12**
- [x] Sized placeholders from the persisted bbox — no layout shift
- [x] Pre-flight source lint (§7.6's six rules) — **closes #52 #49 #67, partial #96**
- [x] Debug view; Safari Web Inspector workflow documented in the README
- [x] Where each compiled diagram's time went, in the debug view (0.2.0): the queue, the engine's start if it waited for it, the memory reset, TeX, DVI to SVG and the SVG pipeline
- [ ] **open** — desktop-only status bar item. The debug view covers what it was for; this is convenience

## 4 · Colour, geometry, SVG pipeline

- [x] **Delete `colorSVGinDarkMode`** entirely
- [x] Ink/paper DOM pass over **all four emitters** — including `style="color: black"` on HTML spans, which the old quoted-string regex could not match at all
- [x] CSS custom properties `--tikz-ink` / `--tikz-paper`, `.tz-paper-*` classes; **never `var()` in a presentation attribute**
- [x] `@media print` **and** `.print` both pinned
- [x] Gradient stops left alone by default — **closes #73**
- [x] Modes `adapt | preserve | paper | invert` — **closes #38 #103 #15 #48**
- [x] Mount-time `await document.fonts.ready` → `getBBox()` → corrected viewBox, persisted — **closes #66 #71 #29**
- [x] Width / align / scale on the **wrapper**, never on the `<svg>` — **closes #14 #26 #42**
- [x] SVGO modes `preset | targeted | off`; `targeted` stays opt-in until #6 is reproduced on a real device. Until 0.1.5 the mode reached the cache key and nothing else, so `svgo=off` changed nothing; it reaches the pipeline now
- [x] Mandatory non-skippable `sanitize` stage; `MOUNTED(degraded)` + a warning chip instead of any silent fallthrough. Since 0.1.5 an allowlist of what the engine emits, its removals shown in a chip, and a document that never passed it is an error card rather than a "degraded" mount of the raw output
- [x] One stored artifact for every colour mode (0.1.5); the mode is only CSS, so `colors=` on one copy of a diagram no longer decides what the others get
- [x] `scale=` and `width=` enlarge as well as shrink (0.1.5): the svg fills a wrapper the block sized, and the scale is in points
- [x] No `String.prototype` methods on the hot path — Pretty BibTeX 2.0.0 monkey-patched `replaceAll` and silently killed both inversion and SVGO (#48). Enforced by a lint rule
- [x] Fast mode as a defined preset: `svgo: off` + skip lint + priority boost; **never** skips sanitize or ids. It does not skip the measurement after all — the engine's frame is an inch short, so a fast diagram would be clipped — and the priority boost was only implemented in 0.1.5

## 5 · Errors

- [x] Structural classification — failed iff `texify` rejected or no `Output written on input.dvi`
- [x] `Overfull \hbox` never produces an error card
- [x] Error card: message, offending line with a caret, capability-driven hint, collapsible log, Copy log / Retry / Docs — **closes #81 #100**. Since 0.1.5 the line is right behind a preamble of several lines, and a line in a preamble file is shown from that file
- [x] Session-only poison set; never persisted
- [x] A fatal error fails at once (0.2.0). "TeX capacity exceeded", an emergency stop and a hundredth error all end in TeX's `jump_out`, which the engine made with asyncify; the run then never ended, and the diagram waited for its timeout. Now the run ends there and the card shows TeX's message (`test/fixtures/tex/runaway-macro.tex`, D14)
- [x] TeX's message on the card for every way it gives up (0.2.0): an `\input` of a missing file, a missing pgfplots library, capacity, `\batchmode` with a hundred errors, whose messages are only in TeX's transcript file and are read from there, and a page shipped before the stop, which is drawn. Each is a fixture whose reply `verify:worker` checks, and after each the same worker has to draw `basic` as before (D17)
- [x] A run nested deeper than the engine's stack, which runs out before any limit of TeX's own, is a capacity error instead of "TeX produced no output" (0.2.0, `verify:worker`, D17). TeX says nothing about it, and a page shipped before it is lost; how deep the stack goes on an iPhone is not measured

## 6 · Mobile

- [x] `styles.css` split: 12 core faces stay (191 KB), the other 140 become a cold string injected per-`Document` **on first mount, not first render**
- [x] One Blob materialisation of the worker instead of four
- [x] Teardown on `visibilitychange → hidden`; concurrency hard-clamped to 1 on mobile (and since 0.1.5 everywhere). A diagram compiling at that moment is interrupted, not failed, and finishes when the app comes back
- [x] Half the boot peak (0.1.5): the core dump inflates into one buffer, 313 → 156 MiB of ArrayBuffers right after inflating (Node 22, V8)
- [x] Only the core dump's non-zero runs (0.2.0): the build ships the 22.3 MiB of the 156.25 MiB dump that is not zero, the worker inflates only that at boot, and writes only that into each run's new Memory, which is zero already. Boot 529 → 161 ms, 157.5 → 23.5 MiB of ArrayBuffers held after it, the memory reset 24–26 → 4 ms a render in the shipped worker, 29 → 5 ms timed on its own (Node 22, V8, D18); not yet measured on a phone
- [x] TTF → WOFF2 — **closes #111 #91 #7 #24 #3**

## 7 · Preamble, options, export

- [x] `%!tikz` body directives — **not** fence-info-string options
- [x] Global preamble + walk-up `tikz-preamble.tex` + `%:input` with linkpath resolution, recursion, cycle detection, and a **visible** error on a missing file — **closes #46 #76 #77 #83**
- [x] Dependency tracking → `vault.on('modify')` invalidation
- [x] `freezeSvg` — resolve `currentColor`, inline **only** the referenced `@font-face` subset
- [x] Copy SVG / Save SVG / Finalize / Un-finalize; render-note; zoom modal — **closes #21 #33 #95 #97 #104 #37 #47**
- [ ] **not doing for now** — declarative settings (`getSettingDefinitions`). It is 1.13-only, and the floor is 1.7.2 so that the plugin installs on mobile at all (D6). Adopting it means carrying both paths; it buys settings-search discoverability on 1.13+ and costs everyone below it
- [ ] **open** — render-vault. render-note ships; a vault-wide pass needs a progress UI and a cancel path, and is the kind of thing that wants a device measurement first
- [ ] **planned, after 0.1.4** — `![[file.tex]]` renders the diagram in place (issue #1). Only `app.embedRegistry.registerExtension('tex', …)` reaches Live Preview, and it is undocumented: feature-detected, guarded against another plugin owning `tex`, falling back to today's grey box. The embed hands the file to the same path a block takes (refactor `createProcessor` into an exported `processSource`), with `sourcePath` = the .tex file so `%:input` resolves like LaTeX's `\input`, and a small adapter that comments out `\documentclass` — today pre-flight warns about a second one, and LaTeX reports it as an error and goes on; it never hung on the engine built from source, measured on 0.1.5's and 0.2.0's. Waiting on the reporter: full documents or bare `tikzpicture`s?
- [x] A preamble change re-renders Live Preview as well as Reading view (0.1.5), through `post-processor-change`, which both rebuild on. Verified against the 1.14.4 bundle, not yet on a 1.7.2 install
- [x] `keysBySource` is gone (0.1.5): the commands derive the key with the processor's own code from the scanned text, so they also find a diagram after a restart, in Source mode, and for a block never processed this session
- [x] Settings tab section for the preamble files (0.1.5), with file suggestions; settings apply without a restart, Sync included
- [x] The commands at the cursor find a diagram in a list item in Live Preview (0.1.5). Live Preview hands the processor the lines between the fences as they stand, with the list's indentation, and Reading view hands it the code block's content without; the processor now takes the indentation off when getSectionInfo shows it was handed the note's own lines, by as much as Reading view takes, so the block has one key in both views and is compiled once. Copy SVG, Save SVG and the zoom view also find a diagram in a blockquote, a callout, or on its list item's marker line (`1. ```tikz`); Finalize leaves those three alone. What 1.14.4 hands the processor in each case was read from its own parser and is in `test/support/obsidian-blocks.ts`
- [ ] **open** — Finalize a block whose TeX has a `%%` in it. Obsidian's Reading view ends a `%%` comment at the next `%%` anywhere, not at a line of its own (`%%` tokenizer in the 1.14.4 bundle), so a finalized block with a `%% axes` line shows the TeX after it as text, and the fence's closing line opens a code block that takes in the closing `%%` and the rest of the note. Un-finalize still gives the source back. The fix is a choice: refuse to finalize such a block, or wrap it in something other than `%%`

## 8 · pgfplots

- [x] **S1** — the missing `tikzlibrarypgfplots.*.code.tex` files are bundled. That was the whole of **#28 #79**
- [ ] **open** — extended-engine loader: pinned URL + pinned SHA-256 + `vault.adapter.writeBinary` to `.obsidian/plugins/<id>/engines/`, fall back to core on any failure (D3). Not needed for anything that ships today; it is how a bigger TeX set would arrive without putting it in `main.js`
- [x] ~~Evaluate `@rod2ik/tikzjax` 1.6.0~~ — superseded by D10 and answered by it. The question that mattered was whether expl3 runs; it does, on our own build (`changes/expanded.ch`, `changes/strcmp.ch`), so forest, xparse, mathtools and siunitx compile. The ~37-issue "permanently impossible" partition was wrong, and `internal/BACKLOG.md` records the correction
- [ ] **open** — **E1**: ship the `net` TeX Live flavour instead of Ubuntu's 2023 packages. As of 2026-10: pgf 3.1.12, pgfplots 1.18.3, circuitikz 1.8.7, chemfig 1.82, siunitx 3.6.4 (we ship 3.1.10, 1.18.1, 1.6.6, 1.66, 3.3.10). Its own engine release, not a dependency bump: the `net` path has never actually been built, pgf 3.1.12 changes every bp→pt coordinate so every diagram's output moves, and tlnet changes daily — it has to be pinned to a dated snapshot (`texlive.info/tlnet-archive/YYYY/MM/DD`) to be reproducible. Validation: build both flavours, diff the fixture SVGs, read every difference. pgf 3.1.12 decides how to load a library with `\IfFileExists`, which needs a `\filesize` that is empty for a missing file; that is in 0.2.0 (D16)
- [x] ENGINE_ID covers what the worker bundles (0.1.5). It hashed the engine archives and every `engine-src/*.ts` but not the npm packages bundled into the worker, nor the contents of the TeX files. It is now the sha256 of the minified worker bundle with the id replaced by a placeholder (`scripts/engine-assets.mjs` `buildWorker`), so dvi2html, pako, buffer, the dvi2html patch and every TeX file's bytes are in it; `test/engine-id.test.ts`
- [x] Letters with a dieresis and the last character of every font (0.1.5): dvi2html's TFM reader stopped one short, patched in the bundler (`scripts/dvi2html-patch.mjs`, D11)
- [x] `°` `×` `→` `±` `µ`, siunitx's units and list bullets (0.1.5): TS1, which the converter cannot draw, so the worker redefines 23 TS1 text commands to math-font glyphs when a block can use them (`engine-src/ts1-shim.ts`)
- [x] `Ł` and `ł` (0.1.5): dvi2html's glyph map had no entry for 302 characters its fonts have metrics for, among them the stroke LaTeX builds them with (character 32 of the roman, bold, slanted, italic and sans text fonts) and `£` in the italics, and failed with "Cannot read properties of undefined (reading 'toString')". Patched in the bundler to fall back to the codepoint BaKoMa's faces put every character at (`scripts/dvi2html-patch.mjs`, D11); the upstream fix belongs in its `tools/glyphs.js` or `src/html.ts`, and goes in the same PR as the TFM fix
- [x] `£` `€` `©` `®` `ª` `º`, `\pounds`, `\copyright` and `\$` outside math (0.1.5): TS1 with no math stand-in, so the shim builds these seven commands from the Computer Modern text fonts, mostly as older LaTeX releases did: `£` and `$` are character 36 of cmu/cmti and cmr, `©` and `®` a letter in cmsy's large circle, `€` LaTeX's own `\tc@fake@euro`, `ª` `º` a raised underlined a and o, lowercase in small caps as TS1 sets them (`test/fixtures/tex/ts1-currency.tex`, `ts1-small-caps.tex`)
- [ ] **open** — the rest of TS1 still fails, `¥` `¢` `‰` `½` `№` and `\textcircled` among it; pre-flight warns about the typed ones. Real TS1 needs tcrm metrics in the converter and a cm-super face
- [ ] **open** — add the glyph map fix to the prepared dvi2html PR (the TFM fix) and send it, and retire `scripts/dvi2html-patch.mjs` once a release carries both; its exactly-one guards will fail the build to say so

## 9 · Release gate

The manual matrix in DESIGN.md §10.4, in full. The ones that catch the most:

- [x] **iOS: it loads and renders.** Confirmed on an iPhone, 2026-09-02, after minAppVersion came down to 1.7.2 (D6) — the store floor, not the code, was what had kept it off the device
- [ ] **iOS, the rest of the path**: open Settings (the #111 crash path, which happens *before* anything renders) → 20-diagram note → scroll → background → foreground → export
- [ ] **iOS, 0.2.0's numbers**: on the 20-diagram note, read the engine start and each diagram's steps from the diagnostics view, on 0.1.5 and on 0.2.0, so the changelog's desktop figures get phone figures beside them. Every number 0.2.0 claims so far was measured in V8
- [ ] **A vault with a pre-existing legacy cache**: upgrade, open a note, assert **zero** TeX compiles
- [ ] **Devtools Network tab** across a full session including a failing diagram: assert zero requests
- [ ] **Finalize a fence with no blank line above it**, then un-finalize: the embed must render as an embed, the `%%` must open a comment, and the note must come back byte for byte (the open question in `src/note/finalize.ts`)
- [ ] **Typing in a diagram, on a 1.7.2 install and on the current Obsidian** (0.2.1, D22): change a number in a diagram for a few seconds, in Live Preview with the same note in a second pane, and with a Reading view beside the editor. The diagnostics view must show one compile after each pause, not one per keystroke. And a note opened fresh must show `waited 0 ms`, or near it, on its diagrams
- [ ] **A diagram in a list item, on a 1.7.2 install**: open it in Live Preview, then in Reading view; the diagnostics view must show one compile and then the diagram coming from the cache, and Copy SVG with the cursor in it must work. The shared key rests on `getSectionInfo` framing Live Preview's code-block widget as it does in 1.14.4, the only version it was checked against

Submitted to the community plugin browser on 2026-09-01 through Obsidian's developer portal. The automated review runs on every version and pulls a failing one from search within a day, so each release is held to it: 0.1.3 passed with zero errors and a byte-for-byte reproducible `main.js`.

Open contributions: PR #2 (Unicode labels through an SVG bridge) — changes requested, see the review on the PR. To add to that review after 0.1.5: letters with a dieresis are native now and must not be bridged; the bridge has to skip both `isNativeUnicode()` (`src/source/native-unicode.ts`) and `isTs1Symbol()` (`engine-src/ts1-shim.ts`) code points; and the worker's input is assembled in `engine-src/document.ts` now, which is where a bridge would hook in.

---

## Not doing, and why

Full reasoning in `internal/BACKLOG.md`. The short version:

- **The `needs-tex-rebuild` partition is much smaller than it looked.** expl3 runs, so the packages
  that depend on it are not blocked. What is genuinely blocked is narrower and mostly one thing:
  `@drgrice1/dvi2html` has a fixed font table covering Computer Modern only, and it is not
  extensible from outside — which is `\mathfrak` and `\mathscr` (#55 #84). siunitx's unit symbols
  (#113) were the third, and render since 0.1.5, drawn from the math fonts instead. The `patterns` driver gap (#59) is a missing pattern definition in the DVI, chemfig's
  `\schemestart` (#25 #54) loses its bonds before any JavaScript runs, CJK (#19) is impossible on
  an 8-bit engine, and LuaTeX-only packages (#20) stay LuaTeX-only.
- **13 issues close as answered or out of scope** — including Obsidian Publish (#37 #47: Publish
  runs no community plugins; finalize-to-attachment is the answer, and is better for visitors than
  a WASM TeX per page view) and the inline `$tikz:…$` renderer (#112).
