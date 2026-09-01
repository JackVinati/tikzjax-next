# obsidian-tikzjax — Modernization Design

**Status:** final architecture, merged from three competing proposals under three independent judge panels.
**Base:** the risk-first / incremental proposal (winner on 2 of 3 lenses), with mandated grafts from clean-rewrite (engine boundary, state-machine rigour, cache-key discipline) and user-first (API-correctness findings, UX contract).
**Stance:** we do **not** rebuild `tex.wasm` / `core.dump` to reach 1.0. We take ownership of everything above the WASM boundary — the driver, the queue, the cache, the SVG pipeline, the error surface — and treat the 7 MB vendored bundle as a versioned, checksummed, build-time-patched input.

Every byte offset, file:line and API below was verified against the checkout, the vendored bundle, `obsidian.d.ts`, or the decompiled Obsidian 1.13.7 renderer. Claims that could not be verified are marked as such.

---

## 1. Goals and non-goals

### 1.1 Goals — the definition of done

| # | Promise | Mechanism | Phase |
|---|---|---|---|
| G1 | A previously-rendered diagram paints with the note, in the same frame, with no layout shift. | L1 in-memory cache probed in the processor; persisted `{w,h}` sizes the placeholder. | 2 |
| G2 | A spinner never hangs. Every block reaches a terminal state within its budget. | Per-diagram timeout → `Worker.terminate()` → error card. | 4 |
| G3 | One bad diagram never affects another. | Per-job settlement in `finally`; a poisoned worker is destroyed, not reused; session poison set. | 2 (mitigate) / 4 (fix) |
| G4 | Failures are readable and actionable, never a broken-image icon. | We own the log stream and the failure path. | 4 |
| G5 | Colours are correct in light, dark, print and export — including a deliberate `\fill[white]` — with zero recompiles on theme change. | Theme-neutral cached artifact + CSS custom properties. | 3 |
| G6 | Export to PDF contains every diagram, every time. | Async awaited processor + per-document engine + laziness bypass + total export budget. | 2 |
| G7 | Diagrams are framed correctly and sized how the user wants. | Mount-time `getBBox()` ink-bounds correction, persisted; wrapper-level width/align/scale. | 3 |
| G8 | Two copies of a diagram never corrupt each other. | ID placeholders in the artifact; per-mount nonce stamped at insertion. | 2 |
| G9 | Typing inside a diagram does not melt the laptop. | Debounce + cancel-before-start; unchanged blocks never recompile. | 2 |
| G10 | The plugin does not crash iOS. | 4.79 MB CSSOM parse removed at launch; copy count reduced; concurrency 1; idle teardown; worker memory patches. | 1 / 5 |
| G11 | Upgrading does not recompile anyone's vault. | L3 read-through of the existing `TikzJax/svgImages` store. | 2 |
| G12 | The plugin is debuggable by someone who is not the author. | Debug panel, per-render timings, TeX log capture, documented iOS Web Inspector workflow. | 2 / 4 |

### 1.2 Non-goals — what we are explicitly not doing

