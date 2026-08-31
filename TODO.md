# TODO — TikZJax modernization

Working checklist. Ordered by dependency, not by importance — the sequence is not
interchangeable even though everything ships in one delivery (`docs/DECISIONS.md` D2).

- **What** — `docs/DESIGN.md` (full architecture, every claim evidence-backed)
- **Why / which issues** — `docs/BACKLOG.md` (all 114 upstream issues triaged, each appearing exactly once)
- **What changed since** — `docs/DECISIONS.md` (**supersedes DESIGN.md where they disagree**)

Issue numbers refer to `artisticat1/obsidian-tikzjax`.

---

## 0 · Correctness floor

Small, independent fixes to today's code. No architecture. Each is a one-liner or close, and each
is a real bug users hit now.

- [ ] `doc.createElement`, not `document.createElement` (main.ts:45) — the pop-out/export bug
- [ ] `textContent`, not `innerText`, for the 7 MB engine string (main.ts:48)
- [ ] `s?.remove()` (main.ts:57) — `onunload` currently throws, so syntax highlighting is never torn down
- [ ] Move the `tikzjax-load-finished` listener from `document` to `el` (main.ts:52) — **closes #102 #93 #87**
- [ ] Guard `window.CodeMirror?.modeInfo` (main.ts:109) and `floatingSplit?.children` (main.ts:84) — **closes #74**
- [ ] Splice `modeInfo` in place instead of reassigning the array (main.ts:114) — reassigning breaks other plugins
- [ ] Empty-source guard — an empty ` ```tikz ` fence currently wedges the session
- [ ] SVGO overrides `removeViewBox: false`, `cleanupNumericValues: {convertToPx: false}` — live geometry regressions (#12 #42 #50 #66)
- [ ] Handle SVGO's `{error}` return shape instead of `@ts-ignore`ing `.data` — it can write the literal string `"undefined"` into a note
- [ ] Minimal SVG sanitizer before insertion — `special{dvisvgm:raw …}` passes author markup through verbatim (see §7.2 defect 17). **No upstream issue; found in recon.**
- [ ] `@media print { break-inside: avoid }` + unscope the `.block-language-tikz svg` rule

## 1 · Toolchain

- [ ] `typescript@7.0.2` for `tsc --noEmit`; `oxlint@1.80` for the dev loop; `eslint@10` + `typescript-eslint@8` + `eslint-plugin-obsidianmd@0.4.2` with a `typescript@5.9.3` npm `override` for the store-rules gate (D5)
- [ ] `tsconfig.json` per §9.2 — `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `types: []`, no `allowJs` (it drags 587 KB of minified SVGO into every build)
- [ ] `esbuild@0.28.2`: `context()` + `watch()` (the current config uses the `watch` option removed in 0.17), `with { type: 'text' }` replacing the unmaintained `esbuild-plugin-inline-import`, `minify` in prod (there is no `minify` key at all today — 281 KB)
- [ ] Externals: `obsidian`, `electron`, the **8** real `@codemirror/*` (13 of the 21 listed no longer exist), `@lezer/*`, node builtins
- [ ] Drop `pako`, `@types/pako` (declared, never imported), `tslib`, `builtin-modules`, `esbuild-plugin-inline-import`; pin `obsidian@1.13.1` instead of `"latest"`
- [ ] Regenerate `package-lock.json` — it is lockfileVersion 2 stamped `0.3.0` and **missing `localforage`**, so `npm ci` fails today
- [ ] `versions.json` + truthful `minAppVersion: "1.13.0"` (D6) — currently `{"0.1.0":"0.12.0"}` against a manifest saying 0.5.2
- [ ] New `manifest.json` id / name / author (D1) + coexistence guard against the old plugin
- [ ] Vitest 4 + a ~40-line `obsidian` stub; `happy-dom` per-file only
- [ ] CI: lint · typecheck · test · golden · build · `engine-guard` (sha256) · `patch-guard` (each patch matches exactly once) · `size-guard` · `version-guard`
- [ ] Release workflow on `actions/checkout@v7` — the current one uses archived actions and `::set-output`, which is why the zip uploads as `obsidian-tikzjax-.zip`
- [ ] `NOTICE` + `vendor/LICENSES/` + README licence section (§9.7 — **open decision**, see DECISIONS.md)
- [ ] Dev loop: `OBSIDIAN_PLUGIN_DIR=… npm run dev` + `.hotreload`, documented in CONTRIBUTING

## 2 · Engine — own the worker

Straight to `WorkerHost`; no `LegacyScriptHost` (D2).

