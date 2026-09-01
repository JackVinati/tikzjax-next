# Decisions that supersede DESIGN.md

`docs/DESIGN.md` is the output of a 19-agent recon + design panel. It was written **before**
four project decisions were made and before three facts were verified. Where this file and
`DESIGN.md` disagree, **this file wins**. Everything in `DESIGN.md` not contradicted here stands.

Date of record: 2026-08-31.

---

## D1 — Fork with a new plugin id, developed entirely locally

**Supersedes `DESIGN.md` §8.5 ("The plugin id — `obsidian-tikzjax`, never renamed") and §1.2's
"Renaming the plugin id … Never".**

That reasoning was correct for a maintainer shipping an update in place to existing installs.
It does not apply here: this is a fork that will be published separately, so there is no install
to orphan.

- `manifest.json`: new `id`, new `name`, `author` and `authorUrl` updated. Upstream credited in
  README and `manifest.json` description.
- No pushing, no remote, no release until the maintainer says so. All work stays on a local branch.
- **The legacy cache is still reachable.** The bundle's localForage store lives in the Obsidian
  app origin as database `TikzJax` / store `svgImages` — it is scoped to the *origin*, not to the
  plugin folder. So §8.3's L3 read-through works unchanged from a differently-named plugin.
  This is load-bearing and must be asserted by a test.
- **Old settings are imported once**, by reading `.obsidian/plugins/obsidian-tikzjax/data.json`
  through `vault.adapter` if it exists, applying §8.4's migration, then never reading it again.
- **New: coexistence guard.** Both plugins register a `tikz` code-block processor, and Obsidian
  lets both run — a note would render every diagram twice. On load, if the old plugin id is
  present in the enabled-plugins list, show a one-time modal offering to disable it, and refuse to
  register the processor until the user chooses. This has no upstream issue; it exists only
  because of D1.
- **L3 never deletes the legacy records** (superseding §8.3's "the legacy record is deleted" and
  the 30-day drop). The old plugin may still be installed and using them. Reclaiming that space
  becomes an explicit command, *Reclaim the old TikZJax cache*, which states what it will delete.

## D2 — Everything ships in one pass; `LegacyScriptHost` is cut

**Supersedes `DESIGN.md` §4.2, §4.4's phase assignments, §11.1's "LegacyScriptHost is ~8 days
deleted one release later — accepted deliberately", §12's Phase 2/Phase 4 split of the engine
work, and open question 5.**

The maintainer is taking the whole modernization in one review, not phase-by-phase releases. The
entire justification for `LegacyScriptHost` was that it is a *bisect boundary between two shipped
releases*. With one delivery there are no two releases to bisect between, and building an 8–10 day
module whose only purpose is to be deleted is pure waste.

- **`WorkerHost` is the only `TexHost` implementation.** We drive webpack module 147 directly from
  the start. Recon verified it terminates in a threads.js `expose({load, texify})` — a real
  Promise API — so this is well-founded, not a gamble.
- **No `<script>` is ever injected into any document**, in any phase. `loadTikZJax`,
  `unloadTikZJax`, `loadTikZJaxAllWindows`, `getAllWindows` and the `window-open` handler are
  deleted outright rather than at Phase 4.
- **§4.4's module-147 re-splice problem disappears.** It existed only because Phases 1–3 ran the
  whole injected bundle while patches were applied to the extracted worker. With no
  `LegacyScriptHost` there is one artifact, the patched worker, and every patch reaches code that
  runs. Patches **P0–P4** all ship; the exactly-one-match assertions and the pinned SHA-256 stay.
- **§4.2's "hard constraint: do not change any `data-*` value"** is void. It existed to keep the
  legacy key valid while `LegacyScriptHost` was the engine. L3 reads the legacy store through
  `cache/legacy-key.ts`, which is a frozen reimplementation and does not depend on what the live
  engine sends. `showConsole` becomes a real per-job flag excluded from the cache key immediately.
