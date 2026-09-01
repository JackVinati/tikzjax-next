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
- [x] `versions.json` + truthful `minAppVersion: "1.13.0"` (D6)
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
  matching. Every fix the patches were for is in the fork, and `npm run verify:fork` proves the
  fork renders identically to upstream where it did not mean to differ.
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
- [x] Export detection from `el.doc` + per-block and total export budgets — **closes #45 #114 #101 #109**
- [x] Per-mount id stamping — **closes #12**
- [x] Sized placeholders from the persisted bbox — no layout shift
- [x] Pre-flight source lint (§7.6's six rules) — **closes #52 #49 #67, partial #96**
- [x] Debug view; Safari Web Inspector workflow documented in the README
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
- [x] SVGO modes `preset | targeted | off`; `targeted` stays opt-in until #6 is reproduced on a real device
- [x] Mandatory non-skippable `sanitize` stage; `MOUNTED(degraded)` + a warning chip instead of any silent fallthrough
- [x] No `String.prototype` methods on the hot path — Pretty BibTeX 2.0.0 monkey-patched `replaceAll` and silently killed both inversion and SVGO (#48). Enforced by a lint rule
- [x] Fast mode as a defined preset: `svgo: off` + skip measure + skip lint + priority boost; **never** skips sanitize or ids

## 5 · Errors

- [x] Structural classification — failed iff `texify` rejected or no `Output written on input.dvi`
- [x] `Overfull \hbox` never produces an error card
- [x] Error card: message, offending line with a caret, capability-driven hint, collapsible log, Copy log / Retry / Docs — **closes #81 #100**
- [x] Session-only poison set; never persisted

## 6 · Mobile

- [x] `styles.css` split: 12 core faces stay (191 KB), the other 140 become a cold string injected per-`Document` **on first mount, not first render**
- [x] One Blob materialisation of the worker instead of four
- [x] Teardown on `visibilitychange → hidden`; concurrency hard-clamped to 1 on mobile
- [x] TTF → WOFF2 — **closes #111 #91 #7 #24 #3**

## 7 · Preamble, options, export

- [x] `%!tikz` body directives — **not** fence-info-string options
- [x] Global preamble + walk-up `tikz-preamble.tex` + `%:input` with linkpath resolution, recursion, cycle detection, and a **visible** error on a missing file — **closes #46 #76 #77 #83**
- [x] Dependency tracking → `vault.on('modify')` invalidation
- [x] `freezeSvg` — resolve `currentColor`, inline **only** the referenced `@font-face` subset
- [x] Copy SVG / Save SVG / Finalize / Un-finalize; render-note; zoom modal — **closes #21 #33 #95 #97 #104 #37 #47**
- [ ] **open** — declarative settings (`getSettingDefinitions`). A hand-written settings tab ships instead; the declarative API would make the settings searchable from Obsidian's own search
- [ ] **open** — render-vault. render-note ships; a vault-wide pass needs a progress UI and a cancel path, and is the kind of thing that wants a device measurement first

## 8 · pgfplots

- [x] **S1** — the missing `tikzlibrarypgfplots.*.code.tex` files are bundled. That was the whole of **#28 #79**
- [ ] **open** — extended-engine loader: pinned URL + pinned SHA-256 + `vault.adapter.writeBinary` to `.obsidian/plugins/<id>/engines/`, fall back to core on any failure (D3). Not needed for anything that ships today; it is how a bigger TeX set would arrive without putting it in `main.js`
- [x] ~~Evaluate `@rod2ik/tikzjax` 1.6.0~~ — superseded by D10 and answered by it. The question that mattered was whether expl3 runs; it does, on our own build (`changes/expanded.ch`, `changes/strcmp.ch`), so forest, xparse, mathtools and siunitx compile. The ~37-issue "permanently impossible" partition was wrong, and `internal/BACKLOG.md` records the correction
- [ ] **open** — **E1**: ship the `net` TeX Live flavour (pgf 3.1.12, pgfplots 1.18.3, circuitikz 1.8.6) instead of Ubuntu's 2023 packages. The Dockerfile builds it today (`TEXLIVE=net`); what is missing is a run of the fixture corpus against it, because a package bump is a rendering change and the corpus is what would show it

## 9 · Release gate

The manual matrix in DESIGN.md §10.4, in full. The three that catch the most:

- [ ] **iOS**: enable → open Settings (the #111 crash path, which happens *before* anything renders) → 20-diagram note → scroll → background → foreground → export
- [ ] **A vault with a pre-existing legacy cache**: upgrade, open a note, assert **zero** TeX compiles
- [ ] **Devtools Network tab** across a full session including a failing diagram: assert zero requests
- [ ] **Finalize a fence with no blank line above it**, then un-finalize: the embed must render as an embed, the `%%` must open a comment, and the note must come back byte for byte (the open question in `src/note/finalize.ts`)

Then: submit to `obsidianmd/obsidian-releases` for the community plugin browser.

---

## Not doing, and why

Full reasoning in `internal/BACKLOG.md`. The short version:

- **The `needs-tex-rebuild` partition is much smaller than it looked.** expl3 runs, so the packages
  that depend on it are not blocked. What is genuinely blocked is narrower and mostly one thing:
  `@drgrice1/dvi2html` has a fixed font table covering Computer Modern only, and it is not
  extensible from outside — which is `\mathfrak`, `\mathscr` and siunitx's unit symbols (#55 #84
  #113). The `patterns` driver gap (#59) is a missing pattern definition in the DVI, chemfig's
  `\schemestart` (#25 #54) loses its bonds before any JavaScript runs, CJK (#19) is impossible on
  an 8-bit engine, and LuaTeX-only packages (#20) stay LuaTeX-only.
- **13 issues close as answered or out of scope** — including Obsidian Publish (#37 #47: Publish
  runs no community plugins; finalize-to-attachment is the answer, and is better for visitors than
  a WASM TeX per page view) and the inline `$tikz:…$` renderer (#112).