- [ ] `scripts/extract-worker.mjs` — pull webpack module 147 out of `vendor/tikzjax.txt` (declared at byte 13), assert one match, assert `texify:async function`
- [ ] `scripts/patch-worker.mjs` — every patch asserts **exactly one** match or fails the build:
  - [ ] **P0** `//invalid.site/img-not-found.png` → `data:,tikzjax-error` — removes an outbound DNS+HTTP request on every failed render, from an offline-first plugin
  - [ ] **P1** `.set(ye.slice(0))` → `.set(ye)` — −68.75 MiB transient per render
  - [ ] **P2** hoist `WebAssembly.compile` — stops recompiling 517 KB of wasm every render
  - [ ] **P2b** hoist and reuse `WebAssembly.Memory` — safe because the core dump is exactly 1100 × 65536 B, i.e. the *entire* non-growable memory
  - [ ] **P3** `mq()` in a `finally` — stops the poisoned-VFS cascade after a failure
  - [ ] **P4** replace the file loader's empty `catch {}` with a `!TIKZJAX-MISSING-FILE` message
- [ ] `engine/rpc.ts` — threads.js wire protocol, ~120 lines. **TeX stdout arrives as bare-string `postMessage`, not a protocol frame** — branch on `typeof e.data === 'string'` *before* the frame switch or log capture silently sees nothing
- [ ] `WorkerHost`: Blob worker, `URL.revokeObjectURL` (never done today), `Promise.race` timeout → `terminate()` + respawn, per-job log ring buffer
- [ ] `\nonstopmode` injection — the engine feeds TeX a fixed terminal string with no batch mode, so an error reaches the interactive `? ` prompt and suspends the asyncify'd wasm forever. **This is the root of #18 #23 #27 #39 #51 #82 #85 #89** (~22 reporters)
- [ ] `gen-inventory.mjs` → `engine/inventory.ts` (212 bundled files, package versions, capabilities) — drives the README table, the pre-flight lint and the error-card hints
- [ ] Delete `loadTikZJax` / `unloadTikZJax` / `loadTikZJaxAllWindows` / `getAllWindows` and the `window-open` handler

## 3 · Block lifecycle