- The `TexHost` **seam stays**. It is ~40 lines, and D3 needs it.
- The phases in §12 remain as **internal sequencing and commit boundaries** — the order is still
  not interchangeable (§12's own caveat) — but they are no longer store releases, and no
  acceptance criterion is deferred to "a later version".

## D3 — pgfplots via an opt-in extended engine, downloaded on demand

**Supersedes `DESIGN.md` §1.2's "Download-on-first-run" non-goal and its rejection of
`@rod2ik/tikzjax`; refines §4.6 and parallel track E1.**

§1.2 rejected downloading because offline operation is a deliberate feature (#3). That holds for
the **core** engine and is unchanged: the bundled engine ships in `main.js`, works offline forever,
and is what every user gets by default. The extended engine is a different thing — an explicit,
user-initiated install, after which it is also fully offline.

**The invariant is amended, not dropped.** §7.11 promised zero network requests, enforced by a CI
grep. The new invariant: **zero network requests except one user-initiated engine download**, to a
URL pinned in the source, verified against a SHA-256 pinned in the source, refusing to install on
mismatch. The CI grep stays and is narrowed to allow exactly that one call site. The settings entry
says plainly what it downloads, from where, and how large it is.

Storage: `.obsidian/plugins/<id>/engines/<engine-id>/` via `vault.adapter.writeBinary`. This is a
*runtime* write, not a store-installed sibling file, so §1.2's "sibling assets do not reach store
users" objection does not apply. Absent or corrupt → fall back to the core engine with a Notice,
never a failed render.

`ENGINE_ID` already participates in the cache key (§6.1), so core and extended artifacts coexist
and switching engines invalidates exactly the affected diagrams. No further design work is needed
for that; it is why the seam is kept.

**Which extended engine — verified facts, and what is still unverified:**

| | Bundled (today) | `@rod2ik/tikzjax` 1.6.0 |
|---|---|---|
| pgfplots | **1.16, present** (30 files incl. `pgfplots.sty`) | 1.18.2 |
| `\usepgfplotslibrary{…}` files | **absent** — this is the whole of #28/#79 | mostly absent too (only `contourlua`) |
| `expl3.sty`, `xparse.sty`, `l3keys2e.sty`, `l3backend-dvips.def` | absent | **present** |
| `arrows.meta` | **absent** | present |
| `mathtools`, `mhchem`, `physics`, `xstring`, `etoolbox`, `xpatch` | absent | present |
| `msam*/msbm*.tfm` (AMS symbols) | absent | present |
| `yquant`, `braids`, `hobby`, `tkz-tab`, `pgf-spectra`, `kinematikz` | absent | present |
| circuitikz | 0.4–1.0, six pinned copies | newer |
| Asset delivery | inlined in `main.js`, offline | `tex.wasm.gz` + `core.dump.gz` fetched from jsDelivr |
| Memory | 1100 pages = 68.75 MiB | reported 2500 pages = 156.25 MiB per render |

Two corrections to `DESIGN.md` that follow from the first row:

1. **"pgfplots is not bundled" is wrong** — it *is* bundled, at 1.16. The user-facing problem is
   the missing `\usepgfplotslibrary` files plus the absence of any error message when a plot blows
   the memory or time budget. Spike S1 and Phase 4's error cards therefore deliver most of the
   perceived "pgfplots support" without any new engine.
2. **The ~37-issue "needs expl3, permanently unfixable" partition in `BACKLOG.md` is provisional.**
   `expl3.sty` is present in rod2ik's file list. Whether it *runs* depends on whether that engine
   provides the primitives expl3 needs (`\expanded` in particular), which e-TeX alone lacks and
   which this recon did **not** verify. Until someone compiles `\usepackage{expl3}` on it, those
   issues stay in the wontfix partition and the README says so.

Sequencing: adopt rod2ik as the first extended engine if it validates against the golden corpus
(fast, no TeX toolchain). Track E1 — our own containerised web2js build carrying pgfplots 1.18.3
and pgf 3.1.12 — remains the long-term answer and is unchanged, but it is no longer the only route
to pgfplots.

Known rod2ik hazards to handle in its engine adapter, all from recon: its `texify` wraps
`\begin{document}` itself, which would nest document environments in every existing note (the
adapter must strip or bypass this); its device-memory cap computes `Number(navigator.deviceMemory)`
→ `NaN` → `POSITIVE_INFINITY` on WebKit, i.e. **no cap on iOS**; and 156 MiB per render makes it
**desktop-only** until measured on a device.

## D4 — Breaking changes are allowed, migrations are mandatory

**Confirms `DESIGN.md` §8.2's `corrected` default and resolves open question 2.**

- `normalizeSource` ships with `corrected` as the default: blank lines (`\par`) are preserved,
  real U+00A0 is stripped rather than the `&nbsp;` entity, leading whitespace survives.
  `source/legacy-tidy.ts` stays permanently — L3 needs it — and is exposed as a
  `Source handling: legacy | corrected` setting with a one-time Notice on first run.
- The colour model, the cache format, the settings schema and the per-block option syntax are all
  free to change. Every one of them ships with a migration, and no user data is destroyed:
  settings migrate forward per §8.4, the legacy cache is read through per §8.3 as amended by D1,
  and existing ` ```tikz ` blocks render without edits (§8.1 is unchanged).

## D5 — TypeScript 7 for typechecking; ESLint kept for the Obsidian store rules

**Supersedes `DESIGN.md` §9.1's `typescript 5.9.3` pin and the last paragraph of §9.7.**

The design pinned TypeScript 5.9.3 because `typescript-eslint@8.68.0` peers cap at
`typescript >=4.8.4 <6.1.0`. That constraint is real and was verified. But it is a *linter*
constraint, and it was allowed to dictate the *compiler*, which in an Obsidian plugin does no
emitting at all — esbuild transpiles, and `tsc` is only a `--noEmit` gate.

Verified against the npm registry on 2026-08-31:

- `typescript@7.0.2` is `latest`, published 2026-07-08. It is the native Go port: 20
  platform-specific optional deps (`@typescript/typescript-win32-x64@7.0.2` …), 2.38 MB unpacked
  against 23.14 MB for `typescript@6.0.0-beta` (the last JS-based line), one `tsc` bin and no
  `tsserver`, and the classic compiler API replaced by `./unstable/{ast,fs,sync,async}` exports.
- `engines: node >=16.20.0`; the dev machine is Node 22.19.

Decision:

| Job | Tool |
|---|---|
| Typecheck (`npm run typecheck`, CI, pre-commit) | **`typescript@7.0.2`**, `tsc --noEmit` |
| Fast lint in the dev loop | **`oxlint@1.80.0`** — Rust, no TS program, milliseconds |
| Store-compliance lint (CI gate) | **`eslint@10.9.1` + `typescript-eslint@8.68.0` + `eslint-plugin-obsidianmd@0.4.2`**, with `typescript@5.9.3` supplied to *that* stack alone via npm `overrides` |

`eslint-plugin-obsidianmd` is kept deliberately: it encodes the community-store rules
(`§9.7`) — no `innerHTML`/`outerHTML`, no global `app`, teardown registration, settings casing —
and losing them to save a devDependency would be a bad trade on a plugin that intends to be
published. Two TypeScript versions in `devDependencies` is a real wart; it is pinned, documented
here, and collapses to one line the day typescript-eslint supports TS 7.

**Fallback, and it is one line:** if `tsgo` rejects a `tsconfig.json` option, `npm run typecheck`
drops to the already-present 5.9.3. Nothing else in the build depends on the compiler version.

`DESIGN.md` §9.2's tsconfig is unchanged and already TS-7-shaped — it explicitly drops `baseUrl`
and `moduleResolution: node` on the grounds that both are gone in TS 7.

## D6 — `minAppVersion` is 1.7.2

**This decision was wrong, and it was wrong in the way decisions about hypothetical users usually
are.** It is kept below with the correction on top, because the reasoning is instructive.

1.13.0 was chosen for two APIs. One of them, `getSettingDefinitions`, was never implemented — so the
floor was being paid for a feature that does not exist. The other, `Plugin.settings`, is a typing
concern: the emitted JavaScript declares a class field either way.

"Raising the floor orphans nobody" was true when the plugin had zero installs and false the moment
it had one. **Obsidian for iOS trails the desktop.** The first person to try installing this on an
iPhone — the maintainer — got `the Obsidian version of the app needs to be 1.13.0, but this
installation is 1.12.7`. A plugin whose whole point is that it works on mobile was uninstallable on
mobile, to reserve an API it does not call.

The floor now comes from the API surface, and it is not a matter of opinion: `eslint-plugin-obsidianmd`
has a rule, `no-unsupported-api`, that compares every call against `minAppVersion` and fails. Set the
floor, run the linter, read what it names. It found two things a manual read had missed.

`Workspace.revealLeaf` (1.7.2) is what sets the floor — it opens the diagnostics view. Everything
else is older: `getAvailablePathForAttachment` (1.5.7), `vault.process` (1.1.0),
`MarkdownRenderer.render` (0.10.6), `registerView` (0.9.7), `getFirstLinkpathDest` (0.12.5),
`createBinary` (0.9.7), and `setCssStyles`, `setCssProps`, `createSvg`, `addChild`, which predate
the `@since` tags entirely.

Two calls were holding the floor at 1.13 for no benefit, and both are gone:

- `ButtonComponent.setDestructive` paints one button. `setWarning` is deprecated in its favour but
  present since 0.11.0 and still works. Feature-detecting the pair was the first attempt and is
  worse than choosing: the linter reads the call textually, cannot see the guard, and reports the
  error either way.
- `SettingTab.update()` refreshes the settings pane after the cache is cleared. `display()` does the
  same thing and is as old as the class.

The consequence is that the declarative settings API stays unimplemented and the store keeps warning
about it. That is the right trade: it costs settings-search discoverability on 1.13+, and it buys
every user between 1.5.7 and 1.13 — which today includes every iPhone.

---

### The original decision, for the record

## D6 (superseded) — `minAppVersion` is 1.13.0

**Resolves open question 1.**

Declarative settings (`getSettingDefinitions`, which is what puts settings in Obsidian's global
settings search) and `Plugin.settings` require 1.13.0. Under D1 this is a brand-new plugin with
zero installs, so raising the floor orphans nobody, and the alternative — carrying a dual
`display()` path — is code written for users who do not exist. `manifest.json` gets a truthful
`minAppVersion: "1.13.0"` in place of today's `0.12.0`, which is false against APIs that postdate
it by years.

`declare settings: TikzSettings` still needs §7.7's `useDefineForClassFields` care: a plain
redeclaration `[[Define]]`s the base's `settings?: unknown` to `undefined` at construction. That
is a silent runtime break on 1.13+, and it stays a checked release-gate item.

## D7 — Package versions worth recording

Verified on CTAN / GitHub releases, 2026-08-31, for track E1 and the README's honesty table:

| Package | Current | Released | In the bundled engine |
|---|---|---|---|
| pgfplots / pgfplotstable | 1.18.3 | 2026-08-26 | 1.16 |
| pgf / TikZ | 3.1.12 | 2026-08-01 | ~3.1.x (2019 era) |
| circuitikz | 1.8.6 | 2026-05-24 | 0.4 – 1.0 |
| chemfig | 1.8 | 2026-08-30 | 1.4 |
| siunitx | 3.5.6 | 2026-08-23 | absent (v3 needs expl3) |

Before 2025-08 pgfplots had been frozen since 2020, so the gap the bundled engine sits behind is
six years wide, not one. This is the argument for E1 and it belongs in the README rather than
being rediscovered later.

**Update, 2026-08-31 — what our own build actually ships.** The right-hand column above described
artisticat's 2022 blob. Now that the engine is built here, the shipped versions are read out of the
image at build time (`tex-versions.txt`) and are not what the backlog assumed:

| Package | Backlog assumed | **Actually shipped** |
|---|---|---|
| pgfplots | 1.16 | **1.18.1** |
| pgf / TikZ | ~3.1.x (2019) | **3.1.10** |
| tikz-cd | — | 1.0 (2021) |
| amsmath | — | 2.17o (2023) |
| siunitx | absent | still absent (not in `tex_files.json`) |

This matters beyond bookkeeping: `BACKLOG.md` gives **"pgfplots 1.16"** as the *reason* #108 and
#110 are unfixable. On 1.18.1 that reason is gone, and both need retesting rather than closing —
the same correction D8 applied to the expl3 partition, from the same cause: a version table read
off the old blob and never re-derived.

Getting the numbers out at all took two passes. The naive read — echo the `\ProvidesPackage`
bracket — yields `\pgfplotsversiondate\space v\pgfplotsversion` for the whole PGF family, because
the bracket contains macros rather than digits; and the revision files disagree on the assignment
form (`\def\pgfversion` but `\gdef\pgfplotsversion`, the latter inside a `\begingroup`). Each near
miss produced a plausible-looking `unknown`, which is exactly how the #110 compat lint became dead
code in the first place.

## D8 — We build the engine ourselves, from current upstream, and it is in scope

**Supersedes `DESIGN.md` §1.2's "Rebuilding `tex.wasm` / `core.dump` before 1.0" non-goal, §12's
"Track E1 — XL, a parallel track, never a dependency of the roadmap", and — most importantly —
the entire `needs-tex-rebuild` partition of `BACKLOG.md`, which rests on a premise that is false
for the current upstream build.**

`DESIGN.md` treated the vendored 7 MB blob as an immovable black box and sized a rebuild as XL.
That was correct about *artisticat1's 2022 bundle*. It is wrong about the upstream that exists
today, which was inspected directly (`git clone --depth 1`) on 2026-08-31:

| Repo | Last pushed | What it is |
|---|---|---|
| `drgrice1/tikzjax` | **2026-06-08** | the loader + `tex_files.json` + font pipeline. `@drgrice1/tikzjax@1.0.0-beta24` |
| `drgrice1/web2js` | 2025-01-08 | Pascal→WASM compiler for TeX. **Ships a `Dockerfile`** (Ubuntu 24.04) and `npm run build` → `tex.wasm` + `core.dump` |

**Finding 1 — package versions are a build input, not a code change.** `genTexFiles.js` resolves
every name in `tex_files.json` through **`kpsewhich` against whatever TeX distribution is installed
in the container**, and gzips the result. The core dump is produced by `initex.js` from the same
distribution. So "use pgfplots 1.18.3 and pgf 3.1.12" is *change the TeX Live in the Dockerfile
and rebuild*. There is no per-package porting work. The Dockerfile currently installs Ubuntu
24.04's apt `texlive`, i.e. **TeX Live 2023**; swapping that for TUG's net installer is the whole
of the change.

**Finding 2 — expl3 works, and the "impossible" partition is stale.** `drgrice1/web2js` applies a
stack of TeX change files (`changes/change-order`):

```
etexdir/etex.ch  date.ch  tex-final-end.ch  ord-chr.ch  tokens.ch  inputln.ch
codes.ch  expanded.ch  strcmp.ch  creationdate.ch  filesize.ch  shellescape.ch
wordsize.ch  expand-depth-count.ch  memory.ch
```

`expanded.ch` and `strcmp.ch` add the `\expanded` and `\pdfstrcmp` primitives — **precisely what
expl3 requires and what plain e-TeX lacks.** `expl3.sty`, `l3backend-dvips.def` and `xparse.sty`
are already in `tex_files.json`, and the README lists `xparse` as a working package (modern
`xparse` is expl3-based, so it could not work otherwise).

Consequence: the ~37-issue `needs-tex-rebuild` partition in `BACKLOG.md` — siunitx v3 (#30),
forest (#86), modern chemfig (#22, #50), mathtools, tcolorbox — was justified by "the bundled
engine is plain e-TeX 3.14159265-2.6 with no `\expanded`". That sentence describes the **2022
blob**, not the engine we are going to build. **Those issues are re-opened as candidates and must
be re-tested against the new engine before anything is called wontfix.** `tex_files.json` also
already carries `pgflibrarypatterns.code.tex` *and* `pgflibrarypatterns.meta.code.tex`, so #59
deserves a retest too.

**Finding 3 — `memory.ch` plus `commonMemory.js` make TeX's memory a knob we own.** The current
drgrice1 build runs `{ pages: 2500 }` = 156.25 MiB, against the 2022 blob's 1100 = 68.75 MiB.
That is the headroom pgfplots needs — and it is also the iOS problem. Because it is a build
constant, we can ship **two dumps from one source**: a lean one for the inlined core engine and a
roomy one for the downloadable extended engine. This is what makes D3's two-tier plan cheap
instead of speculative.

**Consequence for D3.** The extended engine is no longer "adopt `@rod2ik/tikzjax` and hope". It is
our own reproducible build, pinned and checksummed, from `drgrice1/web2js` + `drgrice1/tikzjax` +
a pinned TeX Live. rod2ik is demoted to a cross-check for its file list, not a dependency.

**Order of work.** The engine build moves to **first**, ahead of plugin code. It settles
`ENGINE_ID` (a cache-key input), the generated capability table that drives every error-card hint,
and whether ~37 issues are fixable — all of which the plugin code is written against. Doing it
later means writing that code twice.

**Acceptance for the engine track:** `\usepackage{pgfplots}` with a `\usepgfplotslibrary` compiles;
`\usepackage{siunitx}` compiles (the expl3 proof); the `$\Omega\otimes$` fixture is glyph-correct
(the fontforge step from #2 must not be skipped); and the golden corpus renders byte-stably across
two builds of the same pinned inputs.

## D9 — The plugin is GPL-3.0-or-later, not MIT

**Resolves the second open question and supersedes `DESIGN.md` §9.7's framing of it as unsettled.**

It was framed as a judgement call about aggregating GPL'd `.tex` sources. Inspecting upstream
settles it as a fact instead:

- `@drgrice1/tikzjax` — `"license": "GPL-3.0+"`
- `drgrice1/web2js` — `"license": "GPL-3.0"`

These are the engine and its build, not merely data the engine reads. A `main.js` that embeds
them is a combined work distributed under GPL-3, and no NOTICE file changes that. The PGF/TikZ
(GPL-2+/LPPL) and Knuth/AMS font questions sit underneath and are satisfied by the same route.

So: `LICENSE` becomes **GPL-3.0-or-later**, `package.json` and `manifest.json` follow, and the
README states plainly what is embedded and under what terms. `NOTICE` + `vendor/LICENSES/` +
the generated per-package licence column from D-8's inventory are still built — they are how the
GPL's notice obligations are actually met, not a substitute for the licence change.

Worth recording without making it an accusation: upstream `artisticat1/obsidian-tikzjax` ships the
same engine under an MIT `LICENSE.md`. That is the state this fork inherits and is correcting; it
is also a reason not to publish before the licence is right.

## D10 — We compile our own worker from source; there is no blob to patch

**Supersedes `DESIGN.md` §4.4 in full (`scripts/patch-worker.mjs`, the pinned SHA-256 + exactly-one-
match string patches P0–P6, the module-147 extraction and re-splice), §3.1's `vendor/tikzjax.txt`
and `scripts/extract-worker.mjs`, and the `patch-guard`/`engine-guard` CI steps as described.**

That whole apparatus — string surgery over a 7 MB minified webpack bundle, each edit asserting
exactly one match so it cannot silently become a no-op — was an ingenious workaround for not
having the source. D8 gives us the source. `drgrice1/tikzjax/src/` is 27 KB of readable ES modules:

| File | Role |
|---|---|
| `src/run-tex.js` (3.2 KB) | the worker: `expose({ load, texify })` over `threads/worker` |
| `src/library.js` (14 KB) | the WASM host: virtual filesystem, asyncify unwind/rewind, TeX stdout |
| `src/index.js` (9.4 KB) | the DOM driver — **we do not use this at all**; it is what the plugin replaces |

So we fork `run-tex.js` + `library.js` into `engine-src/`, apply our changes as **ordinary source
edits under review**, and compile with esbuild into the worker string embedded in `main.js`. Every
patch in `DESIGN.md` §4.4's table becomes a readable diff instead of a regex against minified
identifiers. `ENGINE_ID` is still the sha256 of the built worker, and still a cache-key input.

The `TODO.md` §2 checklist items for extraction, re-splicing and match-assertions are void.
What replaces them, from reading the actual source:

1. **Remove both network paths.** `run-tex.js`'s `load(urlRoot)` `fetch`es `tex.wasm.gz` and
   `core.dump.gz`; `library.js`'s `openSync` falls back to `await fetch(filename)` for any
   unresolved name. Assets are injected from the bundle instead. This restores the zero-network
   invariant (§7.11) *by construction* rather than by patching out one bad URL, and it is stronger
   than the old P0.
2. **Load bundled TeX files synchronously.** `openSync` currently unwinds the whole asyncify
   stack, `setTimeout(0)`s, awaits `fileLoader('tex_files/<name>.gz')`, then rewinds — **per file**.
   A pgfplots run opens dozens. Because our files live in an in-memory map, we can populate
   `filesystem[filename]` before the unwind is needed and skip the round-trip entirely. This is a
   larger win than anything in the old patch table and was not available while the engine was a blob.
3. **Drop `coredump.slice(0)`** in `texify` — a redundant full copy of the dump. At `pages = 2500`
   that is **156.25 MiB per render**, not the 68.75 MiB the old P1 targeted.
4. **Keep the decompressed bundled files across runs.** `deleteEverything()` clears `filesystem`
   wholesale, so the pgf/pgfplots tree is re-inflated on every render. Bundled files move to a
   separate map that survives; only per-job files are cleared. (Old P6, now free of its "changes
   VFS lifetime, ship behind a setting" caveat, because we control the lifetime explicitly.)
5. **Conditional document wrapping.** `texify` unconditionally wraps
   `\begin{document}…\end{document}` around the source. Every existing Obsidian ` ```tikz ` block
   writes its own (README:29), so this would nest document environments in every note in every
   vault. Our fork wraps only when the source does not already contain one — and `%!tikz` gets a
   `wrap=on|off|auto` override. This is the same hazard D3 flagged in rod2ik, from the same
   upstream lineage.
6. **`\nonstopmode`** into the preamble, plus the timeout and terminate-and-respawn, unchanged.
7. **Pin the clock for reproducible builds.** `library.js` exports `getCurrentYear/Month/Day/
   Minutes` straight from `new Date()`, and TeX stamps them into the output. The golden corpus
   cannot be byte-stable across days unless these are pinned under a deterministic flag. This was
   not visible while the engine was opaque, and it would have shown up as a mysteriously flaky
   golden suite on the second day of CI.

**What survives from §4.4:** the pinned upstream refs (`engine-build/pins.env`), the checksums over
built artifacts, and the rule that a bump is validated against the golden corpus before it ships.

**Licence note.** `library.js` and `run-tex.js` are GPL-3.0+ (D9). Forking them into `engine-src/`
is exactly what the GPL is for, and the fork carries the upstream header, attribution to Jim Fowler
and Glenn Rice, and a `CHANGES` note listing our modifications.

---

## D11 — The two patches the build does apply, and why they are patches

D10 says there is no blob to patch, and there is not: the shipped worker is our own source. But the
BUILD still runs upstream's `web2js` and `tikzjax` repositories to produce the engine, and two of
their files are wrong for what we ask of them. Both are patched in `build-engine.sh`, each guarded
by a grep before and a grep after, so a silent no-op fails the build rather than shipping something
subtly broken.

**1. `tikzjax/genTexFiles.js` reads every bundled file as UTF-8.**

`pako.gzip(fs.readFileSync(sysFile, 'utf8'))` is fine while the bundle is all `.tex` and `.sty`. The
moment a `.tfm` goes in — and font metrics are exactly what this engine was missing — every byte
above 0x7F becomes U+FFFD and the metrics are destroyed. Read as bytes.

**2. `web2js/library.js` closes a written file with an ASYNCHRONOUS write.**

```js
close(descriptor) {
    if (file.writing) fs.write(file.descriptor, Buffer.concat(file.output), () => {});
    fs.close(file.descriptor, () => {});
}
```

`initex.js` runs TeX twice in one process: the first turns `latex.ltx` into `latex.fmt`, the second
loads that format and freezes the whole `WebAssembly.Memory` into `core.dump`. The format is
accumulated in memory by `put()` and written out by that `close()` — so 21 MB go to the libuv
threadpool with the callback discarded, while the script continues synchronously into a second TeX
that reads the file back with `readFileSync`.

It is a race, and on a quiet machine the writer wins every time: five runs out of five here. On a
GitHub runner it loses about half the time and the build dies with `(Fatal format file error; I'm
stymied)` — two failures in four runs, with byte-identical `tex.wasm` and `tex.pool` each time,
which is what ruled out every explanation involving different inputs. `writeSync`, `closeSync`.

The runtime never had this problem: `engine-src/library.ts` has no filesystem, only a `Map`, and its
`close` touches nothing.

Applying the patch changes no artifact. `tex.wasm` and `tex_files.json` come out with the same
sha256 as before it; `core.dump` differs only because TeX freezes the current date into memory,
which is the known non-determinism recorded in D8's list.

**Why patch rather than fork these two as well.** They run at build time, in a container, and their
output is checked by everything downstream: the dump has to be exactly `pages × 65536` bytes, 21
fixtures have to render through it, and `verify-fork` has to find that output byte-identical to
upstream's engine. A fork would have to be kept in step with upstream for no gain those assertions
do not already provide. The shipped code is code we own; the build tools are borrowed, and the
build says so out loud when it borrows them.

---

## D12 — The compressed engine is committed, and the build that produces it is reproducible

**Amends D8.** D8 said the engine is built from source in a container and never committed, because
`core.dump` is 156 MiB and the whole point was to stop treating the engine as an opaque blob. The
first half stands. The second half was wrong in a way that only showed up when someone else tried
to build this: the community store's review runs `npm run build` in a clean checkout, and it failed
with `engine-build/out/ is missing or incomplete`. So does every contributor without Docker, and
every contributor with Docker who does not want to spend fifteen minutes before their first edit.

So the compressed engine is committed — 8.5 MB across 402 files:

| Path | Size | What reads it |
|---|---|---|
| `engine-build/out/tex.wasm.gz` | 0.12 MB | `scripts/engine-assets.mjs` |
| `engine-build/out/core.dump.gz` | 5.66 MB | `scripts/engine-assets.mjs` |
| `engine-build/out/dist/tex_files/*.gz` (245) | 1.25 MB | `scripts/engine-assets.mjs` |
| `engine-build/out/dist/fonts/*.woff2` (152) | 1.46 MB | `scripts/gen-styles.mjs` |
| `engine-build/out/tex-versions.txt` | tiny | the shipped inventory |

Everything else in `out/` stays ignored, including the uncompressed 156 MiB dump, the logs, and
upstream's own 6.8 MB `dist/tikzjax.js`, which this plugin does not use at all.

**What makes this defensible rather than lazy is that the build is reproducible**, so the committed
bytes are a claim CI can check rather than one it has to accept. Two things had to change for that:

1. **The TeX clock is pinned.** TeX reads the date at startup and freezes `\year \month \day \time`
   into the format, and `core.dump` is a snapshot of the entire `WebAssembly.Memory` — so it came
   out different on every build. `build-engine.sh` appends a fixed clock to `web2js/library.js`
   before the dump. Two consecutive builds now produce the identical `core.dump`
   (`795863279e5b6ee3…`), where before they never did.
2. **gzip is called with `-n`.** It stamps the modification time into the archive header, so the
   two `.gz` files differed even when their contents did not. The 245 `tex_files/*.gz` were already
   clean — pako writes a zero mtime — which is why only these two needed it.

The Engine workflow rebuilds from source and then runs `git diff --exit-code -- engine-build/out`.
A difference means the engine was rebuilt and not committed, or an upstream input moved.

**The guarantee is per-image, and it is worth being exact about that.** `pins.env` pins web2js and
tikzjax by commit and the font archive by SHA-256, but the TeX packages come from `apt-get install
texlive...` against Ubuntu 24.04 with no version pin — that is what `TEXLIVE=apt` means. So: the
same image always produces the same engine, and a rebuilt image produces the same engine only until
Ubuntu ships a texlive update. When that happens this check fails, correctly — the engine really has
changed — and the fix is to rebuild, look at what moved in `tex-versions.txt`, and commit it
deliberately. The alternative, pinning every apt version, buys determinism until the first package
is withdrawn from the archive and the image stops building at all.

**What this does not change.** The engine is still built from pinned upstream sources, still
verified by 21 fixtures and by `verify-fork` asserting byte-identical output against upstream's
engine, and still rebuildable by anyone with Docker in one command. What is committed is its
output, and the repository can now prove that is what the output is.

---

## Open, still needing a human

1. ~~**An iOS device to test on.**~~ **Resolved 2026-08-31: the maintainer has an iPhone and an
   iPad.** The three decisions it gated are now empirical: whether the `targeted` SVGO transform
   becomes the default (#6 needs a repro on device against a fixture), the real mobile memory
   budget, and whether `isDesktopOnly: false` is honest. Each becomes a measurement in the release
   gate rather than a guess.
2. ~~**Licensing of the vendored payload.**~~ **Resolved by D9** — it was a fact to look up, not a
   judgement to make. What remains is not a decision but a task: relicense before publishing.
3. **New, and genuinely open: how far to chase the re-opened issues.** If D8's expl3 finding holds,
   a large block of "impossible" issues becomes merely *work* — siunitx, forest, tcolorbox,
   mathtools, modern chemfig. Each costs bundle size (more `tex_files`) and dump size. The
   boundary between "in the core engine", "in the extended engine" and "still not doing it" is a
   product call that should be made against measured sizes, once the first build exists — not now.