- **Rebuilding `tex.wasm` / `core.dump` before 1.0.** Consequence, documented honestly rather than left rotting in the tracker: expl3 (#86) and everything downstream of it (siunitx v3 #30, forest, xparse, mathtools, tcolorbox); modern chemfig (#22, #50); chemfig `\schemestart` bond loss (#25, #54 — the DVI is already wrong before any JS runs, verified by a contributor who opened `input.dvi` in TeXShop); `patterns` (#59 — the library files *are* bundled and `\usetikzlibrary{patterns}` succeeds, but the pgfsys driver never emits `<pattern>`); TeX capacity (#44); new fonts (#55, #113, #19, #36, #53); circuitikz > 1.0 (#62, #63); pgfplots > 1.16 (#108, #110); LuaTeX-only packages (#20). A CI-built engine is a **parallel track**, never a dependency of the roadmap.
- **Adopting `@rod2ik/tikzjax` as the default engine.** It ships pgfplots 1.18.2, a worker pool and viewport priority — but it raises `pages` 1100 → 2500 (68.75 → **156.25 MiB per render**), its device-memory cap silently no-ops on iOS (`navigator.deviceMemory` is undefined in WebKit → `Number(undefined)` is NaN → `POSITIVE_INFINITY`, i.e. no cap), and its `texify` wraps `\begin{document}` itself, which would nest document environments in every existing note in every vault. It becomes an opt-in `TexHost` behind the engine seam, desktop-first, never the default without an on-device memory measurement.
- **Externalising assets as sibling files.** Obsidian's community installer fetches only `main.js`, `manifest.json` and `styles.css`. `adapter.read(manifest.dir + '/worker.txt')` and per-face WOFF2 files **do not reach store users**. Everything ships inside those three files; the mobile win comes from reducing *copies* and *eager parsing*, not from externalising.
- **Download-on-first-run.** Offline operation was a deliberate feature (#3); a first-run network dependency is a worse failure mode than a large file.
- **Code-fence info-string options** (```` ```tikz width=300 ````). See §7.7 — this is a correctness hazard, not a matter of taste.
- **A user-extensible transformer registry with priorities and a plugin API** (PR #105's shape). Six ordered pure functions in an array. Nothing is pluggable.
- **Any document-level `MutationObserver`.** One `IntersectionObserver` per scroll root, and nothing else observes anything.
- **Persistent negative caching.** Failures are session-scoped only; a plugin update or a fixed package must retry automatically.
- **Cancelling a compile that has already started, when the block changes.** The brief asks for it; we deliberately deliver only *pre-start* cancellation (unload during `GATING`/`DEBOUNCING`/`SCHEDULING` drops the job before it is submitted, which is where the editing loop actually spends its time). A started job runs to completion and its result is cached, because the only mechanism that can stop an asyncify'd TeX run is `Worker.terminate()`, which costs a ~1 s respawn and throws the result away. Mid-flight termination is therefore reserved for three cases: timeout, plugin unload, and backpressure (> 2× concurrency newer jobs queued behind it). `AbortSignal` is plumbed through `TexHost.render` from Phase 2 so this is a policy choice, not a structural limit — but it is **not** available at all before Phase 4 (`LegacyScriptHost.supportsCancellation = false`).
- **Inline `$tikz:…$` rendering** (#112); **PNG rasterisation**; **an Obsidian Publish `publish.js` shim** (#37/#47 — Finalize-to-attachment is strictly better for visitors than shipping 7 MB of WASM TeX per page view); **a local-LaTeX backend**; **a side-by-side source/preview editor mode** (#64 — what the reporter actually wants is error visibility and a fast edit loop, both delivered by Phases 2 and 4).
- **Renaming the plugin id.** PR #109's rebrand to `obsidian-tikzjax-pdf` would orphan every install's settings and cache. Never.

---

## 2. Current state: what is broken, with evidence

### 2.1 The architectural defect

`registerTikzCodeBlock` (main.ts:96-103) creates a `<script type="text/tikz">` and returns `void`. Everything after that is owned by the vendored bundle: a `MutationObserver` on `document.body`, a module-global serialization array `c`, a localForage cache, an md5 keyed on `JSON.stringify(el.dataset) + el.childNodes[0].nodeValue`, and an error path that writes `<img src='//invalid.site/img-not-found.png'/>`. The plugin holds **no handle on anything**, so per-diagram timeout, cancellation, dedup, debounce, a queue, lazy rendering, real errors and correct export are all structurally unreachable.

### 2.2 Verified defects, ranked

| # | Defect | Evidence | Issues |
|---|---|---|---|
| 1 | **Renders can wedge globally.** `let f = new Promise(async (q,e)=>{…})` never calls `e`; batches chain via `c.push(f); c.length>1 && await c[c.length-2]`, and `c.shift()` runs only on the success path. A `texify` that never settles, or a throw outside the try, blocks every future diagram until Obsidian restarts. | tikzjax.js @7032193+ | #18 #23 #27 #39 #51 #82 #85 #89 (~22 reporters) |
| 2 | **No timeout, and TeX can block rather than throw.** The worker feeds a fixed terminal string `Mq(" input.tex \n\\end\n")`; grep for `nonstopmode` / `batchmode` returns **0**. A TeX error can reach the interactive `? ` prompt and suspend the asyncify'd wasm forever. A suspended asyncify continuation **cannot be resumed** — only terminated. | tikzjax.js @6952700 | #24 #27 #82 |
| 3 | **Export renders in a document that never gets the engine.** `printToPdf` opens `window.open("about:blank","_blank","popup,hide=true")` — not a `WorkspaceWindow`, so `workspace.on('window-open')` never fires. Obsidian clones every `<style>`/`<link>` into it but **not** `<script>`. And the processor returns `void`, so the only wait before `ipcRenderer.send("print-to-pdf")` is a hard-coded `sleep(200)`. | Obsidian 1.13.7 bundle; main.ts:96-103, :45 | #45 #114 #101 #109 |
| 4 | **Post-processing silently does not run.** The completion listener is on the **document** (main.ts:52) and the event is dispatched on the newly-inserted SVG. Reading view virtualises sections (`renderExtra=1`, `renderExtraMinPx=500`); if the section is detached when the async cache read resolves, the bubbling event never reaches `document` and the raw SVG stays. A reporter measured 5868 B (broken) vs 2013 B (correct). | main.ts:52, :172-184 | #102 #93 #87 #15 |
| 5 | **The cache stores the wrong artifact.** `await P().setItem(A.md5hash, r.outerHTML)` runs **before** `r.dispatchEvent(t)`, so the cache holds the raw pre-post-process SVG. Every hit re-pays the full SVGO pass on the main thread — measured 8.2 / 43.0 / 267.7 ms for 12 KB / 119 KB / 720 KB SVGs on warm V8, and 2-4× that on JSC. | tikzjax.js @7032193 | #15 #58 #90 |
| 6 | **Duplicate element ids.** pgf ids are namespaced by *content hash*, so the same diagram in two panes emits byte-identical `<clipPath id=…>`; `url(#id)` resolves to the first match in document order and clip paths leak across panes. | tikzjax.js @7031700 | #12 |
| 7 | **Dark mode is a quoted-string regex.** main.ts:142-143 matches only `"#000"/"black"` and `"#fff"/"white"`. It misses `#000000`, `rgb(0,0,0)`, and **every unquoted CSS declaration** — dvi2html emits out-of-picture text as `<span style="line-height: 0; color: black; …">`, which the regex cannot match at all. It cannot distinguish TeX's default ink from a deliberate `\fill[white]`. It runs *before* SVGO's `convertColors`, so the passes cancel. It bakes `var(--background-primary)` into **presentation attributes**; outside Obsidian an unresolvable `var()` is invalid-at-computed-value-time, so `fill` falls back to its initial value — **black**, not white. And main.ts:177 never checks whether dark mode is actually active. | main.ts:137-146, :177 | #38 #15 #21 #93 #87 #97 #103 |
| 8 | **SVGO silently rescales geometry.** `preset-default`'s `cleanupNumericValues` converts pt→px when the string is shorter: `width="113.386pt" height="56.693pt"` → `151.181`/`75.591` (×4/3); for `100.0pt`/`50.00000pt` it converts **only the height**, breaking the aspect ratio. `removeViewBox` is also enabled. | reproduced against the repo's own `svgo.browser.js` | #12 #42 #50 #66 |
| 9 | **The viewBox does not bound the ink.** dvi2html emits `viewBox="-72 -72 W H"` — the 1-inch DVI origin shift is applied to the origin but not the extent, so the frame is systematically an inch short. `styles.css:143-148` papers over it with `overflow: visible`, scoped to `.markdown-rendered` only. | tikzjax.js dvi2html; styles.css:143 | #66 #71 #29 #94 |
| 10 | **`outerHTML` assignment.** main.ts:183 `svgEl.outerHTML = svg` violates Obsidian's plugin guidelines (the community-store bot flags `outerHTML` assignment on submission; whether it is re-run on updates of an already-listed plugin is **unverified**, so treat it as a guideline violation to remove, not as a release blocker for Phases 0-1), destroys node identity, throws `NoModificationAllowedError` on a detached parent, and — because SVGO v2 returns `{error}` with no `.data` on parse failure (`@ts-ignore`'d at main.ts:167) — can write the literal string `"undefined"` into the note. | main.ts:167, :183 | — |
| 11 | **Unguarded mobile hazards in `onload`.** main.ts:109 dereferences `window.CodeMirror.modeInfo`; main.ts:84 dereferences `workspace.floatingSplit.children` (initialised to `null`, populated only by the pop-out system, which mobile lacks); main.ts:57 does `s.remove()` with no null check, so `onunload` throws and `removeSyntaxHighlighting()` never runs. main.ts:114 *reassigns* `modeInfo` rather than splicing, silently breaking other plugins holding a reference. | main.ts:57, :84, :109, :114 | #74 |
| 12 | **12.07 MiB shipped, parsed eagerly.** `main.js` is 7,772,247 B unminified (esbuild has no `minify` key at all); `styles.css` is 4,791,337 B of which ~15,205 B is real CSS and the rest is 140 base64 TrueType `@font-face` rules that Obsidian parses into the CSSOM at launch **whether or not any note has a diagram**. The 7 MB payload is then materialised again as a DOM text node (main.ts:48, via `innerText`), again as the module-147 string, and again as a `Blob` whose object URL is **never revoked** (grep `revokeObjectURL` → 0). | measured | #111 #74 #91 #7 #3 |
| 13 | **~206 MiB peak worker memory per render.** `new WebAssembly.Memory({initial:1100, maximum:1100})` = 68.75 MiB allocated fresh per `texify`, plus `ye.slice(0)` = a second full 68.75 MiB copy, on top of the permanently retained 68.75 MiB core dump. `mq()` also clears `cq`, so the entire pgf/pgfplots tree is re-base64-decoded and re-gunzipped on every render. | tikzjax.js @6952617 | #7 #24 #91 #111 |
| 14 | **`tidyTikzSource` corrupts TeX.** main.ts:121 removes the six-character **entity** `&nbsp;` (deleting it, joining tokens) but never the real U+00A0. main.ts:127 `map(l => l.trim())` destroys leading whitespace. main.ts:130 `filter(line => line)` **deletes every blank line**, i.e. every `\par`. | main.ts:117-134 | latent |
| 15 | **Toolchain frozen in 2021.** esbuild 0.13.12 using the `watch` build option **removed in 0.17**; **thirteen** of the twenty-one `@codemirror/*` externals no longer exist as packages (only `autocomplete`, `collab`, `commands`, `language`, `lint`, `search`, `state`, `view` survive in CM6); no `@lezer/*`; `obsidian: "latest"`; `pako`/`@types/pako` declared and never imported; `tslib`; `package-lock.json` at `lockfileVersion 2` stamped `0.3.0` and **missing `localforage` entirely**, so `npm ci` fails; `versions.json` is `{"0.1.0":"0.12.0"}` against a manifest saying `0.5.2` — five releases of silent drift; release workflow on archived `actions/create-release@v1` + `upload-release-asset@v1` and `::set-output`, disabled by GitHub in 2023, so the zip already uploads as `obsidian-tikzjax-.zip`. | package.json, tsconfig.json, esbuild.config.mjs, .github/workflows/release.yml | #5 |
| 17 | **User TeX can inject arbitrary markup into the SVG, and the current insertion paths execute it.** The bundled dvi2html implements `special{dvisvgm:raw …}` by stripping the prefix and emitting the remainder **verbatim** into the SVG stream (`e.x.replace(/^dvisvgm:raw /,"")` → `putSVG`, tikzjax.js @54533). So a ````tikz```` fence can emit `<script>`, `onload=`, `<foreignObject>` or `<a href="javascript:">` into the rendered output. Both insertion paths run it: the bundle's cache-hit path uses `document.createRange().createContextualFragment(f)` (tikzjax.js @7030054), whose script nodes are *not* marked already-started and therefore execute on insertion; and main.ts:183's `outerHTML` assignment executes event-handler content attributes. Notes are synced, shared and downloaded, so this is reachable without the reader writing any TeX. | tikzjax.js @54533, @7030054; main.ts:183 | none filed |
| 18 | **The failure path makes an outbound network request.** The bundle's only error handler sets `<img src='//invalid.site/img-not-found.png'/>` (1 occurrence, verified). Every failed render is a DNS lookup and an HTTP request to a third-party name, from a plugin whose headline feature is offline operation (#3). It is also the reason failures look like a "broken image" rather than an error. | grep `invalid.site` → 1 | #81 #3 |
| 16 | **`data-show-console="true"` is hardcoded** (main.ts:100), so every TeX terminal line is `postMessage`'d to the main thread and `console.log`'d for every diagram — and because the legacy cache key hashes `JSON.stringify(dataset)`, the flag is part of the key. Nothing reads the stream. | main.ts:100 | #81 |

### 2.3 A correction to the shared reading of the bundle

A *rejected* `texify` does **not** wedge the queue: the bundle's `catch(A){ return console.log(A), void(q.outerHTML="<img …>") }` is inside `r(A)`, so `r` returns normally, the `for…await` loop continues and `c.shift()` runs. The wedge class is exactly two paths: **(a)** a `texify` that never settles, and **(b)** a throw *outside* the try. For (b), note that `ChildNode.replaceWith(null)` does **not** throw — non-`Node` arguments are stringified — so the likely throw is the subsequent `r.outerHTML` on a null `r`. This narrows what plugin TypeScript can honestly promise before Phase 4, and it is why Phase 2 ships a session poison set rather than claiming a fix.

### 2.4 A correction all three proposals got wrong

A rejected processor promise does **not** produce Obsidian's `Encountered an error while rendering code block.` Notice. That `catch` wraps the **synchronous** handler call `t(r,a,s)`. In Live Preview `promises: []` is a throwaway array that is never awaited, so a rejected returned promise is an unhandled rejection. The conclusion — **never reject** — still holds, for different reasons: in reading mode `Promise.all(d).then(...)` has no `.catch`, so a rejection strands `asyncSections` forever and the section is never re-measured; in export it throws out of `printToPdf`.

---

## 3. Target architecture

### 3.1 Module layout

Every file has one job. Anything expressible as a pure `(input) => output` is one, and lives outside `platform/` so it is testable in Node with no DOM.

```
src/
  main.ts                      Entry: lifecycle, wiring, command registration. Target < 120 lines.

  platform/
    budgets.ts                 Desktop vs mobile constants in one table (§7.2).
    context.ts                 isExportContext(el), per-document registry, Platform probes.
    obsidian-compat.ts         Guarded access to window.CodeMirror, floatingSplit, addStatusBarItem.
    ports.ts                   FileReader / Clock / Storage interfaces so core never imports `obsidian`.

  settings/
    schema.ts                  TikzSettings, DEFAULTS, artifactRevision() (§6.1), settingsVersion.
    tab.ts                     getSettingDefinitions() (>=1.13) with a display() fallback.

  source/
    normalize.ts               normalizeSource(): BOM, CRLF, real U+00A0/U+200B/U+FEFF. PRESERVES blank lines. Pure.
    legacy-tidy.ts             FROZEN byte-for-byte copy of main.ts:117-134. Never edited. (§8.2)
    directives.ts              `%!tikz` directive parsing -> BlockOptions; strips them before hashing. Pure.
    preflight.ts               Source lint -> Warning[] driven by engine/inventory.ts (§7.6). Pure.

  block/
    processor.ts               registerMarkdownCodeBlockProcessor handler; the promise contract (§3.3).
    render-child.ts            TikzBlock extends MarkdownRenderChild — owns one block, holds its AbortController.
    machine.ts                 Pure (state, event) => [state, Effect[]]. No DOM, no async. Property-tested.
    placeholder.ts             Intrinsic-sized skeleton from the cached bbox. No layout shift.
    mount.ts                   Artifact + instance nonce -> DOM. One insert. Never outerHTML.
    viewport.ts                One shared IntersectionObserver per scroll root + the zero-record fallback.
    error-card.ts              The .tikzjax-error element, hint text, Retry / Copy log.

  queue/
    queue.ts                   Bounded priority queue: submit / dedup / refcount / cancel / depth cap / timeout.
    poison.ts                  Session-scoped set of keys that timed out. Never persisted.

  cache/
    key.ts                     deriveKey(); SCHEMA_VERSION. Pure. Uses a BUNDLED SYNCHRONOUS sha256.
    legacy-key.ts              FROZEN reimplementation of the bundle's md5 key. Never edited.
    memory.ts                  L1 LRU (entry count + byte budget), O(1) touch.
    idb.ts                     L2 IndexedDB: `renders` + `meta`, lastUsed index, lazy schema eviction.
    legacy-import.ts           L3 read-through of TikzJax/svgImages (§8.3).
    index.ts                   Facade: get / put / stats / clear / warmNote.

  engine/
    host.ts                    TexHost interface + TexJob / TexResult / TexError taxonomy. The seam.
    rpc.ts                     Typed threads.js-v1 client over a raw Worker port (~120 lines). (§5.2)
    worker-host.ts             Phase 4: owns Worker(s), timeout -> terminate + respawn, per-job log capture.
    legacy-script-host.ts      Phase 2 only: per-document driver injection + per-job staging wrapper. Deleted in 4.
    worker-source.ts           BUILD-GENERATED: extracted + patched module-147 string, ENGINE_ID = sha256.
    inventory.ts               BUILD-GENERATED: bundled tex_files, package versions, capabilities.
    log-parse.ts               TeX transcript -> Diagnostic[]. Pure.
    hints.ts                   Diagnostic + capabilities -> actionable hint text. Pure.

  svg/
    serialize.ts               The single DOMParser / XMLSerializer boundary. Typed parse failures.
    sanitize.ts                MANDATORY stage 2: strip script/handler/external-reference nodes (§7.2, defect 17). Pure.
    pipeline.ts                Ordered stage array; per-stage error isolation -> MOUNTED(degraded).
    entities.ts                &#173; -> &#172; soft-hyphen remap (#2), explicit and commented.
    text-fix.ts                Drop alignment-baseline; flatten the scale/translate/scale chain. Pure matrix math.
    optimize.ts                SVGO adapter (corrected overrides) OR the targeted transform. Optional.
    colors.ts                  Ink/paper classification over attributes AND style declarations. Pure.
    ids.ts                     id -> __TZ__n placeholders + full reference sweep. Pure.
    geometry.ts                Apply a measured ink bbox to viewBox/width/height. Pure arithmetic.
    measure.ts                 The ONLY DOM measurement in the plugin: fonts.ready + getBBox(). (§7.4)
    freeze.ts                  Export: resolve currentColor/classes to literals, inline the used @font-face subset.

  assets/
    fonts.ts                   The 128 non-core faces as a cold string; per-document lazy injection.

  ui/
    strings.ts                 Every user-visible string, one module (§7.11 — the only realistic i18n affordance).
    debug-view.ts              ItemView: engine state, queue depth, timings, cache stats, inventory.
    status-bar.ts              Desktop-only (Platform.isDesktop) render indicator.
    zoom.ts                    Pan/zoom modal over a cloned SVG.
    commands.ts                render-note / render-vault / copy-svg / save-svg / finalize / clear-cache.

vendor/
  tikzjax.txt                  The 7 MB bundle, imported with { type: 'text' }. Untouched bytes.
  CHECKSUMS                    sha256 of every vendored input. Verified in CI.
  fonts.core.css               12 core faces, shipped inside styles.css.
  README.md                    Provenance: upstream repo, commit, build command, checksum.

scripts/
  extract-worker.mjs           Pull module 147 out of vendor/tikzjax.txt.
  patch-worker.mjs             Pinned string patches. EACH ASSERTS EXACTLY ONE MATCH OR FAILS THE BUILD.
  gen-inventory.mjs            Decode the embedded tex_files manifest -> engine/inventory.ts.
  build-fonts.mjs             TTF -> WOFF2; split core / cold string; emit styles.css.

test/
  stubs/obsidian.ts            ~40-line hand-written runtime stub.
  fixtures/*.svg               Golden corpus, captured from the SHIPPED engine.
  *.test.ts
```

**Deleted outright at Phase 4:** `loadTikZJax`, `unloadTikZJax`, `loadTikZJaxAllWindows`, `getAllWindows` (main.ts:44-92), the document-level `tikzjax-load-finished` listener (main.ts:52), the `window.TikzJax` guard dependency, the injected `<script>`, the vendored `svgo.browser.js` (once the targeted transform passes the iOS gate), the `floatingSplit` `@ts-ignore` (main.ts:82), and the `workspace.on('window-open')` handler. Pop-out windows then need no per-document work except a font stylesheet.

### 3.2 Data flow

```
  ```tikz fence in a note
          │
          ▼
  registerMarkdownCodeBlockProcessor("tikz", handler, 0)          [obsidian.d.ts:5001]
          │  (source, el, ctx)
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ processor.ts        el.addClass('tikzjax-figure')                         │
  │                     child = new TikzBlock(el, ctx, source)                │
  │                     ctx.addChild(child)   ← Obsidian owns load()/unload() │
  │                     return child.settled  ← NEVER rejects (§2.4)          │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  normalize.ts ─▶ directives.ts ─▶ preflight.ts ─▶ preamble.ts
   (pure)          (pure)           (warnings)      (vault reads, cached)
          │
          ▼
  key.ts  key = sha256( SCHEMA │ ENGINE_ID │ src │ preamble │ depHashes │ artifactRevision )
          │
          ├── L1  Map<key, Artifact>            HIT ─▶ mount (SYNCHRONOUS) ─▶ settle ─▶ done
          ├── L2  IndexedDB obsidian-tikzjax    HIT ─▶ promote to L1 ─▶ mount ─▶ settle
          ├── L3  legacy TikzJax/svgImages      HIT ─▶ pipeline() ─▶ write L2 ─▶ mount   (§8.3)
          │                                            (imported records keyed honestly)
          ▼ miss
  ┌──────────────────────────┐   export? ──yes──▶ priority 0, no gate, no debounce
  │ viewport.ts              │
  │  IntersectionObserver    │   no ──▶ GATING ──intersect──▶ DEBOUNCING ──▶ SCHEDULING
  │  + 2 s zero-record       │              └──2 s, 0 records──▶ SCHEDULING (LOW priority)
  │    escape hatch          │
  └──────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ queue.ts   dedup by key (refcounted) · priority 0..3 · depth cap          │
  │            Promise.race([ host.render(job, signal), timer(budget) ])      │
  └───────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ TexHost (engine/host.ts)                                                  │
  │   Phase 2: LegacyScriptHost   supportsCancellation = false                │
  │   Phase 4: WorkerHost         Worker(blob) ── rpc.ts ── threads.js frames │
  │                               TeX stdout arrives as BARE STRING messages  │
  └───────────────────────────────────────────────────────────────────────────┘
          │ TexResult { svg, log[], durationMs }        │ TexError { kind, log[], firstError, line }
          ▼                                             ▼
  svg/pipeline.ts  (pure, off-document)              error-card.ts + hints.ts
   1 parse  2 entities  3 ids  4 optimize                (log-parse.ts + inventory.ts)
   5 colors  6 serialize                                      │
          │                                                   │
          ▼                                                   │
  cache.put(key, { template, w, h })                          │
          │                                                   │
          ▼                                                   ▼
  mount.ts   stamp __TZ__ -> t<N>_   ·   measure.ts (fonts.ready + getBBox, once per key)
          │                              -> geometry.ts -> persist corrected viewBox
          ▼
  MOUNTED  ──▶ settle()      (exactly one settle() per child — invariant, property-tested)
```

### 3.3 The per-block state machine

`block/machine.ts` is a pure reducer, `(state, event) => [state, Effect[]]`. No DOM, no async, no timers — effects are descriptions the child executes. This is what makes the lifecycle exhaustively testable in Node.

**Invariant (enforced in the reducer, property-tested under randomised fault injection):** exactly one `settle()` per child, emitted only on entry to `MOUNTED`, `MOUNTED_DEGRADED`, `FAILED` or `DISPOSED`. Re-entering a terminal state emits none. This is the single most important guarantee in the design, because re-introducing the never-settling-promise class would be the one regression that destroys credibility.

| From | Event | To | Effects |
|---|---|---|---|
| — | `load` | `KEYING` | add classes; paint placeholder from `cache.peekSize(key)` or 4:3 min-height 80px |
| `KEYING` | `emptySource` | `FAILED(EmptySource)` | mount card; **never enqueue** — this is the `childNodes[0].nodeValue` throw, killed at the door |
| `KEYING` | `preflightError` | `FAILED(Preflight)` | mount card with the specific hint (`\documentclass` at the top of a block, no `\begin{document}`, unbundled package) |
| `KEYING` | `l1Hit` | `MOUNTED` | mount synchronously; `settle()`; the returned promise is `undefined` so the section is never flagged async |
| `KEYING` | `l1Miss` | `LOOKUP` | one IndexedDB read (+ one legacy read while the L3 window is open) |
| `LOOKUP` | `hit` | `TRANSFORMING` (L3) / `MOUNTING` (L2) | promote to L1 |
| `LOOKUP` | `miss` ∧ `isExport` | `SCHEDULING` (priority 0) | bypass gate **and** debounce |
| `LOOKUP` | `miss` ∧ `poisoned` | `FAILED(Timeout)` | "this diagram timed out; reload Obsidian to retry" — one wedging block no longer starves the vault |
| `LOOKUP` | `miss` ∧ `manual` \| `depthCap` | `IDLE_MANUAL` | render a "Render diagram" button |
| `LOOKUP` | `miss` | `GATING` | observe with the shared IntersectionObserver, `rootMargin` per budget |
| `GATING` | `intersect` | `DEBOUNCING` | — |
| `GATING` | **`noRecordsAfter2s`** | `SCHEDULING` (priority 3) | **escape hatch**: collapsed callout, hidden tab, `display:none` ancestor, or a detached reading-view section would otherwise sit here forever with a permanent placeholder |
| `DEBOUNCING` | `timer` | `SCHEDULING` | priority from visibility |
| `DEBOUNCING` | `unload` | `DISPOSED` | **nothing was ever submitted** — this alone is the fix for #24 |
| `SCHEDULING` | `slot` | `COMPILING` | `Promise.race([host.render, timer])` |
| `COMPILING` | `ok` | `TRANSFORMING` | attach log buffer to the result |
| `COMPILING` | `err` \| `timeout` | `FAILED` | on timeout: `terminate()` + respawn + add key to the session poison set |
| `COMPILING` | `unload` | stays `COMPILING` | **we do not cancel a running job.** We already paid; the result goes to cache. Exceptions: plugin unload, timeout, or > 2× concurrency newer jobs queued behind it |
| `TRANSFORMING` | `ok` | `MOUNTING` | write L1 + L2 |
| `TRANSFORMING` | `stageThrew` | `MOUNTING(degraded)` | fall back to the previous stage's output, mount it, show a non-blocking warning chip — **never a silent raw-SVG fallthrough** (that is #15 and #48). The `ids` stage is exempt: it always runs, so a degraded mount can never reintroduce #12 |
| `MOUNTING` | `mounted` | `MOUNTED` / `MOUNTED_DEGRADED` | stamp nonce; on first mount of a key, `await document.fonts.ready` then `getBBox()` then persist |
| `MOUNTED` | `css-change` | `MOUNTED` | **no-op.** Colour is CSS. |
| `FAILED` | `retry` | `SCHEDULING` | clear the poison entry for this key |
| any | `unload` | `DISPOSED` | `abort()`, unobserve, `queue.release(key)`, clear timers |

Two consequences worth naming. **Debounce falls out for free**: in Live Preview a keystroke destroys the widget and builds a new one (reuse is keyed on exact `(lang, code)` equality), so the old child unloads before its `DEBOUNCING` timer fires and nothing is ever submitted. And **the whole "post-processing didn't run" family (#15, #87, #93, #102) becomes structurally impossible**, because there is no bubbling event and no detached-node race: the artifact is transformed *before* it enters the document.

### 3.4 Public contracts between modules

```ts
// source/directives.ts
export interface BlockOptions {
  presentation: { width?: string; maxWidth?: string; scale?: number;
                  align?: 'left'|'center'|'right'; colors?: ColorMode; alt?: string;
                  lazy?: 'on'|'off'|'manual'; timeout?: number };
  baked: BakedOptions;          // participates in the cache key
  raw: boolean;                 // escape hatch: ids stage only
  nocache: boolean;
}
export interface BakedOptions {  // EXACTLY the inputs that change the stored bytes
  border: number | null;         // null = do not inject \standaloneconfig (default)
  packages: Record<string, string>;
  libraries: string;
  tikzOptions: string;
  preamblePath: string | null;
}

// cache/key.ts
export interface KeyInputs {
  normalizedSource: string;
  preambleText: string;          // global + per-block + %:input, fully expanded
  depHashes: string[];           // sorted "path:hash" for every vault file read
  baked: BakedOptions;
  engineId: string;              // sha256 of the SHIPPED worker source
  artifactRevision: string;      // §6.1 — narrow and enumerated
}
export function deriveKey(i: KeyInputs): string;   // synchronous. bundled sha256, NOT crypto.subtle.

// engine/host.ts
export interface TexJob { key: string; source: string; dataset: Record<string,string>; timeoutMs: number; }
export interface TexResult { svg: string; log: string[]; durationMs: number; }
export type TexErrorKind = 'timeout'|'tex-error'|'missing-file'|'capacity'|'empty-output'|'engine-unavailable'|'aborted';
export class TexError extends Error {
  constructor(readonly kind: TexErrorKind, readonly log: string[],
              readonly firstError?: string, readonly line?: number) { super(firstError ?? kind); }
}
export interface TexHost {
  readonly id: string;                       // flows into the cache key
  readonly capabilities: TexCapabilities;    // drives error-card copy, not just the README
  readonly supportsCancellation: boolean;    // false for LegacyScriptHost — surfaced in the UI
  ensureReady(doc: Document): Promise<void>;
  render(job: TexJob, signal: AbortSignal): Promise<TexResult>;
  dispose(): void;
}

// svg/pipeline.ts
export type Stage = (doc: XMLDocument, opts: PipelineOptions) => void;   // pure, mutates the parsed doc
export interface Artifact {
  v: number; template: string;   // ids as __TZ__0..__TZ__n; paints theme-neutral
  w: number; h: number; viewBox: string | null;   // null until measure.ts fills it
  fonts: string[]; bytes: number; engineId: string;
  origin: 'render' | 'legacy-import';
  baked: BakedOptions;           // recorded honestly, including for legacy imports
  createdAt: number; lastUsed: number; warn?: string;
}
```

Core modules never import `obsidian`. Anything that needs the app goes through `platform/ports.ts`.

---

## 4. Subsystem spec: the TeX host

### 4.1 The seam

`TexHost` is the boundary that makes the riskiest work a *swap* rather than a rewrite. Two implementations exist across the roadmap; only one at a time is default.

### 4.2 `LegacyScriptHost` — Phase 2 only, deleted in Phase 4

Keeps the bundle's driver but confines it:

1. `ensureReady(doc)` — if `!initializedDocs.has(doc)`, create `<script id="obsidian-tikzjax-runtime">` with **`doc.createElement`** (fixing main.ts:45), set `textContent` (not `innerText`), append to `doc.body ?? doc.head ?? doc.documentElement`, and record it in a `WeakMap<Document, …>`. Called from the processor with `el.doc`, which is the only way to reach the PDF-export popup.
2. `render(job)` — append the `<script type="text/tikz">` into a **per-job wrapper** inside a per-document offscreen staging container (`position:fixed;left:-99999px;top:0`, attached to `doc.body` so the driver's `MutationObserver` sees it). One wrapper per job is not optional: `tikzjax-load-finished` bubbles, so a shared container would fire every job's listener for every other job's completion. Resolve on the event observed **on that job's wrapper**, additionally asserting `e.target` ancestry.
3. Set `type` and text *before* appending. Today's main.ts:97-102 works only by microtask timing coincidence (see commit `d55bc13`).
4. Reject on a `MutationObserver` seeing `img[src*="invalid.site"]`, and on timeout.
5. `supportsCancellation = false`, surfaced honestly: a timed-out block gets an error card **and** a one-time Notice — *"A diagram timed out. The legacy engine cannot be restarted; other diagrams may not render until Obsidian is reloaded."* Paired with the session poison set, one wedging diagram degrades to one dead diagram rather than a dead vault.

**Hard constraint for Phase 2: do not change any `data-*` value.** `data-show-console="true"` stays exactly as main.ts:100 has it, because the L3 legacy key hashes `JSON.stringify(dataset)`. Any dataset change before L3 is in place invalidates every user's existing cache.

### 4.3 `WorkerHost` — Phase 4, the real engine

The worker bundle is webpack module `147`, declared at byte 13 of `tikzjax.js` (`147:A=>{"use strict";A.exports='(()=>{var A={3867:…`), so its single-quoted literal content begins at byte 45. It ends in a threads.js `expose({load, texify})` — a real Promise API that the driver hides in a module-local `H`.

Build step (`scripts/extract-worker.mjs`, output committed as `src/engine/worker-source.ts`):

```
assert sha256(vendor/tikzjax.txt) === CHECKSUMS entry
assert exactly one match of the module-147 declaration
assert extracted.includes('texify:async function')
export const WORKER_SRC: string; export const ENGINE_ID: string   // sha256 of the PATCHED source
```

Runtime:

```ts
const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
const url  = URL.createObjectURL(blob);
const worker = new Worker(url);
URL.revokeObjectURL(url);         // the bundle never does this — the blob is pinned forever today
const rpc = new TexRpc(worker);   // §5.2
await rpc.call('load', []);
const svg = await rpc.call('texify', [source, dataset], line => job.log.push(line));
```

Blob-URL workers are **proven working on Obsidian iOS today** — the current plugin does exactly this and renders on iPad (#24, #91). A `file://` worker URL from a `capacitor://localhost` document would be cross-origin and is not an option.

What this buys, none of it reachable otherwise: real timeouts with recovery (`terminate()` + respawn); real errors (the stdout stream is already enabled, just discarded); `\nonstopmode` injection, which likely converts most interactive-prompt hangs into loggable errors; no `<script>` injected into any document (−7 MB DOM text node per window, no `MutationObserver` on `document.body` firing on every keystroke in the file explorer); a real `onunload` that actually tears down; and a typed `empty-output` error for the `firstChild === null` wedge path.

### 4.4 Build-time worker patches

`scripts/patch-worker.mjs` applies a small pinned set. **Every patch asserts exactly one match or fails the build.** A pinned SHA-256 catches an edited blob; only the match assertion catches a patch that silently becomes a no-op.

| ID | Patch | Buys | Ships |
|---|---|---|---|
| **P0** | `//invalid.site/img-not-found.png` → `data:,tikzjax-error` | removes the outbound network request on every failure (defect 18) and keeps the failure marker detectable — LegacyScriptHost's MutationObserver selector becomes `img[src^="data:,tikzjax-error"]` | **Phase 1** |
| **P1** | `new Uint8Array(n.buffer,0,65536*gq).set(ye.slice(0))` → `.set(ye)` | −68.75 MiB transient per render | **Phase 1** |
| **P2** | Hoist `WebAssembly.compile(je)` to a cached module-level promise; `new WebAssembly.Instance(mod, imports)` per run | stops recompiling 517,692 B of wasm every render | **Phase 1** |
| **P2b** | Hoist `WebAssembly.Memory` and reuse it across renders | −68.75 MiB resident churn per render | **Phase 1** |
| **P3** | `let z=iq("input.dvi").buffer;mq()` → `try{ … }finally{ mq() }` | stops the poisoned-VFS cascade after any failure | Phase 4 |
| **P4** | Replace the async file loader's empty `catch(A){}` with `postMessage("!TIKZJAX-MISSING-FILE " + A)` | "package X is not bundled" instead of a mystery hang | Phase 4 |
| **P5** | `texify(q,e)` → `texify(q,e,files)`; seed `cq` via the existing `Nq(name,bytes)` | user `.sty` + data files (#4, #13) | Phase 8 |
| **P6** | `mq()` no longer clears `cq` (decompressed tex_files) | stops re-gunzipping the pgf tree per render | Phase 8, behind a setting for one release (it changes VFS lifetime) |

**Delivery problem Phase 1 must solve, or its acceptance criterion is unmeetable.** Until Phase 4 there is no `WorkerHost`: `LegacyScriptHost` injects the *whole bundle* as a `<script>`, and §3.1 declares `vendor/tikzjax.txt` to be "untouched bytes". Patches applied to the extracted module-147 source therefore reach **nothing that runs** in Phases 1-3, and Phase 1's stated acceptance ("peak worker memory per render drops by ≥ 68 MiB") cannot be observed. Resolution, and it is not optional: `scripts/patch-worker.mjs` must **re-splice** the patched module 147 back into the bundle string it emits. Module 147's declaration occurs exactly once (byte 13, verified) and its body is a single-quoted JS string literal, so re-splicing means re-escaping backslashes and single quotes and then asserting that re-extraction from the spliced bundle is byte-identical to the patched source. The build then emits **one** artifact, `engine/bundle-source.ts`, consumed by `LegacyScriptHost` in Phases 1-3 and by `WorkerHost` from Phase 4, with the same `ENGINE_ID` in both — which is also what keeps the Phase-2 cache key honest across the Phase-4 host swap. If the round-trip assertion cannot be made to hold, patches P0/P1/P2/P2b **move to Phase 4** and Phase 1's memory acceptance criterion moves with them. They do not silently ship as no-ops.

**Why P1/P2/P2b are safe enough to ship in Phase 1 rather than post-1.0:** the core dump is exactly 72,089,600 B = 1100 pages × 65536 = the **entire** non-growable `WebAssembly.Memory`. `.set(ye)` therefore fully resets a reused instance — there is no region of memory the dump does not cover. That property is what makes hoisting the Memory safe, and it is not obvious, so it is stated here rather than assumed. The Phase 1 golden corpus gates it: the patched engine must produce byte-identical SVG on every fixture.

### 4.5 Capabilities and the inventory

`engine/inventory.ts` is generated at build time from the bundle's embedded `tex_files` manifest:

```ts
export const INVENTORY = {
  engineId: 'sha256:…',
  engine: 'etex-3.14159265-2.6',
  capabilities: { expl3: false, twoPass: false, userFiles: false },
  packages: { pgfplots: '1.16', circuitikz: '1.0', 'tikz-cd': '0.9f', chemfig: '1.4', … },
  files: [ /* 212 names */ ],
  fonts: [ /* 140 faces */ ],
};
```

It drives four things, all mechanically generated rather than hand-maintained: the README package table (#68, #72, #84); the pre-flight warning strip (§7.6); the **error-card copy** — `capabilities.expl3 === false` turns `File 'siunitx.sty' not found` into *"siunitx v3 needs the expl3 primitives, which engine `bundled-2022` does not provide. Workaround: use `\Omega`."* (#30, #86, #55, #113); and a `\pgfplotsset{compat=…}` check against the bundled 1.16 (#110).

### 4.6 Plugging in a future engine

A new engine is a new `TexHost` with a new `id`. Because `id` is a cache-key input, switching engines invalidates exactly the affected artifacts and no more, and two engines can coexist. Migration is validated per-diagram against the golden corpus, plus a **"Render this block with engine X" debug command**, before anyone is switched — never validated by user reports. Swapping a rebuilt bundle is: replace `vendor/tikzjax.txt`, regenerate `worker-source.ts` + `inventory.ts` + `CHECKSUMS`, run the corpus. **No plugin code changes.**

---

## 5. Subsystem spec: queue, concurrency, timeout, cancellation

### 5.1 Semantics

- One `RenderQueue` per plugin instance (not per window). Slots = concurrency.
- Priority `0` export/print · `1` visible · `2` within `rootMargin` · `3` prefetch / manual / zero-record fallback. Stable FIFO within a band.
- **Dedup**: `inflight: Map<key, {promise, refs, controller}>`. Two panes showing the same block, or the same block twice in one note, produce **one** compile and two mounts with **different** instance nonces.
- **Release**: `refs--`. At zero, an unstarted job is dropped from `pending`; a started job is left to complete and cache.
- **Every job settles in a `finally`** that releases the slot. The failure mode of §2.2 defect 1 is structurally excluded.
- **Depth cap**: overflow demotes the farthest-from-viewport jobs to `IDLE_MANUAL`, so a 200-diagram note never commits to hours of work.
- **Poison set**: a key that timed out is refused for the rest of the session (never persisted). Cleared by Retry, by any settings change, and by reload.

### 5.2 The RPC layer

We speak threads.js's wire protocol but do **not** ship threads.js on the main thread — the worker already bundles its own runtime, and the master side is ~120 lines of typed code testable against a fake `MessagePort`.

```ts
type WorkerMsg =
  | { type: 'init';  exposed: unknown }
  | { type: 'running'; uid: number; resultType: 'promise'|'observable' }
  | { type: 'result'; uid: number; complete?: boolean; payload?: unknown }
  | { type: 'error';  uid: number; error: SerializedError }
  | { type: 'uncaughtError'; error: SerializedError };
```

**The load-bearing detail:** TeX stdout does **not** arrive as a protocol frame. It arrives as a **bare string `postMessage`**, so the message handler must branch on `typeof e.data === 'string'` *before* the frame switch. Without that, Phase 4's log capture silently sees nothing. Because a worker runs one job at a time, those bare-string lines are unambiguously attributable to that worker's current job — which is why we need no `console.log` monkey-patching, and why PR #100's single `currentTikzElement` pointer plus a 1 s debounce (which misattributes every error on a multi-block page) is rejected.

`rpc.ts` posts `{type:'run'}` after awaiting the worker's `init` frame. Messages would queue anyway, but the ordering dependency is load-bearing and is made explicit rather than left to luck.

### 5.3 Timeout

```ts
const result = await Promise.race([host.render(job, signal), timer(job.timeoutMs)]);
```

A bare `setTimeout(() => pool.kill(...))` around an `await host.run(...)` is **not** sufficient: `Worker.terminate()` fires no message, so the pending `Deferred` never settles and the `await` hangs forever. `Promise.race` plus an explicit reject-pending inside `kill()` is the contract.

`kill()` calls `Worker.terminate()`, revokes the blob URL, marks the host dead, and the pool respawns lazily. **This is mandatory, not defensive:** the engine feeds TeX a fixed terminal string with no `\nonstopmode`, so an error can reach the interactive `? ` prompt and suspend the asyncify'd wasm, and a suspended asyncify continuation cannot be resumed. `\nonstopmode` injection (Phase 4, via `addToPreamble`) is an optimisation; terminate-and-respawn is the guarantee.

### 5.4 Budgets

| | Desktop | Mobile (`Platform.isMobile`) |
|---|---|---|
| Concurrency | `min(2, hardwareConcurrency − 1)`, setting 1–4 | **1**, hard-clamped, not a preference |
| Per-diagram timeout | 10 s | 20 s |
| First-job grace (engine boot) | +20 s | +30 s |
| **Per-block export timeout** | 30 s | 30 s |
| **Total export budget** | **60 s** | 60 s |
| Queue depth cap | 64 | 16 |
| Lazy `rootMargin` | 200 px | 400 px |
| Zero-record escape hatch | 2 s | 2 s |
| Debounce while editing | 300 ms | 500 ms |
| L1 / L2 | 256 entries, 24 MB / 64 MB | 64 entries, 8 MB / 24 MB |
| SVGO default | `targeted` (after the iOS gate) | `preset` |
| Worker idle teardown | 5 min | 30 s, **and immediately on `visibilitychange → hidden`** |

Mobile concurrency 1 is not conservatism: even after P1/P2b each worker retains ~68.75 MiB, and two workers is ~137 MiB resident inside one WKWebView content process whose measured ceiling ranges from ~100 MB (iPhone SE3, iOS 26.2) to ~450 MB.

The **total export budget is not optional**. `Promise.all(ctx.promises)` has no timeout of its own, so 40 uncached blocks × 30 s would be a 20-minute uncancellable "Preparing PDF" modal. On expiry we mount error cards for whatever did not finish and resolve.

---

## 6. Subsystem spec: cache

### 6.1 Key derivation and `artifactRevision()`

```ts
key = sha256Hex(
  field(`s${SCHEMA_VERSION}`) +   // bumped only when the STORED ARTIFACT FORMAT changes
  field(engineId) +               // sha256 over the engine assets and engine-src/
  field(normalizedSource) +
  field(stableStringify(baked)) + // preamble, packages, libraries, border, two-pass
  field(artifactRevision) +
  field(stableStringify(pipeline)),
).slice(0, 32);
```

As built rather than as designed: the fields are length-prefixed (`field(s)` is `` `${s.length}:${s}` ``)
instead of joined by a separator. A separator has to be a byte no input can contain, and no such byte
exists here — the preamble is arbitrary TeX and the source is arbitrary user text — so with any
separator there is another pair of fields that concatenates to the same string. Length prefixes make
the encoding injective for free. See `src/cache/key.ts`.

`artifactRevision()` is **deliberately narrow and enumerated**:

```ts
// INCLUDED — these change the stored bytes:
{ svgo, textFix, precision, sentinelInk, nonstopmode }
// EXCLUDED — these are mount-time CSS or scheduling:
//   theme, colour mode, invertColors, scale, width, maxWidth, align, alt,
//   timeout, concurrency, lazy, debounce, captureLog, showConsole
```

Two unit tests make this a *tested property* rather than a hope: key sensitivity to every included input, and key **insensitivity** to theme and scale. Consequence: **switching theme or changing a diagram's scale costs zero recompiles and zero re-post-processing.** The current design cannot offer this because it bakes `currentColor` / `var(--background-primary)` into the artifact (main.ts:142-143).

`border` is **not** in the default `bakedOptions` — it is `null` unless a block opts in via a `%!tikz border=` directive. Geometry is corrected at mount time from the measured ink bbox (§7.4), which fixes #29/#66/#71/#94 without a TeX-side margin. This is what keeps the L3 window open (§8.3).

`sha256Hex` is a **bundled synchronous implementation (~2 KB)**, not `crypto.subtle`. `crypto.subtle.digest` is async and would break the synchronous L1 probe that delivers G1; it also carries an unnecessary secure-context question on `capacitor://localhost`. This is a cache key, not a security boundary.

`Plugin.onExternalSettingsChange()` (≥1.5.7) recomputes `artifactRevision` and drops L1 if it moved, so a Sync-driven `data.json` change re-derives the revision instead of serving stale artifacts.

### 6.2 Storage

**L1** — `Map<key, Artifact>`, LRU on entry count *and* bytes. Cleared on `visibilitychange → hidden` on mobile. This is the tier the synchronous processor probe reads, and it is what makes Live Preview ↔ Reading switching and scroll-back instant.

**L2** — our own IndexedDB database, named **`obsidian-tikzjax-<app.appId>`**. The name must carry `appId`: every vault on a desktop install shares one origin, so an unqualified name would share one store, one byte cap and one "Clear all" across every vault on the machine. Obsidian namespaces its own stores exactly this way (`appId+"-cache"`, `appId+"-sync"`, verified in the 1.13.7 bundle). Every open and every write is wrapped: WebKit evicts IndexedDB under storage pressure and after prolonged non-use, and a `QuotaExceededError` on write must degrade to "L1 only for this session" plus one Notice — never a failed render, and never an unhandled rejection inside the settle path. It stores `renders` (keyPath `key`, index on `lastUsed`) and `meta` (`{schema, totalBytes}` so eviction never needs a full scan). **Not localForage**: it is unmaintained (last published 2021-08-18), it is already fought with a try/catch at settings.ts:25-29 *because it breaks plugin load on mobile*, and it is the vendored bundle's store, not ours.

The stored artifact is the **final** post-processed SVG with `__TZ__n` id placeholders, plus `{w, h, viewBox}`. A hit is a `Map.get`, one `replaceAll`, one `appendChild`.

### 6.3 Invalidation, cap, eviction

- **By key.** Any input change produces a different key; nothing is ever stale.
- **Schema bump** → older records are treated as misses and swept in a **low-priority idle pass**. Never a startup wipe: a mass re-render on open is exactly the stampede L3 exists to avoid.
- **Preamble/include edits** → `preamble.ts` maintains `Map<filePath, Set<key>>`; `vault.on('modify')` on a tracked file drops those keys and re-renders visible blocks. This fixes the limitation PR #77's author conceded openly.
- **Cap** 64 MB desktop / 24 MB mobile; evict by `lastUsed` ascending to 90 % of cap on a debounced idle sweep.
- Settings shows `Cache: 412 diagrams · 18.4 MB` with **Clear all**, **Clear this note**, **Rebuild this note** (#58, #90).

### 6.4 Cache warm for export

1. `isExportContext` → priority 0, gate and debounce bypassed, depth cap lifted, processor awaits.
2. Command **Render all TikZ diagrams in this note** (cancellable progress Notice) — run before an export or a Publish push.
3. Command **Render all TikZ diagrams in vault** — a one-time warm after an engine or settings change. Priority 3, yields to interactive work.

---

## 7. Subsystem specs: rendering surface

### 7.1 Viewport / lazy

One `IntersectionObserver` per scroll root, pooled, never a document scanner. `rootMargin` per budget. Obsidian's reading view already virtualises sections (`renderExtra=1`, `renderExtraMinPx=500`) but `cleanupParentComponents()` keeps their children alive, so **unload is not a "left the viewport" signal** — the observer is ours.

The **zero-record escape hatch is mandatory**: if a placeholder has been attached for > 2 s with zero `IntersectionObserverEntry` records, submit at priority 3. Without it, a block inside a collapsed callout, a hidden tab, a `display:none` ancestor, or a reading-view section Obsidian has detached would sit in `GATING` forever with a permanent placeholder — a *new* class of blank-diagram bug introduced by lazy rendering itself.

### 7.2 SVG pipeline

Ordered pure stages over a `DOMParser(…, 'image/svg+xml')` document. **No `outerHTML` anywhere.**

| # | Stage | Notes |
|---|---|---|
| 1 | `parse` | Root must be `<svg>`; anything else → typed `empty-output` error. |
| 2 | **`sanitize`** | **Mandatory, non-skippable; runs first and is not disabled by `raw`, `fast` or a degraded mount.** Remove `<script>` and `<foreignObject>` elements, every `on*` attribute, and any `href`/`xlink:href` whose value is not a same-document `#fragment`. Reason: `dvisvgm:raw` specials pass author markup through the engine verbatim (§2.2 defect 17), the artifact is then *persisted* to L2 and replayed on every later open, and the host is an Electron renderer. Removal is not silent: it downgrades to `MOUNTED(degraded)` with a "removed active content from this diagram" chip, so a legitimate raw-special user learns why. |
| 2b | `entities` | `&#173;` → `&#172;`, carried over **explicitly and commented**. It exists because of the fontforge glyph remap from #2; dropping it silently regresses `\Omega` and `\otimes`. Guarded by a golden fixture. |
| 3 | `ids` | Every `id` → `__TZ__n`; sweep every reference — `url(#…)` in attributes **and in `style` declarations**, `xlink:href`, `href`, `clip-path`, `mask`, `filter`, `marker-{start,mid,end}`, `fill`, `stroke`. Assert the token does not already occur; if it does, fall back to a random token stored in the record. **This stage always runs, including on the `raw` escape hatch and on a degraded mount.** |
| 4 | `optimize` | SVGO with corrected overrides, or the targeted transform (§7.3), or off. |
| 5 | `colors` | **After** optimize, so `convertColors` has already collapsed the value space to `#000`/`#fff`. |
| 6 | `serialize` | `XMLSerializer`. Record `{template, w, h}`. |

Then, at **mount** time only:

7. `stamp` — one string pass, `template.replaceAll('__TZ__', 't' + (++counter) + '_')`. The replacement string is computed **once, before the call**. A function replacer would run per match and produce a different nonce for the definition than for the reference, breaking every clip-path, mask, marker and gradient in the diagram — the exact bug this stage exists to fix.
8. `measure` + `geometry` (§7.4).
9. `layout` — `width` / `align` / `scale` applied to the **wrapper div**, never to the `<svg>` (#14, #26, #42).

Every stage runs in try/catch; a throwing stage is skipped, the previous output is mounted, and a warning chip appears — `MOUNTED(degraded)`. Never a silent raw-SVG fallthrough. Hardening: **no `String.prototype` methods on the hot path** — Pretty BibTeX 2.0.0 monkey-patched `String.prototype.replaceAll` to stringify a RegExp argument, silently killing both inversion and SVGO with no error anywhere (#48). Local helper functions only.

### 7.3 SVGO policy

The vendored blob is SVGO **2.x** (`cleanupIDs$1.name = "cleanupIDs"`, `.active` flags, `extendDefaultPlugins` present), so main.ts:162's `cleanupIDs: false` is correct *today* and becomes a **silent no-op** on any upgrade to v3+, re-minifying ids to `a`,`b`,`c` and reintroducing #12 across every diagram in a note. A unit test asserts that ids are unchanged after `optimize()` — that test is the guard against the rename landmine in either direction.

Three modes:

- **`preset`** — SVGO with corrected overrides: `{ cleanupIds: false, removeViewBox: false, cleanupNumericValues: { convertToPx: false }, convertPathData: { floatPrecision: 5 }, removeTitle: false, removeDesc: false }`. `removeViewBox` and `convertToPx` are live regressions today (§2.2 defect 8).
- **`targeted`** — a ~40-line pure transform: collapse the `scale(-1,1) translate(a,b) scale(-1,-1)` chain the text group carries into a single matrix, and drop `alignment-baseline="baseline"` (spec-invalid on `<text>`, and where WebKit and Blink disagree — the most plausible mechanism behind #6). Saves 587 KB of bundle and 8–270 ms of main-thread time per diagram. **Implemented as matrix arithmetic on the transform attribute string, not via `SVGTransformList.consolidate()`** — neither jsdom 30 nor happy-dom 20 implements `consolidate()`, so a DOM-based version would be untestable in Node.
- **`off`** — fast mode.

**Gate:** `targeted` does **not** become the desktop default until #6 is reproduced on a real iOS device against a fixture. Until then it is opt-in and `preset` is the default everywhere. We refuse to delete 587 KB on the strength of a 2022 one-line issue with zero comments, on the platform where nobody is watching.

### 7.4 Geometry

dvi2html emits `viewBox="-72 -72 W H"` — the 1-inch DVI origin shift is applied to the origin but not the extent, so the frame is systematically an inch short of the ink. On the **first mount of a new key**:

```ts
await document.fonts.ready;                       // MANDATORY — see below
if (!allFontsResolved(artifact.fonts)) return;    // do NOT persist a bbox we cannot trust
try { const b = svg.getBBox(); … } catch { /* display:none in some engines */ }
```

`await document.fonts.ready` is not a nicety. dvi2html emits real `<text font-family="cmr10">` elements; a bbox measured before those faces resolve is wrong, and because the corrected viewBox is **persisted into the artifact** it would be wrong *forever* — the bbox is an output, not a key input, so no input change would ever invalidate it. A cache that poisons itself is worse than no cache. If any referenced face reports unloaded, we mount with the engine's viewBox and retry the measurement on the next mount rather than persisting a guess.

Every subsequent mount and every export is pure arithmetic. Complementary opt-in knob: `%!tikz border=4pt` injects `\standaloneconfig{border=…}` via `addToPreamble` — `standalone` is already the preloaded class, so this needs no rebuild (#29). Default `null`.

### 7.5 Colour model

Delete `colorSVGinDarkMode` (main.ts:137-146) entirely. The artifact is stored **theme-neutral**; theming is CSS on a class the plugin owns.

**Four emitters, all verified in the bundle** — the pass must handle all four:

1. `HTMLMachine` constructor: `q.color = "black"` — the default ink is the literal string.
2. `putRule`: `<rect … fill="black">` — TeX rules (fraction bars, `\hrule`, table rules).
3. `putText` at `svgDepth > 0`: `<text alignment-baseline="baseline" … fill="black">`.
4. `putText` at `svgDepth == 0`: `<span style="line-height: 0; color: black; …">` — **unquoted CSS in a `style` declaration**, which today's regex cannot match at all. `color` on HTML spans inside the output is explicitly in scope for stage 5, and is part of the golden corpus.

pgf paint arrives as `#rrggbb`, shortened to `#rgb`. dvi2html's colour-special mapper is `"gray 0"→"black"`, `"gray 1"→"white"`, `rgb …`→hex, and an unparseable special also falls back to `"black"`. **There is no marker distinguishing TeX's default ink from an author's `\fill[black]`** — the current code pretends otherwise, and that is the black/white box artefact.

```css
.tikzjax-figure {
  --tikz-ink:   var(--text-normal);
  --tikz-paper: var(--background-primary);
  color: var(--tikz-ink);
}
.tikzjax-figure svg { display: block; fill: currentColor; max-width: 100%; }
.tikzjax-figure svg .tz-paper-fill   { fill:   var(--tikz-paper); }
.tikzjax-figure svg .tz-paper-stroke { stroke: var(--tikz-paper); }

.tikzjax-figure.is-preserve { --tikz-ink:#000; --tikz-paper:#fff; }
.tikzjax-figure.is-paper    { --tikz-ink:#000; --tikz-paper:#fff;
                              background:#fff; padding:.5em; border-radius:4px; }
.theme-dark .tikzjax-figure.is-invert svg { filter: invert(1) hue-rotate(180deg); }

@media print { .tikzjax-figure { --tikz-ink:#000 !important; --tikz-paper:#fff !important;
                                 break-inside: avoid; page-break-inside: avoid; } }
.print .tikzjax-figure { --tikz-ink:#000; --tikz-paper:#fff; }
```

Both print rules are deliberate redundancy. Obsidian's export forces `theme-light` on the popup body, but its stylesheet-cloning helper installs a `MutationObserver` on the **main** body's `class`/`style` and re-copies it — so any body-class mutation during a multi-second export can flip the popup back to `theme-dark` mid-flight. `.print` pins the palette independently of both `@media print` emulation and the theme class. That is the mechanism behind "switch to light mode and export works", reported independently by three people on #45.

The DOM pass does exactly two things and **never writes `var()` into a presentation attribute**:

- **ink**: `fill`/`stroke`/`color` (attribute **or** `style` declaration) whose normalised value ∈ `{#000, #000000, black, rgb(0,0,0), rgb(0%,0%,0%)}` → `currentColor`.
- **paper**: same set for white → **remove the attribute, add a class** (`tz-paper-fill` / `tz-paper-stroke`).
- **gradient stops are left alone by default.** Rewriting the endpoints of a `ball color` ramp pushes them toward each other and flattens the shading (#73). Setting: `Adapt gradients: never (default) | ink-only`.

Modes, global + per-block: `adapt` (default) · `preserve` · `paper` (#103) · `invert`.

*Optional refinement, Phase 6, behind a flag — sentinel ink.* Inject `\usepackage{xcolor}\definecolor{tikzjaxink}{RGB}{1,1,1}\AtBeginDocument{\color{tikzjaxink}}` via `addToPreamble`. If default ink then emits as `#010101` while an author's `\draw[black]` still emits `#000`, the adapt pass becomes *exact* rather than heuristic. Ship the heuristic first; promote the sentinel only if the fixture corpus proves it — `\pgfsys@beginpicture` pushes `\special{color push gray 0}` unconditionally, so `<rect>` and `<text>` may not honour it. This is a 20-minute experiment, not a design commitment.

### 7.6 Error surface and TeX log capture

**Capture.** `WorkerHost` subscribes to the worker's `message` stream (bare strings, §5.2) into a 256-line ring buffer bound to the running worker. `data-show-console` already makes TeX emit every terminal line; we route it into `job.log` instead of `console.log`. **`input.log` is never written by this engine** (grep: 0 occurrences) — stdout is the only channel, so any plan that reads `input.log` on the failure path is reading a file that does not exist.

Once L3 is retired, `showConsole` becomes a real per-job flag driven by the debug setting (`showConsole: captureLog ? 'true' : ''` — the worker tests truthiness) and is **excluded from the cache key**. Today it is hardcoded `"true"` at main.ts:100, which both spams devtools for every diagram and, under the legacy scheme, is part of the hash.

**Classify structurally, never heuristically.** A run failed iff `texify` rejected or no `Output written on input.dvi` line appeared.

| kind | signal | shown |
|---|---|---|
| `tex-error` | first `/^!\s(.*)$/`, plus the following `/^l\.(\d+) (.*)$/` | `TikZ error: Undefined control sequence \si (line 5)` + hint |
| `missing-file` | `!TIKZJAX-MISSING-FILE <name>` (patch P4) or `File '(\S+)' not found` | `siunitx.sty is not bundled.` + capability hint |
| `capacity` | `/^! TeX capacity exceeded, sorry \[(\w+)=(\d+)\]/` | `TeX ran out of <pool> memory — reduce samples=` (#44) |
| `timeout` | race lost | `Timed out after 10 s. The engine was restarted.` |
| `empty-output` | `firstChild === null` | `TeX produced no output.` |
| **not an error** | `Overfull \hbox`, `Underfull`, package banners | diagnostics panel only |

`Overfull \hbox` — extremely common with `\node` text — must **never** produce an error card. PR #100's state machine treats any unrecognised line as the start of an error and would show a red box on a perfectly good render; that would be worse than the current broken image. TeX wraps stdout at ~79 columns, so the parser reassembles continuations before matching.

**Present.** A `.tikzjax-error` card replacing the block: the one-line message, the offending source line with a caret, a capability-driven hint from `hints.ts` + `inventory.ts`, a collapsible full log, and **Copy log / Retry / Docs** buttons. Failures go to the **session-only** poison set. Never persisted.

**Pre-flight warnings** (`source/preflight.ts`), shown as a dismissible strip above the diagram, not an error — these prevent the error instead of explaining it ten seconds later:

- source begins `\documentclass{…}` — the format dump already loads `\documentclass[margin=0pt]{standalone}` (#52, the single most common user error, and today a 10-second hang);
- no `\begin{document}` (#49's real cause);
- `\usepackage{X}` where `X ∉ INVENTORY.files` (#17, #34, #40, #56, #88, #92, #99);
- `\pgfplotsset{compat=…}` above 1.16 (#110);
- non-Latin-1 codepoints (#19, #36, #53);
- `\pgfmathsetmacro` redefining a TeX/TikZ built-in such as `\epsilon` (#96 — a case that produces *no* TeX diagnostic at all, so a lint is the only possible mechanism).

**Debug surface.** A Debug view (`ItemView`): last 100 renders with source preview, state, duration, engine, cache tier, log, retry; cache stats; engine capabilities; queue depth. A status-bar indicator **gated on `Platform.isDesktop`** (`addStatusBarItem` is documented as unavailable on mobile). And a documented Safari Web Inspector workflow in CONTRIBUTING (device Settings → Safari → Advanced → Web Inspector, then Develop over USB) — every mobile issue in the tracker is currently untriageable for want of that one paragraph. #82's reporter literally wrote *"I'm not sure if there's an easy way to get debug output from the plugin."*

### 7.7 Settings and per-block options

**Per-block options are `%!tikz` body directives, and only that.** This overrides the brief, for a correctness reason:

Obsidian keys the code-block registry on the first info-string token and passes only `(source, el, ctx)`. Reading the tail requires `ctx.getSectionInfo(el).text` — and `getSectionInfo` returns **`null`** in PDF export, embeds, hover previews and `MarkdownRenderer.render` (verified: `getSectionInfo: function(){ return null }` at both print call sites in the 1.13.7 bundle; the `obsidian.d.ts` doc comment says it "may also return null in many circumstances"). `ctx.frontmatter` is likewise unusable — it is a literal `{}` in Live Preview.

So a key-affecting option carried in the fence tail would be readable in Live Preview and invisible in export, making the **same block resolve to two different cache keys** and handing the PDF a diagram compiled with different options. Silent, intermittent, and in exactly the render path this document exists to fix. Body directives are always present in `source`, in every render path, and hash naturally.

Migration affordance: if a fence tail *is* readable via `getSectionInfo`, detect it once, show a one-time notice, and offer a **"Convert fence options to `%!tikz` directives"** command. We never *use* the value.

````
```tikz
%!tikz width=420 align=left colors=paper alt="RC low-pass"
%!tikz packages=circuitikz libraries=arrows.meta border=2pt
%:input latex/macros.tex
\begin{document}
\begin{circuitikz} … \end{circuitikz}
\end{document}
```
````

| Key | Values | In cache key? |
|---|---|---|
| `width` `max-width` `scale` `align` | CSS lengths / number / `left\|center\|right` | no |
| `alt` | quoted string → `<title>` + `role="img"` | no |
| `colors` | `adapt\|preserve\|paper\|invert` | no |
| `lazy` `timeout` | `on\|off\|manual` / seconds | no |
| `border` | TeX length → `\standaloneconfig{border=}` | **yes** |
| `packages` `libraries` `options` | comma lists → dataset fields | **yes** |
| `preamble` | vault path | **yes** (via digest) |
| `engine` | engine id | **yes** |
| `svgo` `fast` `raw` | on/off | **yes** (via `artifactRevision`) |
| `nocache` | flag — bypass L1/L2 read and write | n/a |

`%:input <path>` (PR #77's mechanism, kept) resolves with `metadataCache.getFirstLinkpathDest(path, ctx.sourcePath)` so note-relative paths work — the exact thing that confused three commenters on #77 — with recursion, cycle detection, and a **visible error** on a missing file instead of silently splicing `""`.

Preamble precedence: global setting → auto-discovered `tikz-preamble.tex` walked up from `ctx.sourcePath` (PR #100's idea) → `preamble=` directive → `%:input` expansions → block body. All of it goes through the engine's **native dataset fields** (`addToPreamble`, `texPackages`, `tikzLibraries`, `tikzOptions`), not string splicing — which eliminates PR #100's fragile `lines.splice(documentIndex, 0, …)` heuristic that mis-places the preamble whenever `\begin{document}` is absent or commented.

**Settings tab**: declarative `getSettingDefinitions()` on Obsidian ≥1.13 (which is what makes settings appear in global settings search) with a `display()` fallback for one release. Sentence case, `Setting.setHeading()`, no top-level heading.

`declare settings: TikzSettings` on the plugin class. Obsidian 1.13 added `settings?: unknown` to `abstract class Plugin`; under `target: ES2022` (`useDefineForClassFields`) a plain redeclaration would `[[Define]]` it to `undefined` at construction and clobber the base. This is a **silent runtime break on 1.13+**, not a type-checker complaint, and it is a checked release-gate item.

Also fixed here: settings.ts:58 passes an `Error` to `new Notice(err, 3000)`, which requires `string | DocumentFragment` — it compiles only because `strict` is off, and users see `[object Error]`.

### 7.8 Syntax highlighting

Keep `window.CodeMirror.modeInfo` **guarded** (`window.CodeMirror?.modeInfo`), and **splice in place** rather than reassigning the array (main.ts:114 currently reassigns, silently breaking other plugins holding a reference). It is undocumented but real: Obsidian's `hypermd` markdown mode resolves fenced languages through `CodeMirror.findModeByName` → `modeInfo`. It is also *largely moot* for `tikz`, because registering a code-block processor makes `P3.canRenderLang('tikz')` true and Live Preview renders a widget instead of highlighting — the mode is visible only when the cursor is inside the fence, and in Source mode.

Add `registerEditorExtension(StreamLanguage.define(stex))` from `@codemirror/legacy-modes` alongside it as the documented, lifecycle-managed path. Reading view is irrelevant: it replaces `<pre><code class="language-tikz">` with `div.block-language-tikz` before Prism ever sees it.

### 7.9 Export and print

**Root cause, verified in the 1.13.7 bundle:** `printToPdf` opens `window.open("about:blank","_blank","popup,hide=true")`, clones every `<style>`/`<link>` from the main head (but **not** `<script>`), forces `theme-light`, renders into `div.print`, then `if (g.length>0) await Promise.all(g); await sleep(200); ipcRenderer.send("print-to-pdf")`. Every value a code-block processor returns is pushed into `ctx.promises` (`var l = t(r,a,s); l && i.promises.push(l)`). Today's processor returns `void`, so the only wait is the hard-coded 200 ms.

So the fix is two things, and PRs #101/#109 only do the first:

1. **Per-document bootstrap from `el.doc`.** They work today only because the bundle's IndexedDB cache is same-origin, so *already-rendered* diagrams appear — which is exactly why #45's reporters see "the first 3 or 4 export", and why clearing the cache makes it worse.
2. **An async processor that awaits the mount**, plus the per-block and total export budgets of §5.4.

```ts
// Takes `app` as a parameter: Obsidian's guidelines and eslint-plugin-obsidianmd
// both forbid the global `app`; the plugin passes this.app.
const isExportContext = (app: App, el: HTMLElement) =>
  !!el.closest('.print') || el.doc !== app.workspace.containerEl.doc;
```

**Fails open**: unknown → treat as export, render eagerly. Note this is deliberately *not* `el.doc !== activeDocument` — `activeDocument` follows focus, so a background pop-out would be misclassified. Failing open costs a little extra compilation; failing closed costs blank PDFs.

**Getting SVGs out** (#21, #33, #95, #97) — `freezeSvg(template, {ink, paper, opaque})`: clone; stamp `style="color:#000"` on the root (resolving every `currentColor`, including inside `<pattern>`/`<marker>` content); replace `.tz-paper-*` classes with literal fills; **inline only the `@font-face` rules the SVG actually references** (a typical diagram uses ~12 of the 140 faces) — mandatory, because dvi2html emits real `<text font-family="cmr10">` and an SVG loaded as a file or an image gets none of Obsidian's stylesheet; re-add `xmlns`/`xmlns:xlink`; optionally prepend an opaque paper `<rect>`; serialise with `XMLSerializer`.

Commands: **Copy SVG**, **Save SVG to vault** (`fileManager.getAvailablePathForAttachment` + `vault.createBinary`), **Finalize diagrams in this note** (write attachments, rewrite the block to `![[name.svg]]` followed by the original fence wrapped in `%% … %%`, via `vault.process` + `getSectionInfo`), and its inverse **Un-finalize**.

**Obsidian Publish** (#37, #47): no plugin-side fix is attempted or possible — Publish runs zero community plugins. Finalize *is* the answer, and it is strictly better for visitors than shipping 7 MB of WASM TeX per page view. Document it; close both.

### 7.10 Mobile budgets

Beyond §5.4:

- **styles.css split (Phase 1):** 12 core WOFF2 faces stay in `styles.css` (~200 KB); the other 128 become a **cold string constant in `main.js`**, injected per-`Document` on first render. Startup CSSOM parse drops from 4,791,337 B to ~0.2 MB. This is the installable form of the mobile fix — sibling asset files do not reach store users.
- **Copy count:** the 7 MB worker source is a cold string materialised **once** into a Blob (revoked on terminate) instead of four times (main.js literal → DOM text node → module-147 string → Blob).
- **`textContent`, not `innerText`** for any large string assignment.
- **Teardown** on `visibilitychange → hidden`: terminate the worker, clear L1. WebKit discards JIT code at 65 % memory pressure and reloads the page at 100 %; being near-zero while backgrounded is the difference between surviving and being jetsam-killed (#111).
- **Guards** for `window.CodeMirror?.modeInfo` and `floatingSplit?.children` — both throw unguarded in `onload`/`onLayoutReady` and produce exactly `Failed to load plugin` (#74).
- `isDesktopOnly` stays `false` **only if** the iOS smoke test passes at each release.

### 7.11 Fast mode, accessibility, i18n, privacy

**Fast mode — defined, because "a fast mode" was a stated goal and elsewhere in this document it exists only as a table row.** `fast` is a *preset*, not a fourth SVGO value: it sets `svgo: off`, skips the mount-time `fonts.ready` + `getBBox()` measurement (mounting with the engine's viewBox, so geometry is uncorrected and `viewBox` is left `null` in the record rather than persisted wrong), skips the pre-flight lint, and raises the block's queue priority by one band. It never skips `sanitize` and never skips `ids`. Because `svgo` participates in `artifactRevision`, a block toggled to fast mode is a different key — that is intended: fast artifacts and full artifacts coexist rather than overwrite. Global setting plus `%!tikz fast`. Measured value: it removes the 8.2 / 43.0 / 267.7 ms SVGO pass and one forced style/layout flush per new diagram.

**Accessibility.** Currently zero: an `<svg>` with no accessible name, and failures that are an image of a broken image.
- `alt="…"` (§7.7) emits `<title id=…>` as the SVG's first child plus `role="img"` and `aria-labelledby`; with no `alt`, the SVG gets `role="img"` and `aria-label` derived from the first `
ode` text, or `aria-hidden="true"` when the block is purely decorative and the author says so (`%!tikz alt=""`). A `<title>` also gives sighted users a tooltip and makes a saved `.svg` self-describing.
- The placeholder is `aria-busy="true"` and carries no animation under `@media (prefers-reduced-motion: reduce)`.
- The error card is a `<div role="group" aria-label="TikZ error">` containing a static message (**not** `role="alert"`: a 40-block note would fire 40 live-region announcements on open), with real `<button>` elements for Retry / Copy log / Docs so they are keyboard reachable and focus-visible.
- The zoom modal (§ Phase 7) uses Obsidian's `Modal`, which already traps focus and closes on Escape; the pan surface gets keyboard arrow/+/− handlers, since drag-only is unusable without a pointer.
- Contrast: `--tikz-ink` defaults to `--text-normal`, so diagrams inherit whatever contrast the user's theme guarantees; `is-paper` pins `#000` on `#fff`. No colour is ever the *only* carrier of meaning we introduce — the degraded-mount signal is a chip with text, not a coloured border.

**i18n.** Obsidian exposes no plugin translation API and no locale-bundle convention; `moment.locale()` and `window.localStorage.language` exist but nothing consumes them for plugins. We therefore do not ship translations, and we do not pretend to: the commitment is that **every user-visible string lives in `ui/strings.ts`** (a plain object, no string concatenation into sentences, no English word order baked into a template), so a future contributor can add a locale map without touching render logic. Error text from TeX is passed through untranslated — it is the transcript.

**Privacy / telemetry.** The plugin makes **zero network requests** and this is an invariant, not a policy statement: patch P0 removes the only outbound request in the shipped payload (defect 18), and CI greps the built `main.js` for `fetch(`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket` and `//`-prefixed URLs outside the vendored TeX sources, failing the build on a new hit. No analytics, no crash reporting, no version ping. "Copy log" copies to the clipboard; nothing is ever uploaded. This is worth stating explicitly because the plugin executes user content in an Electron renderer and users cannot audit a 7 MB blob themselves.

---

## 8. Compatibility and migration

### 8.1 Existing ```` ```tikz ```` blocks

The user source contract does not change. Users keep writing their own `\begin{document}` / `\end{document}` (README:29). No auto-wrapping, no document-environment injection. Anything that would change the meaning of an existing block is opt-in.

### 8.2 The source-contract change, and its compatibility flag

`normalizeSource` fixes real defects (main.ts:121 removes the `&nbsp;` *entity* rather than U+00A0; main.ts:127 trims leading whitespace; main.ts:130 **deletes every blank line**, i.e. every `\par`). Fixing #130 in particular **changes the rendered output of existing diagrams** — a `\par` that was silently swallowed now takes effect.

Mitigation: `source/legacy-tidy.ts` is a frozen, byte-for-byte copy of main.ts:117-134, retained for one release behind a setting (`Source handling: legacy | corrected`), defaulting to `corrected` with a one-time Notice explaining the change and pointing at the setting. It is also required permanently by L3 (§8.3), because the legacy key hashes the legacy tidy output.

### 8.3 The existing localForage cache — L3 read-through

**This is the migration story, and it is a Phase 2 blocker, not a nicety.** Without it, every user's vault recompiles from scratch on upgrade — at ~68.75 MiB per render, concurrency 1, on the very iOS devices reported crashing in #111. That is not an upgrade; it is an incident.

`cache/legacy-key.ts` is a **frozen** reimplementation of the bundle's key:

```ts
// FROZEN. Never edit. Reproduces tikzjax.js @7030025 exactly.
const LEGACY_DATASET = { showConsole: 'true' };     // main.ts:99-102 sets exactly one dataset key
export const legacyKey = (src: string) =>
  md5(JSON.stringify(LEGACY_DATASET) + legacyTidyTikzSource(src));
```

Every input is verified: the plugin sets exactly one data attribute, so `JSON.stringify(el.dataset)` is deterministically `{"showConsole":"true"}` with no property-order hazard; and the bundle stores `r.outerHTML` **before** `dispatchEvent`, i.e. the raw, pgf-id-namespaced, pre-SVGO SVG.

On an L1/L2 miss, while the L3 window is open, we compute the legacy key and read `TikzJax/svgImages`. A hit is run through the **full new pipeline** — stage 3 re-placeholders the baked `pgf<md5>` ids, so imported artifacts come out instance-safe, and the corrected SVGO overrides (`convertToPx:false`, `removeViewBox:false`) *do* apply on import because the cached bytes are pre-post-process. The result is written to L2 and the legacy record is deleted. The old database is dropped once drained, or after 30 days, with a one-line Notice reporting reclaimed bytes.

**The L3 gate, stated precisely.** L3 fires only when the effective **user** preamble is empty — no global preamble, no `preamble=` directive, no `%:input`, no `packages`/`libraries`/`tikzOptions` directives, and no `border`. Plugin-injected `\nonstopmode` does **not** count against the gate: it changes only error behaviour, never the output of a successful compile, and a legacy record by definition *is* a successful compile.

**This is why `border` defaults to `null`.** Injecting `\standaloneconfig{border=2pt}` by default would make the effective preamble non-empty for every block, permanently disabling L3 in the same release that promises "no recompiles". Geometry is instead fixed at mount time from the measured ink bbox (§7.4), which needs no TeX-side margin at all. `border` remains available as an opt-in per-block directive.

Every imported record is keyed **honestly**: `origin: 'legacy-import'`, `baked: { border: null, … }`, `engineId: ENGINE_ID`. If a user later turns on a border or a preamble, the key changes and that diagram re-renders lazily — no silent mixing of bordered and unbordered output under a key that claims otherwise.

### 8.4 Existing settings

`data.json` is read forward with a `settingsVersion` and per-version migrations. `invertColorsInDarkMode: true` maps to `colors: 'adapt'`; `false` maps to `colors: 'preserve'`. No setting is silently dropped. `Plugin.onExternalSettingsChange()` handles a Sync-driven change.

### 8.5 The plugin id

`obsidian-tikzjax`, never renamed. `manifest.json`'s *description* is updated (#32); the id, folder and data path are stable forever.

### 8.6 Obsidian Sync, Publish, and multi-device reality

- **Settings** (`data.json`) sync. `onExternalSettingsChange()` (§6.1) is the hook; a Sync-delivered change re-derives `artifactRevision` and drops L1 rather than serving artifacts built under the old settings. A migration must therefore be **idempotent and forward-tolerant**: a newer device may write a `settingsVersion` an older device has never seen, and the older device must ignore unknown keys and preserve them on write-back instead of dropping them (this is the standard way plugin settings get silently destroyed on mixed-version installs).
- **The cache is deliberately device-local.** IndexedDB is not synced by Obsidian Sync and must not be reimplemented inside the vault: at 24-64 MB of SVG it would dominate a Sync quota, and artifacts are cheap to regenerate but expensive to transfer. A user with three devices pays three first renders per diagram; the mitigation is **Finalize** (§7.9), which writes a real `.svg` attachment that *does* sync and is then free everywhere, including on Publish and in exports.
- **Finalize interacts with Sync.** It writes attachments and rewrites note bodies via `vault.process`; running it on two devices concurrently produces a Sync conflict on the note. Finalize therefore runs note-at-a-time with an explicit confirmation naming the count, is undoable (**Un-finalize**), and never runs automatically.
- **Plugin updates cost 12 MB of sync traffic per release** for users who sync `.obsidian/plugins` (a supported Sync option, off by default). This is an argument for *fewer, larger* releases on the shipped payload — and one more reason the Phase 1/5 size work (styles.css split, WOFF2) is a user-visible feature and not internal tidiness.
- **iOS storage eviction.** WebKit can evict the whole IndexedDB store under pressure or after prolonged non-use; the plugin must treat an empty L2 as normal (it re-renders lazily), never as corruption, and must not surface it as an error.

---

## 9. Toolchain

### 9.1 Versions (all verified against the npm registry)

| | Version | Note |
|---|---|---|
| typescript | **5.9.3** | not 7.x — `typescript-eslint@8` peers cap at `<6.1.0` |
| esbuild | **0.28.2** | `context()` + `watch()`; `with { type: 'text' }` replaces `esbuild-plugin-inline-import` |
| obsidian | **1.13.1** pinned | never `"latest"` |
| eslint | 10.9.1 + `@eslint/js` 10.0.1 | |
| typescript-eslint | 8.68.0 | |
| eslint-plugin-obsidianmd | 0.4.2 | verified working on ESLint 10 with `--legacy-peer-deps` / `overrides` |
| prettier + eslint-config-prettier | 3.9.6 | Prettier over Biome specifically because the obsidianmd plugin is an ESLint plugin |
| vitest + @vitest/coverage-v8 | 4.1.11 | |
| happy-dom | 20.12.0 | per-file `// @vitest-environment happy-dom` only |
| svgo | 4.1.0 via `svgo/browser` | only while `preset` mode survives; **rename `cleanupIDs` → `cleanupIds`** |
| node-tikzjax | 1.0.5 | devDependency, opt-in engine smoke suite |
| Node | 24 (Krypton LTS) | `engines` + CI |
| **Removed** | `pako`, `@types/pako` (never imported), `tslib`, `builtin-modules`, `esbuild-plugin-inline-import`, the eleven dead `@codemirror/*` externals | |

### 9.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": [],
    "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
    "noImplicitReturns": true, "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true, "noUnusedParameters": true,
    "isolatedModules": true, "verbatimModuleSyntax": true, "erasableSyntaxOnly": true,
    "forceConsistentCasingInFileNames": true, "skipLibCheck": true, "noEmit": true
  },
  "include": ["src/**/*.ts", "types/**/*.d.ts"]
}
```

`baseUrl`, `moduleResolution: node` and `allowJs` are all removed: the first two are gone in TS 7, and `allowJs` currently drags the 587 KB minified SVGO blob into the compiler program on every build. `types: []` keeps `@types/node` globals out of a browser plugin (otherwise `setTimeout` resolves to the Node overload returning `NodeJS.Timeout` — which will bite the moment per-diagram timeouts land; use `window.setTimeout`).

Enabling `strict` surfaces exactly nine errors on today's source, four of which are real bugs, including `s.remove()` on a possibly-null element (main.ts:57) and the SVGO `cleanupIDs` type mismatch.

### 9.3 esbuild config

`esbuild.context()` + `watch()`; `format: 'cjs'`; `platform: 'browser'`; `target: 'es2022'`; `minify: prod` (saves 281 KB — the current config has **no** `minify` key at all); `sourcemap: prod ? false : 'inline'`; `legalComments: 'none'`; externals = `obsidian`, `electron`, the eight real `@codemirror/*`, the three `@lezer/*`, plus `builtinModules` from `node:module`. A `deploy` plugin honours `OBSIDIAN_PLUGIN_DIR` and writes `.hotreload`.

### 9.4 CI (`ci.yml`, on PR + push, `ubuntu-latest`, Node 24)

```
npm ci
lint            eslint 10 + eslint-plugin-obsidianmd
typecheck       tsc --noEmit
test            vitest run
golden          RUN_GOLDEN=1 vitest run
build           esbuild production
engine-guard    sha256sum -c vendor/CHECKSUMS
patch-guard     every worker patch matched EXACTLY ONCE (0 or 2+ fails the build)
size-guard      main.js < 8 MB; after Phase 1, styles.css < 400 KB
version-guard   tag == manifest.version == a versions.json entry
```

`version-guard` exists because `versions.json` is `{"0.1.0":"0.12.0"}` while the manifest says `0.5.2` — five releases of drift, because nothing ever verified it. `patch-guard` and `engine-guard` are the discipline that makes depending on string surgery over a minified blob defensible: a checksum catches an edited blob, only the match assertion catches a patch that silently became a no-op.

### 9.5 Release (`release.yml`, on tag)

`actions/checkout@v7` (`fetch-depth: 0`) + `actions/setup-node@v7` → `npm ci` → version-guard → build → `actions/attest@v4` over `main.js manifest.json styles.css` → `gh release create "$tag" --draft --generate-notes`. Replaces archived `actions/create-release@v1` / `upload-release-asset@v1` and the `::set-output` line GitHub disabled in 2023 (which is why the zip currently uploads as `obsidian-tikzjax-.zip`). Keep `.npmrc`'s `tag-version-prefix=""` — Obsidian requires unprefixed tags.

### 9.6 Dev loop into a real vault

```bash
OBSIDIAN_PLUGIN_DIR="$HOME/vaults/dev/.obsidian/plugins/obsidian-tikzjax" npm run dev
```

esbuild creates the directory, copies `manifest.json` + `styles.css`, and drops a `.hotreload` marker; **pjeby/hot-reload 0.3.1** in that vault reloads the plugin ~0.75 s after writes stop. Symlinking is the fragile option on Windows (needs elevation or Developer Mode). A `.env.example` and a README *Development* section make this discoverable — today the only build guidance lives in issue #68.

### 9.7 Licensing of the vendored payload, and store review

**This is an unresolved blocker, not a formality, and it is nowhere in the upstream tracker.** `LICENSE.md` is MIT and `package.json` says `"license": "MIT"`, but the three shipped files embed third-party work that MIT does not describe:

| Vendored input | What it is | Licence | Consequence |
|---|---|---|---|
| `tikzjax.js` (7.03 MB) | web2js/TeX-in-WASM + dvi2html + a base64 `core.dump` and 212 `tex_files` | TeX/Knuth licence for the engine; **PGF/TikZ is dual GPL-2+ / LPPL 1.3c**; circuitikz, chemfig, pgfplots, tikz-cd each carry their own (mostly LPPL/GPL) terms | An MIT-only claim over a build that contains GPL'd `.tex` sources is at best incomplete. Needs a real answer before 1.0. |
| `styles.css` (4.79 MB) | 140 base64 TrueType faces (Computer Modern / AMS / rsfs family) | Knuth / AMS / SIL-style terms, per face | Redistribution is permitted but generally requires the notices to travel with the fonts. WOFF2 conversion in Phase 5 is a *modification* of those files and inherits the same obligation. |
| `svgo.browser.js` (587 KB) | SVGO 2.x | MIT | Requires the copyright notice to ship. It currently does not. (Deleted outright if `targeted` clears the iOS gate — the cheapest resolution available.) |

Required work, none of it large: a `vendor/LICENSES/` directory carrying each upstream licence verbatim; a `NOTICE` file listing every embedded component with upstream URL, version and licence; `vendor/README.md` (already planned for provenance) extended with the licence column; the README's licence section stating that the *plugin source* is MIT while the *distributed bundle* aggregates the terms above; and `gen-inventory.mjs` emitting the licence of each bundled package alongside its version, so the table cannot silently drift after an E1 rebuild. **Open decision for the maintainer:** whether the aggregate obligation of the GPL'd `.tex` sources inside a single distributed `main.js` is satisfied by a NOTICE plus source availability, or whether the payload must be restructured. This document cannot settle that; it must not be discovered during store review.

**Community-store review rules the design must satisfy** (they gate publication, and several are already violated today):
- No `innerHTML` / `outerHTML` / `insertAdjacentHTML` assignment (main.ts:183 today; removed by §7.2's DOM pipeline — but note Phases 0-1 still ship it, see §12).
- No global `app`; use `this.app` (§7.9 corrected).
- All listeners and observers registered for teardown: `registerEvent`, `registerDomEvent`, `register(() => observer.disconnect())` — this includes the `visibilitychange` handler, every `IntersectionObserver`, and the worker.
- Settings: sentence case, no plugin name in headings, `setHeading()` not `<h2>`, no top-level heading.
- Commands: no "TikZJax:" prefix (Obsidian prefixes automatically).
- `manifest.json`: `minAppVersion` truthful (today `0.12.0` against APIs that did not exist then), `versions.json` entry per release, `fundingUrl` optional, `isDesktopOnly` honest.
- A LICENSE file at the repo root (present).

**Dependency-resolution caveat CI must handle.** `eslint-plugin-obsidianmd@0.4.2` declares peers `{ eslint: ">=9.19.0", "@eslint/js": "^9.30.1", "@eslint/json": "0.14.0", obsidian: "1.8.7", "typescript-eslint": "^8.35.1" }` — an *exact* pin on `obsidian` and a caret on `@eslint/js` 9, both of which the stack in §9.1 (obsidian 1.13.1, `@eslint/js` 10.0.1) violates. Plain `npm ci` will fail on peer resolution, so `package.json` must carry explicit `overrides` for those two peers (never `--legacy-peer-deps` in CI, which disables peer checking wholesale and would hide a real conflict later). `typescript` is pinned at **5.9.3** although 7.0.2 is current, because `typescript-eslint@8.68.0` declares `typescript: ">=4.8.4 <6.1.0"` — verified against the registry; revisit when typescript-eslint ships TS 7 support.

---

## 10. Testing strategy

**Runner:** Vitest, `environment: 'node'` by default, `obsidian` aliased to a hand-written ~40-line runtime stub. Per-file `// @vitest-environment happy-dom` for the two files that legitimately need a document (`svg/serialize.ts`, `block/mount.ts`).

**Hard design constraint discovered in recon:** neither jsdom 30 nor happy-dom 20 implements `SVGTransformList.consolidate()`. The transform pipeline must therefore be pure functions over a parsed document with our own matrix math, never browser-only SVG DOM APIs. `getBBox()` is the one exception, and it lives in `svg/measure.ts` — deliberately outside the testable pipeline, covered by the manual matrix.

### 10.1 Unit-tested (pure, fast, the bulk)

| Module | Assertions |
|---|---|
| `normalize` | real U+00A0 / U+2007 / U+202F / U+200B / BOM / CRLF; **blank lines preserved**; the `&nbsp;` entity as a secondary case |
| `legacy-tidy` | byte-identical to main.ts:117-134 on a corpus of real sources — this file must never drift |
| `directives` | grammar, quoting, unknown keys warn, presentation vs baked split, stripped before hashing |
| `key` | stability across dataset key order; sensitivity to **each** included input; **insensitivity to theme and scale**; `artifactRevision` boundary |
| `legacy-key` | reproduces real keys dumped from a populated `TikzJax/svgImages` store |
| `queue` | injected clock: priority ordering, dedup, refcounted cancel, depth cap → manual demotion, backpressure kill, no starvation, **every job settles** under randomised fault injection |
| `machine` | exhaustive transition table; **property test: exactly one `settle()` on every path**, including randomised abort/timeout/throw interleavings |
| `log-parse` | fixture transcripts: undefined control sequence with `l.NN`, missing file, `TeX capacity exceeded`, 79-column wrapped continuations, and — critically — that `Overfull \hbox` yields **no** error |
| `preflight` | each of the six lint rules, and that a clean source yields zero warnings |
| `ids` | `url(#…)` inside `style`, `xlink:href`, markers, masks; nonce stamping produces one nonce per mount, not per match |
| `colors` | all four emitters incl. unquoted `style="color: black"`; gradient stops untouched by default |
| `geometry` | viewBox arithmetic |
| `store` | LRU by count and bytes; eviction order; lazy schema eviction (no startup wipe) |
| `rpc` | fake `MessagePort`: result / error / uncaughtError / **bare-string routing** / uid correlation |
| `sanitize` | `<script>`, `<foreignObject>`, `onload=`/`onclick=`, `href="javascript:"`, `xlink:href="http://…"` are all removed; a legitimate `url(#clip)` / `xlink:href="#glyph"` survives untouched; a fixture built from a real `special{dvisvgm:raw …}` block is neutralised and flagged degraded |
| `freeze` | `currentColor` resolves; paper classes become literals; the `@font-face` subset is exactly the referenced faces; output parses standalone |

### 10.2 Golden-tested

`test/fixtures/*.svg`, captured from the **shipped** engine and committed: plain tikzpicture, node text, `\frac` (rules), tikz-cd, circuitikz op-amp (the #60/#61 font regression), chemfig, pgfplots axis, a `ball color` shading, a `\fill[white]` knockout on a coloured background (#15's reproducer), a two-diagram id-collision case, and `$\Omega\otimes$` (the #2 soft-hyphen remap guard).

Pipeline output is snapshotted byte-exact. **The Phase 2→3 refactor must be provably byte-identical on this corpus before any behaviour change lands**, and the Phase 1 engine patches (P1/P2/P2b) must be byte-identical too. Additional golden gates: after `optimize()` ids are unchanged (the `cleanupIDs`/`cleanupIds` landmine); every `font-family` the pipeline emits is defined in the shipped font CSS (the print/PDF regression guard).

### 10.3 Engine smoke (opt-in, `RUN_GOLDEN=1`)

`node-tikzjax@1.0.5` renders pgfplots headlessly in ~1.3 s. **Shape-level assertions only** — it uses `@prinsss/dvi2html`, not the drgrice1 fork we bundle, so never assert byte equality against it. Covers: renders at all, contains `<path>`, a deliberately broken source rejects with a transcript containing `^! `, empty source, and a runaway source (the timeout path).

### 10.4 Manual QA checklist (release gate — the part that matters most)

- [ ] **iOS device:** enable plugin → open Settings (the #111 crash path, which happens before anything renders) → open a 20-diagram note → scroll → background the app → foreground → export.
- [ ] Reading view · Live Preview · Source mode · pop-out window · embed (`![[note]]`) · table cell · collapsed callout · hover preview — crossed with light / dark.
- [ ] **PDF export** of a 12-diagram note, cold cache, in **both** light and dark theme.
- [ ] Theme toggle: assert **zero recompiles** via the debug panel.
- [ ] Live Preview ↔ Reading switch on a note with 20 diagrams: assert zero recompiles.
- [ ] Type inside a diagram for 30 s: assert one compile, not thirty.
- [ ] A vault with a **pre-existing legacy cache**: upgrade, open a note, assert zero TeX compiles (the L3 path).
- [ ] A deliberately broken diagram: assert an error card, assert other diagrams still render, assert Retry works.
- [ ] Disable → re-enable the plugin; assert no leaked worker, no duplicate `modeInfo` entry, no orphaned `<style>`.
- [ ] Copy SVG → open the file in a browser: assert colours and glyphs are correct outside Obsidian.
- [ ] A block containing `special{dvisvgm:raw <script>…}`: assert nothing executes, in a fresh render **and** on a cache hit, and that the degraded chip explains why.
- [ ] Two vaults open on desktop: assert each has its own cache store and that "Clear all" in one does not empty the other.
- [ ] Screen reader (VoiceOver / NVDA) over a note with a captioned diagram, an uncaptioned diagram and an error card.
- [ ] Devtools Network tab across a full session including a failing diagram: assert **zero** requests.
- [ ] **Finalize a fence written directly under a line of text**, with no blank line between them, then un-finalize. Assert the embed renders as an embed, the `%%` opens a comment rather than showing the TeX as visible text, and the note comes back byte for byte. This is the open question in the header of `src/note/finalize.ts`: no blank line is inserted because inserting one would make un-finalize inexact, and whether that matters is a fact about Obsidian's parser rather than about CommonMark.

---

## 11. Risks and open decisions

### 11.1 Risks we accept, with mitigations

| Risk | Mitigation |
|---|---|
| Build-time string surgery on a minified blob breaks on an upstream bump. | Pinned SHA-256 **plus** exactly-one-match assertions per patch; both fail the build, never silently. |
| The `targeted` SVGO transform mislays text on iOS, where nobody is watching. | Ships opt-in; `preset` stays default until #6 is reproduced on a device against a fixture. |
| `\nonstopmode` may not eliminate the interactive-prompt hang. | Terminate-and-respawn is the guarantee; `\nonstopmode` is only the optimisation. |
| The iOS memory ceiling may still be exceeded after Phase 5. | Phase 1 ships the debug panel and timings, so it becomes *measurable* for the first time. |
| The deadlock class survives to Phase 4 (~28-36 dev-days). | Phase 2 ships the session poison set + the honest Notice, so one wedging diagram degrades to one dead diagram rather than a dead vault. |
| `LegacyScriptHost` is ~8 days of work deleted one release later. | Accepted deliberately: it is the bisect boundary that makes a Phase 4 regression revertible to something that works. |
| The colour pass is heuristic, not semantic. | `colors=preserve` per block; the sentinel-ink experiment is gated on the corpus, not shipped on faith. |
| The vendored payload's licences are not represented by the repo's MIT licence (§9.7). | NOTICE + `vendor/LICENSES/` + generated per-package licence column; escalated to the maintainer as an explicit pre-1.0 decision rather than discovered at store review. |
| The sanitizer strips markup a legitimate `dvisvgm:raw` user depends on. | Removal is visible (degraded chip naming what was removed), never silent; the escape hatch is Finalize-to-attachment, not an "allow scripts" setting — which we will not add. |
| Re-splicing patched module 147 into the bundle string proves unstable. | The round-trip assertion fails the build; patches and their acceptance criterion move to Phase 4 (§4.4). No silent no-op. |
| A solo developer stalls mid-roadmap. | **Phases 0-4 are the 1.0 floor**; 5-8 are optional. A stall after Phase 4 lands somewhere defensible. |

### 11.2 Open decisions that need the user's input

These are listed in §13 of the executive summary; each is a judgement call a careful engineer cannot make alone.

---

## 12. Implementation roadmap

Each phase ships to the community store on its own and is independently revertible. **Phases 0-4 are the 1.0 floor (~28-37 dev-days). Phases 5-8 are optional.**

Two clarifications, because "floor" and the version labels below disagree on their face. The *floor* is the minimum set below which this work is not worth calling finished; the `1.0.0` **tag** is attached at Phase 6, when per-block and per-vault preamble support makes the plugin genuinely configurable. A stall after Phase 4 therefore ships as `0.10.x` — defensible, complete against every promise in §1.1, and not labelled 1.0. And "independently shippable" is true of the *user-visible* increments but not of the build: Phase 2 depends on Phase 1's generated `inventory.ts` and on the frozen legacy key, Phase 3's geometry depends on Phase 2's artifact record, and Phase 4's cache continuity depends on Phase 1's `ENGINE_ID` already being computed over the *patched* source (§4.4). The order is not interchangeable; only the stopping points are.

### Phase 0 — Stop the bleeding · 2-3 d · v0.6.0
*No architecture, no cache change, no dataset change.*

`doc.createElement` (main.ts:45); `textContent` not `innerText`; `s?.remove()` (main.ts:57); `WeakSet<Document>` idempotence; `this.loadTikZJax(el.doc)` from the processor → diagrams appear in PDF export **if already cached**; move the `tikzjax-load-finished` listener from `document` to `el` (it bubbles and reaches `el` even while detached); `window.CodeMirror?.modeInfo` and `floatingSplit?.children` guards; splice `modeInfo` in place; try/catch around `postProcessSvg`; a **minimal sanitizer** before the assignment (strip `<script>`, `<foreignObject>` and `on*` attributes — defect 17 is reachable today via `special{dvisvgm:raw …}`, and the bundle's own cache-hit path uses `createContextualFragment`, which *does* execute injected scripts); handle SVGO's `{error}` return shape instead of `@ts-ignore`ing `.data`; SVGO overrides `removeViewBox:false` + `convertToPx:false`; empty-source guard; `@media print { break-inside: avoid }` + an unscoped `.block-language-tikz svg` rule. README **Known limitations** section (the honest-boundary list, with named causes and workarounds) and the docs closures.

Note what Phase 0 deliberately does **not** fix: `outerHTML` assignment survives until Phase 2 (§7.2 replaces it with the DOM pipeline), and the outbound request on the failure path survives until the Phase 1 P0 patch. Both are named here so neither is mistaken for done.

**Acceptance:** #74 no longer reproduces on iOS; reading-mode diagrams are colour-processed 100 % of the time on a 40-block note; an empty ```` ```tikz ```` block does not wedge the session; `npm run build` succeeds on Node 24. **Closes:** #74 #102 #93 #87 #29 #1 #16 #31 #43 #57 #72 #84; partial #45 #114 #42 #66 #15. (Not #50: the unscaled nested `tikzpicture` chemfig 1.4 emits is unreachable from CSS — it stays an E1 item.)

### Phase 1 — Toolchain, harness, safe engine patches, mobile launch cost · 5-6 d · v0.7.0
*Zero observable behaviour change, enforced by golden tests.*

esbuild 0.28 `context()` + `with {type:'text'}` + `minify`; TS 5.9 strict; ESLint 10 flat + obsidianmd; vitest + the fixture corpus; CI + release workflows; `versions.json` repaired; truthful `minAppVersion`; dead deps removed; lockfile regenerated at v3. Build-time worker extraction with SHA + exactly-one-match asserts; **patches P0, P1, P2, P2b** gated on byte-identical corpus output, and the **module-147 re-splice** that makes them actually reach the code Phases 1-3 run (§4.4) — without it the memory acceptance below is unobservable. **styles.css split**: 12 core faces stay; the other 128 become a cold string injected per-`Document` on first **mount** — not on first *render*. The distinction is load-bearing: an L1/L2/L3 hit mounts without rendering, and an export popup mounts cached diagrams almost exclusively, so keying injection on render would ship PDFs with fallback glyphs. The injection point is `mount.ts`, guarded by a `WeakSet<Document>`, and it is covered by the golden gate "every `font-family` the pipeline emits is defined in the shipped font CSS".

**Acceptance:** corpus byte-identical before/after; `main.js` < 8 MB and `styles.css` < 400 KB in CI; peak worker memory per render drops by ≥ 68 MiB (measured in the debug panel); `npm ci` works. **Closes:** part of #3 #7 #111 #91 #5. Regression-guards the three already-resolved items the "fixed" partition carries but no phase otherwise touches — **#2** (soft-hyphen glyph remap) and **#60/#61** (cmmib5 metrics) become golden fixtures here, which is the only thing that stops an E1 rebuild from silently undoing them.

### Phase 2 — Own the block · 8-10 d · v0.8.0

`TikzBlock extends MarkdownRenderChild` + `ctx.addChild`; the pure state machine with the settle invariant; **async processor returning an awaited promise**; the `TexHost` seam with `LegacyScriptHost` behind it (per-job staging wrapper); L1+L2 (database `obsidian-tikzjax-<app.appId>`, quota-error tolerant) storing the **post-processed, sanitized** artifact with `__TZ__` placeholders; **L3 legacy read-through**; `normalizeSource` + `legacyTidy` flag; `%!tikz` directive parser (presentation keys wired); per-mount id stamping; sized placeholders; viewport gate + zero-record escape hatch + queue + debounce + poison set; export detection + per-block and total export budgets; generated `inventory.ts` + pre-flight warnings; the quiver `\tikzset` shim; debug panel; desktop-only status bar.

**Acceptance:** a 12-diagram note exports to PDF completely from a cold cache; upgrading a vault with a populated legacy cache produces **zero** TeX compiles on first open; the same block in two panes compiles once and mounts with distinct ids; typing for 30 s in a diagram produces one compile; a wedging diagram no longer prevents other diagrams from being *attempted*. **Closes:** #45 #114 #101 #109 #12 #15 #58 #90 #98 #52 #49 #67 #80 #106 #96(partial); mitigates #24 #82.

### Phase 3 — Colour, geometry, SVG pipeline · 5-6 d · v0.9.0

Delete `colorSVGinDarkMode`; the four-emitter ink/paper DOM pass + CSS tokens + double print pinning; gradient exemption; mount-time `fonts.ready` + `getBBox()` correction persisted to L2; wrapper-level width/align/scale; SVGO modes with corrected overrides + the `targeted` transform behind the iOS gate; `MOUNTED(degraded)` + warning chip; `raw` escape hatch.

**Acceptance:** a theme toggle costs zero recompiles (asserted in the debug panel); #15's `\fill[white]`-on-orange reproducer renders correctly in both themes and in an exported PDF; corpus geometry matches measured ink bounds within 0.5 pt; SVGO on/off produces visually identical fixtures. **Closes:** #38 #103 #73 #66 #71 #14 #26 #42 #48 #21 #97 #105 **#6** (SVGO becomes optional and the `targeted` transform lands — but the *default* does not move until #6 is reproduced on a device, so #6 closes as "addressed, gate pending"); colour half of #93 #87.

### Phase 4 — Own the engine · 8-12 d · v0.10.0 · **1.0 floor**
*Highest risk, deliberately last among the core phases so a regression is bisectable.*

`WorkerHost` + `rpc.ts` (bare-string log routing); per-job log capture; structural error classification + capability-driven error cards; **real timeout → `terminate()` + respawn**; cancellation; `\nonstopmode`; blob URL revoked; patches P3, P4; `showConsole` becomes a real per-job flag excluded from the key; **no `<script>` injected into any document**; `LegacyScriptHost` retained one release behind a hidden setting; "Render this block with engine X" debug command.

**Acceptance:** a deliberately non-terminating diagram times out, shows an error card, and **every other diagram on the page still renders**; `\si{\ohm}` produces `TikZ error: Undefined control sequence \si` plus the siunitx capability hint rather than a broken image; `Overfull \hbox` produces no error card; disabling the plugin terminates the worker. **Closes:** #18 #23 #27 #39 #51 #82 #85 #89 #81 #100 #24 #64. It also unblocks a repro for **#107**, which is blocked on a diagnostic that does not exist today — #107 itself stays an E1 item.

### Phase 5 — Mobile diet round 2 · 4-6 d · v0.11.0

TTF → WOFF2 (≈50 % smaller, glyph-identical); single Blob materialisation; idle + `visibilitychange` teardown; mobile budgets enforced; on-device measurement pass.

**Acceptance:** iOS smoke test passes on the #111 reporter's path; measured peak WKWebView footprint during a 20-diagram note is documented in CONTRIBUTING. **Closes:** remainder of #111 #91 #7 #24 #3.

### Phase 6 — Preamble, options, settings · 4-5 d · v1.0.0

Global preamble; walk-up `tikz-preamble.tex`; `%:input` with link-path resolution, recursion and cycle detection; dependency tracking + invalidation; the key-affecting `%!tikz` directives; declarative settings tab; fence-tail migration detector + convert command; the sentinel-ink experiment behind a flag.

**Acceptance:** editing a preamble file re-renders exactly the dependent blocks; a block with a preamble exports to PDF with the same key it used in Live Preview. **Closes:** #46 #76 #77 #83.

### Phase 7 — Export, finalize, zoom · 4-5 d · v1.1.0

`freezeSvg` with font subsetting; Copy/Save SVG; Finalize / Un-finalize; render-note / render-vault; zoom modal.

**Acceptance:** a saved `.svg` opened in a browser matches the in-app rendering in both palettes. **Closes:** #33 #95 #104 #37 #47.

### Phase 8 — Post-1.0, optional · 6-10 d

Patches P5 (VFS injection → user `.sty` and data files) and P6 (stop clearing `cq`, behind a setting for one release since it changes VFS lifetime); two-pass TeX behind a per-block flag; the engine registry and an opt-in second `TexHost`.

**Closes:** #4 #13 #9 #70.

### Parallel tracks (no plugin code, independently schedulable)

- **Spike S1 — pgfplots libraries · 3-5 d.** pgfplots 1.16 *is* bundled, but none of the ~15 `tikzlibrarypgfplots.*.code.tex` files are — that is the whole of #28 and #79. `\usepgfplotslibrary` is a plain `\input`, so this is names added to `tex_files.json` plus a rebuild against a TeX Live carrying pgfplots 1.16: no WASM, no format, no font work, ~100 KB of base64. This is the only near-term progress available on the stated "reliable pgfplots support" goal, and it should run alongside Phase 1-2 rather than waiting for the engine track.
- **Track E1 — engine CI · XL.** Containerised `drgrice1/web2js` build (Ubuntu 24.04, pinned TeX Live and binaryen), mandatory fontforge step with the `$\Omega\otimes$` regression fixture, pgfplots 1.18 + libraries, circuitikz 1.6, expl3 primitives, font pipeline. Gated per-diagram on the Phase 2 golden corpus. Unblocks the entire "needs a rebuilt TeX bundle" backlog.