- [ ] `TikzBlock extends MarkdownRenderChild` + `ctx.addChild` — **closes #98**
- [ ] `block/machine.ts` — pure `(state, event) => [state, Effect[]]`. **Invariant: exactly one `settle()` per block**, property-tested under randomised fault injection
- [ ] Async processor returning an awaited promise that **never rejects** (a rejection strands `asyncSections` forever in reading mode and throws out of `printToPdf`)
- [ ] Cache L1 (Map + LRU) / L2 (IndexedDB `obsidian-tikzjax-<appId>` — **must** carry appId, or every vault on the machine shares one store) / **L3 legacy read-through** (D1: read, never delete)
- [ ] `cache/key.ts` — sha256, synchronous (not `crypto.subtle`: the L1 probe must be sync). `artifactRevision()` narrow and enumerated, with two tests asserting **insensitivity to theme and scale**
- [ ] `cache/legacy-key.ts` — frozen `md5(JSON.stringify({showConsole:'true'}) + legacyTidy(src))`. Never edited
- [ ] Render queue: priority bands, dedup by key with refcounting, depth cap → manual demotion, session poison set, **every job settles in a `finally`**
- [ ] Viewport gate (one `IntersectionObserver` per scroll root) **+ the 2 s zero-record escape hatch** — without it a block in a collapsed callout or a hidden tab sits with a permanent placeholder forever
- [ ] Debounce; pre-start cancellation on unload. Mid-flight termination only on timeout / plugin unload / backpressure (**explicitly narrower than the brief** — see DESIGN.md §1.2)
- [ ] Export detection from `el.doc` + per-block (30 s) and **total (60 s)** export budgets — `Promise.all(ctx.promises)` has no timeout of its own, so 40 uncached blocks would be a 20-minute uncancellable modal. **Closes #45 #114 #101 #109**
- [ ] Per-mount id stamping (`__TZ__n` → `t<N>_`, replacement computed **once** before the call) — **closes #12**
- [ ] Sized placeholders from the persisted bbox — no layout shift
- [ ] Pre-flight source lint (§7.6's six rules) — **closes #52 #49 #67, partial #96**
- [ ] Debug view + desktop-only status bar; Safari Web Inspector workflow in CONTRIBUTING

## 4 · Colour, geometry, SVG pipeline

- [ ] **Delete `colorSVGinDarkMode`** (main.ts:137-146) entirely
- [ ] Ink/paper DOM pass over **all four emitters** — including `style="color: black"` on HTML spans, which today's quoted-string regex cannot match at all
- [ ] CSS custom properties `--tikz-ink` / `--tikz-paper`, `.tz-paper-*` classes; **never write `var()` into a presentation attribute** (outside Obsidian it falls back to black, not white)
- [ ] `@media print` **and** `.print` both pinned — Obsidian's export re-copies the main body's class mid-flight, which is why "switch to light mode first" works for three reporters on #45
- [ ] Gradient stops left alone by default — **closes #73**
- [ ] Modes `adapt | preserve | paper | invert` — **closes #38 #103 #15 #48**
- [ ] Mount-time `await document.fonts.ready` → `getBBox()` → corrected viewBox, persisted. **Do not persist a bbox measured before the faces resolve** — it is an output, not a key input, so nothing would ever invalidate it. **Closes #66 #71 #29**
- [ ] Width / align / scale on the **wrapper**, never on the `<svg>` — **closes #14 #26 #42**
- [ ] SVGO modes `preset | targeted | off`; `targeted` stays opt-in until #6 is reproduced on a real device
- [ ] Mandatory non-skippable `sanitize` stage; `MOUNTED(degraded)` + a warning chip instead of any silent fallthrough
- [ ] No `String.prototype` methods on the hot path — Pretty BibTeX 2.0.0 monkey-patched `replaceAll` and silently killed both inversion and SVGO (#48)
- [ ] Fast mode as a defined preset: `svgo: off` + skip measure + skip lint + priority boost; **never** skips sanitize or ids

## 5 · Errors

- [ ] Structural classification — failed iff `texify` rejected or no `Output written on input.dvi`. **`input.log` is never written by this engine** (grep: 0); stdout is the only channel
- [ ] `Overfull \hbox` must **never** produce an error card
- [ ] Error card: message, offending line with a caret, capability-driven hint, collapsible log, Copy log / Retry / Docs. **Closes #81 #100**
- [ ] Session-only poison set; never persisted

## 6 · Mobile

- [ ] `styles.css` split: 12 core faces stay (~200 KB), the other 128 become a cold string injected per-`Document` **on first mount, not first render** (a cache hit and an export popup mount without rendering)
- [ ] One Blob materialisation of the 7 MB worker instead of four
- [ ] Teardown on `visibilitychange → hidden`; concurrency hard-clamped to 1 on mobile
- [ ] TTF → WOFF2. **Closes #111 #91 #7 #24 #3**

## 7 · Preamble, options, export

- [ ] `%!tikz` body directives — **not** fence-info-string options: `ctx.getSectionInfo()` returns `null` in PDF export, embeds and hover, so a fence tail would give the same block two different cache keys and hand the PDF a differently-compiled diagram
- [ ] Global preamble + walk-up `tikz-preamble.tex` + `%:input` with linkpath resolution, recursion, cycle detection, and a **visible** error on a missing file. **Closes #46 #76 #77 #83**
- [ ] Dependency tracking → `vault.on('modify')` invalidation
- [ ] Declarative settings (`getSettingDefinitions`); `declare settings` with `useDefineForClassFields` care
- [ ] `freezeSvg` — resolve `currentColor`, inline **only** the referenced `@font-face` subset (~12 of 140)
- [ ] Copy SVG / Save SVG / Finalize / Un-finalize; render-note / render-vault; zoom modal. **Closes #21 #33 #95 #97 #104 #37 #47**

## 8 · pgfplots

- [ ] **S1** — add the missing `tikzlibrarypgfplots.*.code.tex` files to `tex_files`. pgfplots **1.16 is already bundled** (30 files); only the `\usepgfplotslibrary` files are absent. That is the whole of **#28 #79**, and it needs no WASM work
- [ ] Extended-engine loader: pinned URL + pinned SHA-256 + `vault.adapter.writeBinary` to `.obsidian/plugins/<id>/engines/`, fall back to core on any failure (D3)
- [ ] Evaluate `@rod2ik/tikzjax` 1.6.0 against the golden corpus. It brings pgfplots 1.18.2, `arrows.meta`, `mathtools`, `mhchem`, `physics`, AMS symbol fonts, `yquant` — and **`expl3.sty`**, which if it actually runs would reopen ~37 issues currently marked permanently unfixable. Hazards: its `texify` wraps `\begin{document}` itself; its device-memory cap is `NaN → Infinity` on WebKit, i.e. **no cap on iOS**; 156 MiB per render. **Desktop-only until measured**
- [ ] **E1** — containerised web2js rebuild carrying pgf 3.1.12 + pgfplots 1.18.3 (released 2026-08-26). Long-term; unblocks the whole `needs-tex-rebuild` partition

## 9 · Release gate

The manual matrix in DESIGN.md §10.4, in full. The three that catch the most:

- [ ] **iOS**: enable → open Settings (the #111 crash path, which happens *before* anything renders) → 20-diagram note → scroll → background → foreground → export
- [ ] **A vault with a pre-existing legacy cache**: upgrade, open a note, assert **zero** TeX compiles
- [ ] **Devtools Network tab** across a full session including a failing diagram: assert zero requests

---

## Not doing, and why

Full reasoning in `docs/BACKLOG.md`. The short version:

- **~37 issues need a rebuilt TeX bundle** — expl3-dependent packages (siunitx v3 #30, forest #86, modern chemfig), the `patterns` driver gap (#59), chemfig `\schemestart` (#25 #54 — the bonds are already missing *in the DVI*, verified by a contributor in TeXShop), new fonts and encodings (#55 #113 #36 #53), CJK (#19 — impossible on an 8-bit engine), LuaTeX-only packages (#20). Provisional pending the rod2ik expl3 check (D3).
- **13 issues close as answered or out of scope** — including Obsidian Publish (#37 #47: Publish runs no community plugins; Finalize-to-attachment is the answer and is better for visitors than 7 MB of WASM per page view) and the inline `$tikz:…$` renderer (#112).
