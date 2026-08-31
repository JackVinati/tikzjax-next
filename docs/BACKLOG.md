# obsidian-tikzjax — Triaged Upstream Backlog

All **114** upstream numbers (issues and PRs, #1–#114) appear exactly once in the table below, and exactly once again in the three partition lists that follow it.

*Verified programmatically against `upstream-issues.json` (114 records, numbers 1–114, no gaps): the 59 table rows carry 114 distinct numbers with no duplicate and no omission; the three partition lists (64 + 37 + 13 = 114) likewise, and every row's `Fixability` value agrees with the list its numbers land in. The tracker section below is deliberately **excluded** from that partition — it is work with no upstream issue, and folding it in would break the invariant.*

**Fixability legend:** `plugin-ts` / `plugin-css` = fixable in this repo's TypeScript or CSS · `worker-patch` = fixable by a build-time string patch to the vendored worker (no TeX toolchain) · `needs-tex-rebuild` = requires regenerating `tex.wasm` / `core.dump` / `tex_files` / fonts · `wontfix` = upstream limit, architecturally impossible, or answered.

---

## Corrections — read these before the table

This triage was written against **artisticat's 2022 bundle**, when a rebuilt TeX engine was a
hypothetical parallel track called E1. That track is done: the engine is now built here, from
pinned upstream sources, in a container (`engine-build/`). Several of the reasons the table gives
for calling something impossible were true of that blob and are false of the engine we ship.

The rows below are left as written, because the reasoning in them is the record of what was
believed and why. These are the corrections.

**1. expl3 works. It was never a limit of the engine.**
The table blames "plain e-TeX 3.14159265-2.6 with no `\expanded` / `\pdfstrcmp`", and says this
transitively blocks forest, xparse, siunitx v3, mathtools and tcolorbox. But `drgrice1/web2js`
applies `changes/expanded.ch` and `changes/strcmp.ch`, which add exactly those primitives.
`forest`, `xparse`, `mathtools` and `siunitx` all compile on the shipped engine — verified as
fixtures in `test/fixtures/tex/`, rendered end to end through the shipped worker. **#86 renders.**
What stopped these packages was never the primitives; it was that their files were not bundled.

**2. pgfplots is 1.18.1, not 1.16.** So the premise of **#110** ("asks a 2018 release for a 2022
compat level") is gone, and **#108** needs retesting on 1.18.1 rather than closing.

**3. #28 / #79 are fixed.** The `\usepgfplotslibrary` files are bundled and `fillbetween` renders.
This one the table already rated `S` and cheap; it simply landed.

**4. The package list is not the 2022 list.** The engine is built from `drgrice1/tikzjax`'s
`tex_files.json` plus a closure derived by compiling the fixtures with real LaTeX under
`-recorder`. That is a different set. Comparing the two before publishing found **48 files the
rebuild had silently dropped** — circuitikz, chemfig, tikz-feynhand and the euler/eucal fonts —
which have since been restored and are covered by fixtures. Anything in this table that reasons
from "what the 2022 bundle contained" should be checked against
`engine-build/out/tex-versions.txt` and the plugin's own settings screen, which report what the
installed build actually holds.

**5. #55 / #84 / #113 (`\mathfrak`, `\mathscr`) stay open, for a different reason.**
The table files them under "needs the font pipeline as well". That is right, but not because the
fonts are missing: the WOFF2 faces ship, and the TFM metrics are now bundled too. `dvi2html` calls
its own built-in metric table when parsing the DVI, and that table covers only Computer Modern and
is not extensible from outside. Fixing this means extending or vendoring `@drgrice1/dvi2html`.
The plugin now says so — *"The font eufm10 is not supported by the SVG converter"* — instead of
failing blankly.

**6. #59 (`patterns`) has a sharper diagnosis.** The table says the pgfsys driver "never emits
`<pattern>`". It does: the output contains `<pattern id="pgfupat1" xlink:href="#pgfpat3">`. What is
missing is the *definition* `#pgfpat3` (and the `#pgfsym3` it uses). That is a specific gap in the
driver, in code this project now builds.

**What has not changed:** everything resting on the DVI being wrong before any JavaScript runs
(#25, #54 — a contributor opened `input.dvi` in TeXShop and the bonds were already absent), on
LuaTeX (#20), on an 8-bit engine (#19 CJK), or on Obsidian Publish running no community plugins
(#37, #47).

Sorted by category, then severity (critical → high → medium → low).

| Issue(s) | Title | Category | Severity | Effort | Fixability | Root cause (short) | Planned fix / Phase |
|---|---|---|---|---|---|---|---|
| #18 #23 #27 #39 #51 #82 #85 #89 | Infinite spinner / "restart Obsidian to render anything" (~22 reporters) | renderer | critical | L | plugin-ts | The bundle's batch promise `new Promise(async(q,e)=>…)` never calls `e`, and `c.shift()` runs only on the success path — a never-settling `texify` (TeX reaching the interactive `? ` prompt; no `\nonstopmode` in the bundle) or a throw outside the try blocks every later diagram. | **P4** — own the worker; `Promise.race` timeout → `terminate()` + respawn; per-job settlement in `finally`. **P2** mitigates with a session poison set + honest Notice. |
| #102 #93 #87 | Post-processing (dark mode + SVGO) silently skipped in reading mode; colours differ between views | renderer | critical | S | plugin-ts | `tikzjax-load-finished` is listened on `document` (main.ts:52) but dispatched on the SVG; reading view detaches off-screen sections, so the bubbling event never reaches the listener. | **P0** — move the listener to `el`. **P2** — structurally impossible once the artifact is transformed off-document before insertion. |
| #15 #48 | Colour inversion / SVGO only sometimes applied; a third-party `String.prototype` patch killed both silently | renderer | high | M | plugin-ts | Same detached-event bug, plus no try/catch in `postProcessSvg`, plus `String.prototype.replaceAll` on the hot path (Pretty BibTeX 2.0.0 shadowed it). Cache stores the *pre*-processed SVG. | **P2** — transform before insertion, cache the final artifact, local helpers only. **P3** — `MOUNTED(degraded)` + visible warning chip instead of a silent fallthrough. |
| #12 | Different results in reading vs preview mode; clip paths leak between panes | renderer | high | M | plugin-ts | pgf ids are namespaced by *content hash*, so the same diagram in two panes emits byte-identical `<clipPath id>`; `url(#id)` resolves to the first match in document order. | **P2** — store `__TZ__n` id placeholders; stamp a per-mount nonce with a replacement string computed once. |
| #98 | TikZ block in a table flashes then disappears | renderer | high | M | plugin-ts | No render lifecycle: the processor creates a `<script>` and walks away; Obsidian rebuilds table-cell DOM and the async render lands in a discarded element. | **P2** — `MarkdownRenderChild` + `ctx.addChild`; synchronous L1 paint. |
| #66 #71 | Wrong viewBox coordinates; chemfig display area incomplete | renderer | high | M | plugin-ts | dvi2html emits `viewBox="-72 -72 W H"` — the 1-inch DVI origin shift is applied to the origin but not the extent, so the frame is an inch short of the ink. | **P3** — mount-time `await document.fonts.ready` + `getBBox()`, viewBox rewritten to real ink bounds and persisted. |
| #29 | Top and bottom of images get cut off | renderer | medium | S | plugin-ts | `\documentclass[margin=0pt]{standalone}` is baked into the format dump; anything painting outside the measured box is clipped. | **P0** CSS padding; **P3** ink-bbox correction; opt-in `%!tikz border=` for TeX-side margin. |
| #9 #70 | `\chemmove` mispositioned; `\polymerdelim` not rendered | renderer | medium | L | worker-patch | Only one TeX pass is run; `remember picture` / `overlay` / `\label` need the `.aux` from pass 1, and `mq()` wipes the VFS. | **P8** — patch the worker to retain the VFS and re-run when the transcript says so; per-block flag (doubles compile cost). |
| #69 #75 #78 #94 | chemfig Lewis lines, decorated bonds, reaction arrows, and bonds inside `tikzpicture` render wrong | renderer | medium | L | needs-tex-rebuild | Not a missing package — chemfig.tex is bundled. Nested-picture handling in the dvi2html SVG writer: `putSVG` only emits a real `<svg>` root at `svgDepth 0`, so a chemfig picture nested inside a user tikzpicture loses its coordinate frame. | **E1** — driver/dvi2html work upstream. Document "put `\chemfig` at top level" meanwhile. |
| #25 #54 | chemfig `\schemestart` drops all bond lines | renderer | high | XL | needs-tex-rebuild | A contributor extracted `input.dvi` and opened it in TeXShop: **the bonds are already missing in the DVI**, before any JS runs. Enclosing `<g>` also carries `stroke="none"`. | **E1** — bisect the pgfsys-ximera driver / web2js codegen against a stock DVI. No plugin fix exists. |
| #59 | `patterns` library loads but draws nothing | renderer | medium | L | needs-tex-rebuild | The library files *are* bundled and `\usetikzlibrary{patterns}` succeeds; the pgfsys driver never emits `\pgfsys@declarepattern` → no `<pattern>` in the SVG. | **E1** — emit SVG `<pattern>` defs in the driver. Documented as a driver limitation in P0. |
| #2 | RESOLVED — `\Omega` and `\otimes` render as nothing | renderer | low | S | plugin-ts | Fixed upstream by patching the bundled fonts with fontforge to move the soft-hyphen glyph, plus a live `v.replaceAll("&#173;","&#172;")` still applied to every SVG before parsing. Undocumented, and it silently corrupts any legitimate `&#173;`. A rebuild that skips the fontforge step regresses it invisibly. | **P2** — carry the remap over as an explicit, commented pipeline stage (`svg/entities.ts`); **P1** adds a `$\Omega\otimes$` golden fixture so **E1** cannot silently regress it. |
| #112 | Inline renderer (`$tikz:…$`) | renderer | low | L | wontfix | Feature gap; needs baseline-alignment work for a single request. | **Not in scope.** Deferred past 1.0; documented as a non-promise. |
| #81 #100 | No error reporting at all — failures show a broken-image icon | errors-debug | critical | M | plugin-ts | The bundle's only failure path is `console.log(e)` + `q.outerHTML="<img src='//invalid.site/img-not-found.png'/>"`, and it returns **before** dispatching the completion event, so the plugin cannot observe a failure. `input.log` is never written (grep: 0) — stdout is the only channel. | **P4** — own the RPC; TeX stdout arrives as **bare-string** `postMessage`, buffered per job; structural classification (`^! ` + `l.NN`); capability-driven error cards. PR #100's global `console.log` patch + single `currentTikzElement` is rejected (misattributes on multi-block pages). |
| #52 #49 #67 | Loops / graphs / a basic diagram "don't render" — all user errors, invisible without an error surface | errors-debug | high | S | plugin-ts | #52: source begins `\documentclass{article}` while the dump already loads `standalone`. #49: missing `\usepackage{tikz}` + `\begin{document}`. #67: an arrow to a nonexistent tikz-cd node. | **P2** — pre-flight lint strip driven by the generated inventory, before compiling; **P4** — error cards with the offending line. |
| #96 | `\pgfmathsetmacro{\epsilon}{1}` silently corrupts output | errors-debug | low | S | plugin-ts | A macro redefinition clashing with a TeX/TikZ built-in. Produces **no TeX diagnostic at all**, so an error card can never close it. | **P2 (partial)** — pre-flight lint warns on redefinition of reserved names. This is the only possible mechanism. |
| #107 | `\vdots` prevents a tikz-cd diagram from rendering | errors-debug | low | S | needs-tex-rebuild | Unverified — no code, no transcript, no screenshot in the report. `\vdots` is a kernel macro built from a `\vbox` of periods; most likely a missing font metric (cf. #60) or a dvi2html rule/vbox bug. | Blocked on a repro, which **P4**'s error card unblocks. Then **E1** if it is a metric gap. |
| #58 #90 | Cache is invisible, unbounded, never evicted; users cannot find their SVGs | cache | medium | M | plugin-ts | Caching lives entirely inside the bundle: md5 key, localForage, no size accounting, no eviction, no versioning; the only control is a "clear everything" button. | **P2** — plugin-owned L1/L2 with LRU + byte cap, live readout, Clear all / Clear this note / Rebuild this note. |
| #38 #103 | Dark mode is a blind string replace; no white-background option | darkmode-styling | high | M | plugin-css | main.ts:142-143 matches only four quoted literals, misses unquoted CSS (`<span style="color: black">`), cannot tell default ink from `\fill[white]`, runs before SVGO's `convertColors`, bakes `var(--background-primary)` into presentation attributes (invalid outside Obsidian → falls back to **black**), and never checks whether dark mode is active. | **P3** — delete it. Theme-neutral artifact + `--tikz-ink` / `--tikz-paper` CSS tokens + four modes (`adapt`/`preserve`/`paper`/`invert`) + double print pinning. |
| #73 | Shaded ball disappears / flattens in reading mode | darkmode-styling | medium | S | plugin-css | Two causes: the detached-event bug (#102), and rewriting the white and near-black ends of a `ball color` ramp pushes them toward each other and flattens the shading. | **P3** — gradient `stop-color` is **exempt by default**; setting `Adapt gradients: never \| ink-only`. |
| #45 #114 #101 #109 | Export to PDF drops most or all diagrams (11+ reporters, two unmerged PRs) | export-pdf-publish | critical | M | plugin-ts | Two independent bugs. (a) `printToPdf` opens a hidden `window.open` popup that is **not** a `WorkspaceWindow`, so `window-open` never fires and the engine is never injected; Obsidian clones `<style>` but not `<script>`. (b) The processor returns `void`, so the only wait before `print-to-pdf` is a hard-coded `sleep(200)`. PRs #101/#109 fix only (a) — they appear to work because the same-origin IndexedDB cache serves already-rendered diagrams. | **P0** per-document bootstrap from `el.doc` (take #109's hardening, reject its manifest rebrand). **P2** — async awaited processor + laziness bypass + 30 s per-block and **60 s total** export budgets. |
| #21 #33 #95 #97 | No way to get the rendered SVG out; exported SVG renders wrong outside Obsidian; Advanced Slides integration blocked | export-pdf-publish | medium | M | plugin-ts | Missing feature, plus `currentColor` falls back to black and an unresolvable `var(--background-primary)` is invalid-at-computed-value-time so `fill` also falls back to **black** — every `\fill[white]` region turns solid black in a saved file. Fonts live only in the plugin's `styles.css`. | **P7** — `freezeSvg()`: stamp `color` on the root, literalise paper classes, inline only the referenced `@font-face` subset. Copy SVG / Save SVG / Finalize / Un-finalize. |
| #37 #47 | Obsidian Publish never renders TikZ blocks | export-pdf-publish | medium | S | wontfix | Publish runs zero community plugins; the published site never loads `main.js`. | **P7** — no plugin-side attempt. **Finalize** writes real `.svg` attachments Publish can serve; document and close. |
| #14 #42 #26 | Diagrams render tiny; no scaling or alignment control (14 participants) | ux-settings | high | S | plugin-css | The plugin passes zero layout options; the only CSS rule is a centred, natural-size, `.markdown-rendered`-scoped one. (The related #50 has a different cause and is listed under packages-tex.) | **P3** — `width`/`max-width`/`scale`/`align` applied to the **wrapper div**, global defaults + per-block `%!tikz`. |
| #46 #76 #77 #83 | No custom preamble; every block must repeat `\usepackage` / `\usetikzlibrary` / `\tikzset` | ux-settings | high | M | plugin-ts | The bundle already honours `data-add-to-preamble`, `data-tex-packages`, `data-tikz-libraries`, `data-tikz-options` — the plugin sets none of them (main.ts:99-100 sets only `type` and `data-show-console`). | **P6** — global preamble + walk-up `tikz-preamble.tex` + `%:input` with `getFirstLinkpathDest` resolution, cycle detection, visible missing-file error, and dependency-tracked invalidation (the limitation PR #77 conceded). Fed through the native dataset fields, not string splicing. |
| #104 | No zoom / pan for dense diagrams | ux-settings | low | S | plugin-ts | Feature gap; made worse by the wrong viewBox, so naive CSS scaling crops. | **P7** — pan/zoom modal over a cloned SVG via viewBox manipulation, after **P3** makes the viewBox trustworthy. |
| #64 | Suggestion: side-by-side source and rendered output | ux-settings | low | M | plugin-ts | What the reporter actually wants is error visibility and a fast edit loop. | **P4** — satisfied by inline error cards + **P2**'s debounced re-render. No new editor mode. |
| #80 #106 | quiver-exported diagrams fail (`curve={height=…}`); quiver.sty not bundled | packages-tex | high | M | plugin-ts | `quiver.sty` defines `curve/.style` and friends and is not in the 212-file `tex_files` manifest. A commenter proved that pasting quiver's `\tikzset` definitions into a block renders correctly. | **P2** — ship quiver's `\tikzset` block as a built-in preamble fragment, injected when the source references quiver. A static string, not a package port. |
| #4 | Support user packages (oldest open request, blocks ~8 others) | packages-tex | high | L | worker-patch | The worker resolves files from a build-time dictionary; anything absent raises "File not available". The 2022 blocker ("the worker has no access to `app`") is moot — files can be read on the main thread and posted in. | **P8** — patch `texify(q,e,files)` to seed `cq` via the existing `Nq(name,bytes)`; a vault packages folder; file hashes in the cache key. |
| #13 | External data files (`\addplot table`, `\input`, `\includegraphics`) | packages-tex | medium | M | worker-patch | Same virtual-filesystem gap — the VFS has exactly one writable entry, `input.tex`. | **P8** — same patch; paths resolved relative to `ctx.sourcePath`, content hashes in the key. |
| #17 #34 #40 #41 #56 #88 #92 #99 | Missing pure-LaTeX packages: bayesnet, tikz-timing, quantikz, amsthm, ytableau, stanli, venndiagram, tkz-tab | packages-tex | medium | L | needs-tex-rebuild | Ordinary `.sty` / `.code.tex` files absent from the bundle's 212-file manifest. None need new primitives; some (venndiagram, tkz-tab) drag in xkeyval/xstring and need checking against the e-TeX-only engine. | **E1** — names added to `tex_files.json` + rebuild. **P8**'s BYO-packages mechanism makes them user-installable in the interim. |
| #28 #79 | `\usepgfplotslibrary{…}` libraries missing (fillbetween, groupplots, colormaps, statistics…) | packages-tex | medium | S | needs-tex-rebuild | pgfplots **1.16 is bundled**, but none of the ~15 `tikzlibrarypgfplots.*.code.tex` files are. `\usepgfplotslibrary` is a plain `\input`. | **Spike S1** (parallel, 3-5 d) — add ~15 files from a TeX Live carrying pgfplots 1.16. No WASM, no format, no font work, ~100 KB. The only near-term progress on "reliable pgfplots". |
| #55 #113 | `mathrsfs` / `\mathscr`: package loads but the font is missing so nothing draws | packages-tex | medium | L | needs-tex-rebuild | Needs the `rsfs10` TFM in dvi2html **and** a matching `@font-face` in styles.css. A contributor added the package and confirmed the glyphs are still absent. | **E1** — font pipeline (the #60/#61 recipe). **P0** documents `\usepackage[mathscr]{euscript}` as the working substitute today. |
| #19 #36 #53 | Non-Latin text: misc Unicode, Cyrillic, IPA | packages-tex | medium | XL | needs-tex-rebuild | 8-bit e-TeX with OT1/T1 only. UTF-8 *input* decodes (`utf8.def` is in the dump) but there is no T2A/tipa encoding, no TFM and no webfont. | **E1** — add `fontenc` T2A + cm-super/lh + tipa to `tex_files` and `fonts.css`. **The CJK half of #19 is impossible** on an 8-bit engine. **P2** pre-flight warns on non-Latin-1 codepoints. |
| #30 | `siunitx` / `\si` / `\pu` unavailable (and its absence hangs the renderer) | packages-tex | medium | L | needs-tex-rebuild | siunitx v3 is an expl3 package; the format dump was built with "Skipping expl3-dependent extensions" and LaTeX2e `<2020-02-02>`. | **E1** — needs a rebuilt `core.dump` with the pdfTeX primitives. **P4** turns the hang into `Undefined control sequence \si` + a capability hint. |
| #86 | `forest` (and every modern package) blocked: `Package expl3 Error: Required primitives not found` | packages-tex | medium | XL | needs-tex-rebuild | Plain e-TeX 3.14159265-2.6 with no `\expanded` / `\pdfstrcmp` / `\pdffilesize`. Transitively blocks forest, xparse, siunitx v3, mathtools, tcolorbox. | **E1** — `drgrice1/web2js` already applies `expanded.ch`, `strcmp.ch`, `filesize.ch`, `creationdate.ch`. Documented as a named limitation in **P0**. |
| #22 | Cannot set `\charge` within chemfig | packages-tex | medium | L | needs-tex-rebuild | `\listfiles` confirms chemfig 1.4 (2019/04/18) — deliberately pinned as the last version not requiring `\expanded`. `\charge` does not exist in 1.4. | **E1** — unpin chemfig after the primitives land. Already solved in a community fork. |
| #62 #63 | circuitikz pinned at v1.0 (2020): IEEE logic ports, variable-resistor wiper anchor missing | packages-tex | medium | L | needs-tex-rebuild | `\def\pgfcircversion{1.0}`, `\pgfcircversiondate{2020/02/04}`. #62 needs ≥1.1.0; #63's `Unknown function 'wiper'` is 1.0's named-node plumbing failing to deliver the anchor. | **E1** — port circuitikz 1.6.x (check it does not require expl3/siunitx). **P0** documents the pinned version. |
| #108 #110 | pgfplots pinned at 1.16 (2018): `compat=1.18` rejected; in-axis circles come out as rotated ellipses | packages-tex | medium | L | needs-tex-rebuild | `\gdef\pgfplotsrevision{1.16}`. #110 asks a 2018 release for a 2022 compat level. #108's circles are drawn in the axis's non-uniform transformed coordinate system. | **E1** — port pgfplots 1.18.x. **P2** pre-flight warns on `compat>1.16`; document the `\addplot[domain=0:360]({cos(x)},{sin(x)})` workaround. |
| #44 | pgfplots 3-D surf/mesh plots truncate part-way through the sample grid | packages-tex | medium | L | needs-tex-rebuild | The signature of a TeX capacity limit: `main_memory`/`pool_size`/`save_size` are frozen in `core.dump`, and pgfplots holds the whole sample grid in macro memory. | **E1** — raise the limits in `tex.ch` and regenerate. **P4** at least surfaces `! TeX capacity exceeded`, today entirely invisible. |
| #50 | `\scalebox` does not scale a chemfig diagram | packages-tex | medium | L | needs-tex-rebuild | Filed as a scaling bug, but chemfig 1.4 draws lone-pair dots inside an unscaled nested `tikzpicture`, so neither `\scalebox` nor CSS can reach them. Fixed in chemfig ≥1.5, which needs `\expanded`. | **E1** — unpin chemfig once the pdfTeX primitives land. CSS scaling from **P3** covers the outer diagram. |
| #65 | `full crystal` and other circuitikz keys unsupported | packages-tex | low | S | wontfix | `full crystal` is not a valid key in **any** circuitikz version — a commenter verified it also fails in a normal LaTeX install. User error plus no error message. | Close with an explanation; **P4** makes the class self-diagnosing. |
| #20 | `tikz-feynman` support | packages-tex | low | S | wontfix | tikz-feynman's automatic layout uses the graphdrawing engine, which requires **LuaTeX**. There is no Lua interpreter and no realistic path to one. | Close. **P0** documents that **`tikz-feynhand` IS already bundled and undocumented** — the working manual-mode substitute. |
| #84 | Please support `\mathfrak` | packages-tex | low | S | wontfix | Already works: `eufrak.sty`, `ueuf.fd` and `eufm5..10` are all bundled via amsfonts/amssymb. | **P0** — documentation only; generated package table. |
| #43 | Please support amssymb, `\mathbb`, `\mathscr` | packages-tex | low | S | wontfix | `\usepackage{amsmath,amssymb}` already works; `\mathscr` is tracked separately as #55/#113 with the `euscript` substitute. | **P0** — close with the explanation + FAQ. |
| #31 | `tan` not working | packages-tex | low | S | wontfix | Not a bug: `plot (\x,{tan(\x r)})` over `domain=-pi:pi` crosses the asymptote and pgfmath's fixed-point arithmetic overflows exactly as it does in real LaTeX. Needs a restricted domain. | **P0** — close with the explanation; FAQ entry on the pgfmath domain gotcha. |
| #60 #61 | RESOLVED — missing `cmmib5` TFM broke circuitikz op-amps | packages-tex | low | S | plugin-ts | dvi2html's base64 TFM table lacked the amsfonts metrics. Diagnosed and fixed by a contributor; the rebuilt bundle is in this checkout. | **P1** — keep as a golden fixture so a future rebuild cannot silently regress it. The #60 recipe is the canonical procedure for the next font gap. |
| #111 #91 #74 | iOS crash/restart loop; "Failed to load plugin"; complex structures fail on iOS | mobile-ios | critical | L | plugin-ts | Three stacked causes: (a) `styles.css` is 4,791,337 B of base64 fonts parsed into the CSSOM at launch **with no note open** — which is exactly #111's "crashes while navigating Settings"; (b) unguarded `window.CodeMirror.modeInfo` (main.ts:109) and `floatingSplit.children` (main.ts:84) throw in `onload`; (c) the 7 MB payload is materialised four times and the Blob URL is never revoked. | **P0** guards (#74). **P1** font split: 12 core faces stay, 128 become a cold string injected per-document → startup CSSOM parse 4.79 MB → ~0.2 MB. **P5** WOFF2 + single Blob + teardown on `visibilitychange`. |
| #7 #24 | ~72 MB heap per render; iPad lag and ~10 %/min battery drain | mobile-ios | high | M | worker-patch | `new WebAssembly.Memory({initial:1100,maximum:1100})` = 68.75 MiB allocated **per render**, plus `ye.slice(0)` = a second full copy, on top of the permanently retained dump. `mq()` also clears `cq`, re-gunzipping the whole pgf tree every render. #24's repro contains `\end{tizpicture}` — a non-terminating TeX loop with no timeout. | **P1** patches P1/P2/P2b (`.set(ye)`, hoist `compile`, reuse the Memory) — provably safe because the dump is exactly 1100 × 65536 B, i.e. the entire non-growable memory. **P2** debounce. **P4** timeout. **P8** patch P6 (stop clearing `cq`). |
| #6 | Misaligned text on mobile (fixed by running the SVG through SVGO) | mobile-ios | medium | S | plugin-ts | A 2022 one-line issue with zero comments — the sole justification for 587 KB of vendored SVGO. Measurement suggests the operative changes are dropping `alignment-baseline="baseline"` (spec-invalid on `<text>`, where WebKit and Blink disagree) and collapsing the `scale/translate/scale` chain. | **P3** — a ~40-line `targeted` transform, **opt-in until #6 is reproduced on a real iOS device**; corrected `preset` stays the default meanwhile. |
| #8 #10 #11 #35 #68 | The TeX/WASM toolchain is not reproducibly buildable; no CONTRIBUTING doc | build-toolchain | high | XL | needs-tex-rebuild | Nobody but the original author can regenerate `tex.wasm`/`core.dump`; the build is a function of the host's apt state (`TeX capacity exceeded [pattern memory]` with texlive-full; `standalone.cls not found` with too little). The only guide lives in a GitHub issue. | **E1** — containerised `drgrice1/web2js` (Ubuntu 24.04 Dockerfile, pinned TeX Live + binaryen), artifacts published with checksums; fold #68 into an in-repo CONTRIBUTING.md. This is the gate on the entire "needs a rebuilt bundle" list. |
| #105 | PR: SVG transformer pipeline with dark mode and SVGO support | build-toolchain | medium | M | plugin-ts | Right instinct, wrong implementation: it does not compile (`src/utils/index.ts` re-exports `tidyTikzSourceFunctional`, which `tikz-source.ts` declares without `export`), keeps the flawed colour regexes, keeps the document-level event hook, and defers post-processing to `requestIdleCallback` — which would make export *worse*. 5109 of its 6218 diff lines are `package-lock.json`. | **Superseded.** Cherry-pick its defensive guards into **P0** (`window.CodeMirror?`, `floatingSplit?`, null-safe unload, dedupe set, attached-check) and its esbuild/tsconfig modernisation into **P1**; implement the pipeline properly in **P3** as ordered pure functions with no registry. |
| #5 | Add syntax highlighting | build-toolchain | medium | S | plugin-ts | Implemented by mutating the undocumented CM5 global `window.CodeMirror.modeInfo` behind two `@ts-ignore`s, unguarded in `onload`, and **reassigning** the array rather than splicing (silently breaking other plugins). Largely moot anyway — registering a code-block processor makes Live Preview widget the block instead of highlighting it. | **P0** guard + splice in place. **P1** add `registerEditorExtension(StreamLanguage.define(stex))` as the documented path. |
| #3 | Support offline operation | build-toolchain | medium | M | plugin-ts | Solved in 0.3.0 by base64-inlining the entire TeX distribution — correctly, but at a cost of 12.07 MiB shipped and parsed eagerly. Obsidian's installer fetches only `main.js`/`manifest.json`/`styles.css`, so externalising is not viable. | **P1/P5** — keep offline; recover the *duplicates* (four materialisations of the 7 MB payload) and the 4.79 MB eager CSSOM parse instead. Download-on-first-run is explicitly rejected. |
| #1 | Improvement (installation instructions) | docs | low | S | wontfix | Resolved in 2022; nothing outstanding. | **P0** — close. |
| #16 | Support usage in math blocks | docs | low | S | wontfix | Architecturally impossible: `$$…$$` is routed to MathJax, a different engine, before any code-block processor sees it. | **P0** — close with the explanation; README FAQ. |
| #72 | The diagram doesn't show up | docs | low | S | wontfix | The reporter had not enabled the plugin. | **P0** — close; the troubleshooting section prevents the next one. |
| #57 | Discussion examples | docs | low | S | wontfix | Request for a Discussions tab with community examples. | **P0** — enable GitHub Discussions, seed with the README examples. |
| #32 | Rename this plugin to `obsidian-latex-addons`? | docs | low | S | wontfix | Renaming a published plugin id orphans every install's settings and cache folder. In-thread consensus is to fix the description instead. | **P0** — update `manifest.json`'s *description*; the id is stable forever. |

---

## Fixed by this modernization

Closed by plugin TypeScript / CSS, or by a build-time patch to the vendored worker. **64 issues.**

`#2, #3, #4, #5, #6, #7, #9, #12, #13, #14, #15, #18, #21, #23, #24, #26, #27, #29, #33, #38, #39, #42, #45, #46, #48, #49, #51, #52, #58, #60, #61, #64, #66, #67, #70, #71, #73, #74, #76, #77, #80, #81, #82, #83, #85, #87, #89, #90, #91, #93, #95, #96, #97, #98, #100, #101, #102, #103, #104, #105, #106, #109, #111, #114`

Notes on the three partial entries:
- **#96** — partial only. A macro redefinition produces no TeX diagnostic; the fix is a pre-flight lint warning, not an error card.
- **#6** — fixed by making SVGO optional and shipping the targeted transform, but the transform stays opt-in until reproduced on a real iOS device.
- **#24** — the debounce lands in Phase 2, but the runaway-TeX half is not *recovered* until Phase 4 (`LegacyScriptHost` cannot kill a running compile).

## Needs a rebuilt TeX bundle

Requires regenerating `tex.wasm` / `core.dump` / `tex_files` / the font pipeline — i.e. parallel track **E1** (and spike **S1** for the cheap subset). **37 issues.**

`#8, #10, #11, #17, #19, #22, #25, #28, #30, #34, #35, #36, #40, #41, #44, #50, #53, #54, #55, #56, #59, #62, #63, #68, #69, #75, #78, #79, #86, #88, #92, #94, #99, #107, #108, #110, #113`

Ranked by cost:
- **Cheapest (files only, no engine change):** #28 #79 (pgfplots libraries — spike S1, ~3-5 d), then #17 #34 #40 #41 #56 #88 #92 #99.
- **Needs the font pipeline as well:** #55 #113 #19 #36 #53.
- **Needs the pdfTeX primitives / a new format dump:** #86 → then #30, #22, #50, and modern circuitikz #62 #63 and pgfplots #108 #110 #44.
- **Needs driver / dvi2html work:** #59 (patterns), #25 #54 (chemfig DVI), #69 #75 #78 #94 (nested pictures), #107 (suspected metric).
- **Is the enabling infrastructure:** #8 #10 #11 #35 #68.

## Won't fix / upstream limit

**13 issues.**

**(a) Architecturally impossible or an upstream limit (5):**
- `#16` — TikZ inside `$$…$$`: math blocks go to MathJax before any code-block processor runs.
- `#20` — tikz-feynman needs LuaTeX; there is no Lua interpreter and no path to one. *(`tikz-feynhand` is bundled and will be documented.)*
- `#37`, `#47` — Obsidian Publish executes no community plugins. Mitigated, not fixed, by Finalize-to-attachment.
- `#112` — inline `$tikz:…$` rendering: deferred past 1.0 as YAGNI, not attempted.

**(b) Answered — close with an explanation, no code (8):**
- `#1` — installation, resolved 2022.
- `#31` — `tan` over an asymptote overflows pgfmath in real LaTeX too; restrict the domain.
- `#32` — renaming the plugin id would orphan every install; fix the description instead.
- `#43` — `\usepackage{amsmath,amssymb}` already works.
- `#57` — enable GitHub Discussions and seed it.
- `#65` — `full crystal` is not a valid key in any circuitikz version.
- `#72` — the plugin was not enabled.
- `#84` — `\mathfrak` already works via the bundled `eufrak` / `eufm*`.

Retiring group (b) plus #16, #20, #37 and #47 costs roughly a dozen comments and removes ~11 % of the open tracker — which matters, because that noise is currently hiding the real bugs.

---

## Work required that no upstream issue covers

The tracker is a poor requirements document: it contains what users noticed. These items have **no issue number**, are not part of the 114-number partition above, and would otherwise be invisible in a triage-driven plan. Two of them are blockers.

| Item | Why it exists | Severity | Fixability | Phase |
|---|---|---|---|---|
| **SVG sanitization** | The bundled dvi2html implements `special{dvisvgm:raw …}` by emitting the remainder **verbatim** into the SVG (tikzjax.js @54533), so a ````tikz```` fence can carry `<script>`, `on*=`, `<foreignObject>`. Both insertion paths execute it: `createContextualFragment` on the bundle's cache-hit path (@7030054) and `outerHTML` at main.ts:183. Notes are synced and shared, so no one has to write the TeX themselves. Persisting artifacts to L2 makes an injected payload *replay on every later open*. | critical | plugin-ts | **P0** minimal strip; **P2** mandatory non-skippable pipeline stage (DESIGN §7.2) |
| **Outbound network request on failure** | The only failure path in the shipped payload is `<img src='//invalid.site/img-not-found.png'/>` — a DNS lookup + HTTP request per failed render, from a plugin whose selling point is offline operation (#3). | high | worker-patch | **P1** (patch P0) + a CI grep asserting zero network APIs in the build |
| **Licensing of the vendored payload** | Repo is MIT, but `main.js` embeds PGF/TikZ (dual GPL-2+/LPPL), circuitikz/chemfig/pgfplots, the TeX engine, and `styles.css` embeds 140 Knuth/AMS font faces; SVGO (MIT) ships without its notice. No NOTICE, no `vendor/LICENSES/`. | high | docs/legal | **P1** NOTICE + per-package licence column in the generated inventory; the aggregate-obligation question is a maintainer decision (DESIGN §9.7) |
| **Accessibility** | Diagrams are unlabelled `<svg>`; failures are an image of a broken image; the planned zoom modal is pointer-only. | medium | plugin-ts | **P2** `role="img"`/`<title>`/`aria-busy`; **P3** error-card semantics + keyboard buttons; **P7** keyboard pan/zoom |
| **i18n affordance** | Obsidian gives plugins no translation API; hard-coded English is scattered through render logic. | low | plugin-ts | **P2** all user-visible strings in `ui/strings.ts`; no translations shipped, none promised |
| **Cache is not vault-scoped** | Desktop vaults share one origin; Obsidian namespaces its own stores with `appId` (`appId+"-cache"`, verified). A DB named `obsidian-tikzjax` would share one byte cap and one "Clear all" across every vault on the machine. Plus: WebKit evicts IndexedDB under pressure, and `QuotaExceededError` on write must not fail a render. | medium | plugin-ts | **P2** |
| **Sync / multi-device semantics** | `data.json` syncs and can arrive from a newer version (unknown keys must survive a write-back); the cache is deliberately device-local; Finalize writes synced attachments and can conflict; syncing `.obsidian/plugins` costs 12 MB per release. | medium | plugin-ts/docs | **P2** settings migration; **P7** Finalize UX; **P1/P5** size |
| **Module-147 re-splice** | Phases 1-3 run the injected *whole bundle*, not the extracted worker, so the Phase-1 engine patches reach nothing that executes unless the patched module is spliced back into the bundle string. Phase 1's memory acceptance criterion depends on it. | high | build | **P1** (DESIGN §4.4) |
| **Toolchain peer conflict** | `eslint-plugin-obsidianmd@0.4.2` pins peers `obsidian: "1.8.7"` (exact) and `@eslint/js: "^9.30.1"`, both violated by the chosen stack; bare `npm ci` in CI will fail without explicit `overrides`. | medium | build | **P1** |
| **"Fast mode" was undefined** | A stated user goal that existed only as a table row. Now specified as a preset (`svgo: off` + skip measure + skip lint + priority boost, never skipping sanitize or ids). | low | plugin-ts | **P3** (DESIGN §7.11) |
| **Cancellation scope** | The brief asks for cancellation when a block changes; the design delivers *pre-start* cancellation only, and mid-flight termination just for timeout / unload / backpressure. Recorded as an explicit deviation rather than an implied promise. | — | — | **P2** pre-start, **P4** terminate |
