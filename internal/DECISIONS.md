# Decisions that supersede DESIGN.md

`internal/DESIGN.md` is the output of a recon + design panel. It was written **before**
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
  against 23.14 MB for `typescript@6.0.0-beta` (the last JS-based line — which this list got wrong:
  6.0.2 and 6.0.3 were already released, on 2026-03-23 and 2026-04-16), one `tsc` bin and no
  `tsserver`, and the classic compiler API replaced by `./unstable/{ast,fs,sync,async}` exports.
- `engines: node >=16.20.0`; the dev machine is Node 22.19.

Decision:

| Job | Tool |
|---|---|
| Typecheck (`npm run typecheck`, CI, pre-commit) | **`typescript@7.0.2`**, `tsc --noEmit` |
| Fast lint in the dev loop | **`oxlint@1.87.0`** — Rust, no TS program, milliseconds |
| Store-compliance lint (CI gate) | **`eslint@10.12.0` + `typescript-eslint@8.71.2` + `eslint-plugin-obsidianmd@0.4.2`**, on `typescript@5.9.3` installed as a plain devDependency. The original note said npm `overrides` supplied it; it never did, and `overrides` only covers the plugin's `obsidian` and `@eslint/js`. Rechecked 2026-10-12: no typescript-eslint release supports TypeScript 7; upstream support is a draft, opt-in backend waiting on TypeScript 7.1 |
| TypeScript 5 cross-check (`npm run typecheck:legacy`, CI) | the same **`typescript@5.9.3`**, by path |

`eslint-plugin-obsidianmd` is kept deliberately: it encodes the community-store rules
(`§9.7`) — no `innerHTML`/`outerHTML`, no global `app`, teardown registration, settings casing —
and losing them to save a devDependency would be a bad trade on a plugin that intends to be
published. Two TypeScript versions in `devDependencies` is a real wart; it is pinned, documented
here, and collapses to one line the day the store's review lints with TypeScript 7 and
typescript-eslint loads on it.

**Why the linter's TypeScript is 5.9.3 and not 6.0.3 — corrected 2026-10-12.** Until this date the
reason given here, in `package.json` and in the lint config was typescript-eslint's peer cap,
`>=4.8.4 <6.1.0`. That cap alone would allow `typescript@6.0.3`, and the October dependency audit
tried it: `tsc --noEmit` clean and `eslint .` byte-identical to the 5.9.3 run. The cap was never
what held 5.9.3. What does is the community store. Its review lints this code through TypeScript 5
— `eslint-plugin-obsidianmd` itself depends on `typescript` 5.4.5 — and from September until
2026-10-12 it flagged a declaration that TypeScript 7 accepted and TypeScript 5 turned into an error
type, silently untyping the worker's inventory (`types/virtual-engine-assets.d.ts`). `lint:store`
and `typecheck:legacy` exist to see the code the way that review does, so they stay on a
TypeScript 5. The trigger to move is the store's toolchain moving, not a release on npm, and
`.github/dependabot.yml` ignores TypeScript majors for that reason.

The `overrides` block is not needed to install, contrary to `DESIGN.md` §9.7's warning: with it
removed, npm resolves the tree without a peer conflict by nesting `obsidian@1.12.3` and `@eslint/js`
9 under `eslint-plugin-obsidianmd` (checked 2026-10-12, npm 10.9.3). What it does is make the store
rules read the root `obsidian` typings and `@eslint/js` rather than their own older copies, and that
is the reason it stays.

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

**Both tables below are snapshots from 2026-08-31 and have since gone stale**, in both directions:
CTAN has moved on (circuitikz 1.8.7, chemfig 1.82, siunitx 3.6.4 by 2026-10-12), and the engine now
ships siunitx 3.3.10, which the second table calls absent. What ships is
`engine-build/out/tex-versions.txt`, generated by the build; what upstream has is a dated list in
`TODO.md` E1. Neither is worth copying into another file, which is how these went stale.

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
(Since 0.1.5, literally so: the sha256 of the minified worker bundle with the id replaced by a
placeholder, `scripts/engine-assets.mjs` `buildWorker`. Before that it hashed a list of the
worker's inputs, which left out the npm packages bundled into it and the contents of the TeX files.)

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
   that is **156.25 MiB per render**, not the 68.75 MiB the old P1 targeted. (Since 0.2.0 the dump
   is not written whole either: a run's new Memory is zero already, so it gets only the dump's
   non-zero runs, 22.3 MiB, and those are all the build ships and the worker inflates at boot.
   D18.)
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

## D11 — The patches the build does apply, and why they are patches

D10 says there is no blob to patch, and there is not: the shipped worker is our own source. But the
BUILD still runs upstream's `web2js` and `tikzjax` repositories to produce the engine, and two of
their files are wrong for what we ask of them. Both are patched in `build-engine.sh`, each guarded
by a grep before and a grep after, so a silent no-op fails the build rather than shipping something
subtly broken. Two more, added in 0.1.5, are to an npm package the worker bundles, and are applied
by the bundler (3 and 4, below).

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

**3. `@drgrice1/dvi2html` never reads the last character of a font.**

Its TFM reader loops `c < this.largest_character_code`, one short, so the last character of every
font has no metrics: `cmr10`'s 127 is the dieresis accent, `cmsy10`'s is `\spadesuit`, and a diagram
that uses one fails with "Could not find font metric for 127" — every ä, ö and ü, and `\"u` written
by hand. `scripts/dvi2html-patch.mjs` is an esbuild plugin that changes the `<` to `<=` as the worker
is bundled. It requires exactly one match before, checks the fix is there after, and fails any build
that bundles dvi2html without applying it, so it cannot become a silent no-op, and it will fail
loudly the day an upstream release carries the fix. Every bundling of dvi2html goes through it —
the worker, smoke, verify-fork and scan-native. All 17 SVGs that rendered before are byte-identical
after it, and all 112 fonts in dvi2html's table end on a character of real width, so none reads a
character that is not there. The upstream patch is prepared; when a release includes it, this one
goes.

**4. `@drgrice1/dvi2html` has no glyph for some characters it has metrics for.**

It draws character c of a font as a codepoint of that font's BaKoMa face, looked up in a table its
`tools/glyphs.js` generates by matching each BaKoMa glyph's name with the name `dvips-all.enc` gives
the character. Where the two names differ the character has no entry, and `putText` fails on it with
"Cannot read properties of undefined (reading 'toString')". Of the characters its 112 fonts have
metrics for, 302 have no entry: character 32 of the roman, bold, slanted, italic and sans text
fonts, the stroke LaTeX's `\L` and `\l` set over an L and an l, so every Ł and ł failed; character
36 of the text italics, which is £ there where the upright fonts have $; the symbols of `lasy`; and
some of `cmtex` and `cmvtt`.

BaKoMa puts character c of every face at one codepoint: U+F0A1 + c below 10, U+F0A3 + c up to 32,
U+F000 + c up to 126, U+F0C4 for 127. Measured against the shipped faces, the table points at the
same glyph as that rule for 13,120 of the 13,128 characters it has — the eight others are in
`cmtex` and `cmvtt`, and stay as the table has them — and each of the 302 is in its face at that
codepoint. The same plugin makes the lookup fall back to it, only where the table has no entry, so
a character that drew before draws exactly as it did. It is guarded like 3: exactly one match
before, present after. All 21 SVGs that rendered before are byte-identical after it, and the
`l-stroke` fixture draws Ł and ł in roman, bold, italic and sans. In typewriter type TeX itself sets
`cmtt`'s character 32 for the stroke, which in that font is the visible space `␣`: that is in the
DVI, so the converter is right to draw it. The fix belongs in `tools/glyphs.js`, where it would
settle the eight as well, and goes upstream in the same PR as 3.

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

What `main.js` carries of the dump is not this archive as it stands. Since 0.2.0 the plugin build
inflates it, cuts it into its non-zero runs and gzips only those, with pako at level 9 so that every
Node gives the same bytes (`scripts/engine-assets.mjs` `packCoreDump`, D18). The committed archive
is unchanged by that, and is still what the Engine workflow rebuilds and diffs.

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

**Across machines, and the month it took to get there.** Two runs of one image always produced
identical bytes: 399 files and both archives, checked. Different images did not, and the reason was
invisible until `BUILD-MANIFEST` started carrying a hash of the 146 files the format is built from —
`latex.ltx`, the LaTeX kernel and its configuration, none of which are bundled. Every image had a
different hash, and the hash was stable within an image.

That was read, on 2026-09-02, as "Ubuntu's TeX Live moves", and the Engine check was softened to a
warning on that basis. **The reading was wrong.** Ubuntu 24.04's texlive packages never changed. What
changed was `language.dat`, the hyphenation configuration Debian's `update-language` writes at
install time by walking a Perl hash — and Perl randomises hash order per process. Measured in the
image on 2026-10-12: three plain runs of `update-language`, three different sha256; three runs with
`PERL_HASH_SEED=0 PERL_PERTURB_KEYS=0`, one. `latex.ltx` reads that file while the format is built,
so every image produced a different `core.dump`. The Dockerfile now regenerates it with the seed
pinned, and prints its hash in the build log. The warning had been firing on all seven Engine runs
since, on a cause that did not exist; a check that is always yellow is read as no check.

The engine rebuilt this way renders all 17 SVG-producing fixtures byte-identically to the one it
replaced — `language.dat` orders hyphenation patterns, which no fixture exercises — but the dump
bytes differ, so ENGINE_ID moves and every user's cache is recompiled once, with identical results,
in the release that ships it. That is the price of a build anyone can reproduce.

What the Engine workflow checks now:

| inputs | engine | verdict |
|---|---|---|
| same | same | pass, byte for byte — the expected result on every run |
| differ | differs | a warning, with the evidence printed. A texlive update, or another source of disorder like `language.dat` was. Find out which before rebuilding |
| same | differs | an error. Same inputs, same sources, different bytes — a real defect |

Pinning every apt version would remove the middle row, and it buys that only until the first package
is withdrawn from the archive and the image stops building at all.

**What this does not change.** The engine is still built from pinned upstream sources, still
verified by 21 fixtures and by `verify-fork` asserting byte-identical output against upstream's
engine, and still rebuildable by anyone with Docker in one command. What is committed is its
output, and the repository can now prove that is what the output is.

---

## D13 — A golden corpus carries what verify-fork proved

**Amends D10, D11 and D12, which rest the claim that the fork changed nothing on `verify-fork`.**

`scripts/verify-fork.mjs` rendered every fixture twice, through upstream's `library.js` exactly as
shipped and through `engine-src/library.ts`, both driving the same `tex.wasm`, and required the two
SVGs to be byte-identical. That is what let D10's changes be called a refactor. It needed upstream's
host to be able to run our engine, and upstream's host loads every file by unwinding the wasm stack
with asyncify and rewinding it when the file has arrived. Asyncify cost this engine nearly half of
its TeX time, and an engine built without it has no unwind for upstream's host to call: the
comparison would have nothing on one side.

So what verify-fork proved is recorded instead. `test/fixtures/golden` holds what the 0.1.5 engine
produces through the fork for each fixture: the sha256 of the DVI TeX wrote (`dvi.sha256`), the
transcript (`<name>.log`), and the SVG the patched dvi2html draws (`<name>.svg`), 115 KB for 27
fixtures. `npm run verify:golden` renders every fixture through the committed engine and the fork and
requires all three to be byte-identical. CI and the Engine workflow run it where they ran
verify-fork, which went with asyncify (D14).

The corpus was checked against upstream when it was recorded. On the 0.1.5 engine, upstream's
`library.js`, given the fork's fixed date for TeX's clock (it reads `new Date()`, and TeX stamps the
date into the DVI), produces the same DVI and the same SVG as the corpus for the 24 fixtures
verify-fork compared, and the same transcript for 22 of them. In `ts1-currency` and `ts1-small-caps`
the transcript names a file neither host has, `omscmr.fd`, differently: upstream treats a missing
`.fd` as an empty file and prints `("omscmr.fd")`; the fork reports it missing (its change 6), so TeX
tries again under its `TeXinputs:` area, which the fork answers with an empty file as upstream does,
and prints that name. `mathfrak` and `mathscr`, which upstream's host does not survive, are recorded
from the fork alone, as verify-fork's skip list already had it.

So the chain is: on 0.1.5 the fork matched upstream; the corpus is 0.1.5's output; every later
engine and host has to match the corpus. Two things differ from verify-fork:

- A fixture added later has no upstream reference. Its golden output is recorded from the engine of
  the day, and proves only that nothing changed after that.
- It is stricter. verify-fork drew both sides through the same converter, so a dvi2html change that
  altered every SVG passed it; here it fails, and the DVI checksum says whether the engine or the
  converter moved. Every fixture is compared, the two documented limits included, where verify-fork
  skipped them.

An intended change to a fixture's output is recorded with `npm run verify:golden -- --update` in the
commit that makes it, and that commit says why; the corpus's diff is then exactly the change. A
fixture with no golden output fails until it is recorded, and golden output for a fixture that no
longer exists fails until it is removed. The corpus has a `.gitattributes` of its own, `-text`, so a
Windows checkout does not give the transcripts CRLF endings, and the fixtures are read with LF line
endings whatever the checkout. A Windows checkout gives them CRLF, and TeX sees the CR: it is printed
in `broken`'s error context as `^^M`, and it makes the `expl3` diagram 3.33 pt wider, a DVI of its
own. Recorded from CRLF sources, the corpus failed on an LF checkout, which is what CI has. With LF
sources the 0.1.5 engine through the fork matches the corpus for all 26 fixtures it finishes, and
through upstream's host for the same 24 and 22 as above.

`engine-src/upstream/` stays as it is: it is what the fork's list of changes is written against.

---

## D14 — The engine is built without asyncify, and held to WebAssembly 1.0

**Amends D10's item 2, which took the asyncify round trip out of file loading but left the
instrumentation in.**

Upstream's build optimises the compiled engine with `wasm-opt --asyncify`. Asyncify rewrites every
function so that the whole stack can be unwound to the host and later rewound, and upstream's host
unwinds to fetch each TeX file. Since D10 our host never unwinds: every file is in memory. But the
instrumentation stayed in every function, and every call in TeX paid for it.

`build-engine.sh` now optimises with `wasm-opt --mvp-features -O4` (binaryen 99.0.0, web2js's own)
in place of upstream's `build:asyncify-wasm`, which it checks is still the step it replaces.
Measured in Node 22.19 on the Windows desktop the engine is maintained on, TeX's own time
(`executeAsync`, nothing else) over the 26 fixtures, the minimum of three runs of each, summed:

| | 0.1.5 | without asyncify |
|---|---:|---:|
| TeX time, 26 fixtures | 4,572 ms | 2,641 ms (−42%; −33% to −45% per fixture) |
| `tex.wasm` | 526,378 B | 356,290 B |
| `tex.wasm.gz` | 121,527 B | 77,263 B |
| `core.dump` | `86e786be…` | the same bytes |

That is V8. Nothing has been measured on an iPhone, and JavaScriptCore's costs are not V8's. The dump
being byte-identical says asyncify never touched TeX's memory: the format and the dump run computed
the same thing with it and without. Every fixture's DVI, transcript and SVG are byte-identical too
(D13).

**The one jump that used it.** TeX's `jump_out`, where a fatal error, a capacity overflow and a
hundredth error all end up, is `goto end_of_TEX`: a jump out of every procedure at once, which
WebAssembly has no instruction for. web2js compiles it into an asyncify unwind. Upstream's host then
waits for `tex_final_end`, which that jump skips, so a run that reached it never ended: "TeX capacity
exceeded", an emergency stop in nonstop mode, a hundred errors, each waited for the plugin's timeout
and was reported as slow rather than with TeX's message. The build now has web2js compile the jump
into a call to `library.jumpOut` followed by `unreachable`, and `jumpOut` throws; `executeAsync`
catches exactly that, ends the run and flushes what TeX was printing. The `runaway-macro` fixture,
a macro that expands to itself, ended smoke with "unsettled top-level await" on the 0.1.5 engine; it
now ends in 40 ms with "TeX capacity exceeded, sorry [input stack size=5000]", which the worker
reports as a capacity error. What the jump does not do is TeX's `close_files_and_terminate`, so the
transcript stops at the error's context, and a DVI begun before the jump would lack its postamble.
That needs a page shipped before a fatal error, which a picture, shipped at `\end{document}`, does
not do; web2c's `jump_out` closes the files first, and a change file could do the same here. D17
does.

**WebAssembly 1.0, and nothing later.** The engine has to compile in every WebView minAppVersion
1.7.2 admits, iOS 14.5's and Chromium 106's among them, and later features give this code nothing:
built with sign extension, bulk memory, SIMD and the rest enabled, binaryen 132's -O4 emits the same
instructions (measured 2026-10-12). So `--mvp-features` is pinned in the build, where it also makes
wasm-opt refuse an input that uses a later feature, and `scripts/wasm-mvp.mjs`, which decodes every
section and instruction, holds the committed `tex.wasm.gz` to it in the tests and the freshly built
one in the Engine workflow. Two flags are left out on purpose: `--all-features`, with which binaryen
132 writes an import encoding V8 rejects, and `-tnh` (traps never happen), which was not measurably
faster and lets binaryen assume that no instruction ever traps, so that a fault which stops the run
today, an access out of bounds say, could be optimised into one that runs on.

Optimising the same `out.wasm` with binaryen 132 instead of web2js's 99 measured 4% less TeX time
(2,453 against 2,563 ms over 27 fixtures, the same method), and running 99's -O4 twice or its -O3
nothing. That would add a build dependency web2js does not pin, so it is left for later
(`TODO.md`).

Every cached diagram is compiled once more after the update, because ENGINE_ID, the hash of the
worker bundle, changes with `tex.wasm`.

---

## D15 — TeX hashes control sequences into 131,071 slots, not 1,777

**Amends D8's finding 3: `memory.ch` sizes TeX's tables, and one of its numbers was left behind.**

web2js's `changes/memory.ch` gives TeX room for 600,000 control sequences (`hash_size`) and leaves
`hash_prime`, the number of slots a name is hashed into, at tex.web's 1,777. TeX chains a name whose
slot is taken into a free slot elsewhere in the table, so the 33,822 names in the dump hung in chains
19 long, and finding a name visited 11.3 slots on average, comparing names as it went. A fixture's
run ends with between 34,075 names (`runaway-macro`) and 51,463 (`circuitikz`).

`build-engine.sh` now sets `hash_prime` in `memory.ch`'s replacement text before the build, leaving
the text it replaces, which has to match tex.web, alone. Each candidate was built and measured: the
chains over the dump each build produced, TeX's time over the nine fixtures that take longest (the
minimum of nine runs each, Node 22.19, the machine of D14, all candidates in one process), the
archive, and the part of the dump that is not zero, counted in 4 KiB blocks:

| hash_prime | slots visited to find a name | longest chain | TeX time, 9 largest | core.dump.gz | dump not zero |
|---:|---:|---:|---:|---:|---:|
| 1,777 | 11.31 | 59 | 2,055 ms | 5,938,537 B | 21.59 MiB |
| 65,521 | 2.15 | 26 | 2,041 ms (−0.7%) | 5,977,785 B | 21.91 MiB |
| **131,071** | 2.04 | 27 | 2,022 ms (−1.6%) | 5,993,857 B | 22.39 MiB |
| 262,139 | 1.97 | 25 | 2,027 ms (−1.4%) | 6,010,960 B | 23.38 MiB |
| 510,007 | 1.94 | 26 | 2,033 ms (−1.1%) | 6,026,862 B | 25.27 MiB |

The gain is small and the runs are noisy: an earlier run of the same comparison gave 2,087, 2,039,
2,033 and 2,025 ms for 1,777, 65,521, 131,071 and 510,007, and over all 27 fixtures 131,071 measured
1.7% and 3.6% less than 1,777 in two runs. The primes above 1,777 differ from each other by less
than one run differs from the next.

TeX's hash is `h = 2h + c` over the name's characters, so names whose characters trade off against
each other hash alike whatever the prime. That is why the longest chain stays at 25 to 27 for every
prime from 65,521 up, and why the slots visited level off near two: past about 65,521 a larger prime
buys nothing measurable. What it does cost is memory. The names spread over `hash_prime` × 8 bytes
of the table, which the archive carries (in `main.js`, as base64) and a reset that writes only the
dump's non-zero bytes copies on every render. 131,071 (2^17 − 1) takes the gain for 0.8 MiB and 55 KB,
where tex.web's 85% of `hash_size`, 510,007, would take 3.7 MiB and 88 KB for the same time, and it
leaves room for a document that defines twice the names `circuitikz` does.

`hash_size` stays at 600,000. It is more than ten times the most names any fixture defines, and it
sizes the hash table and the part of `eqtb` that belongs to control sequences, which is the memory
layout the dump is cut to. Where each name sits in the table moves; the table does not. Every
fixture's DVI, transcript and SVG are byte-identical (D13), the dump's bytes are not, and ENGINE_ID
moves with them, in the release that already recompiles every diagram for D14. Two Docker builds
produced the same 411 files.

With D14, in one run of all three engines over the 26 fixtures 0.1.5 had (the minimum of three runs
each, summed): 0.1.5 4,632 ms, without asyncify 2,560 ms, with this as well 2,481 ms, 46% less than
0.1.5 and 38 to 49% less per fixture. `tex.wasm.gz` is 77,265 B where it was 121,527, `core.dump.gz`
5,993,857 B where it was 5,938,537, and `main.js` 12,334,806 B where it was 12,320,058: the
engine's archive lost 44 KB and the dump's gained 55 KB, both carried as base64.

---

## D16 — Change files of our own give TeX what LaTeX asks of it

**Amends D8, which takes the change files web2js applies as the whole of this engine's TeX.**

web2js builds TeX from `tex.web` and fifteen change files, e-TeX's and fourteen of its own, which
add the primitives expl3 needs (D8). LaTeX asks the engine for more than that, and where a
primitive is missing it either fails or quietly takes an older path. `engine-build/changes` holds
change files of ours. `build-engine.sh` appends them to web2js's `changes/change-order`, so tie
applies each to TeX as web2js's left it and stops the build if a change no longer finds the text
it replaces, and then checks that the merged source carries each of them. The Dockerfile copies
them into the image, and BUILD-MANIFEST names them.

**`\ifincsname`.** pdfTeX's conditional, true while TeX expands what stands between `\csname` or
`\ifcsname` and the `\endcsname` that ends it. LaTeX defines `~` as `\ifincsname` … `\else
\nobreakspace \fi`, so on this engine every `~` was "Undefined control sequence", "Extra \else" and
"Extra \fi", and drew the tilde, character 126 of the text font, ahead of its space: the `tilde`
fixture came out 5.85 pt wider than it should. `ifincsname.ch` is pdfTeX's code for it, as
`pdftex.web` has it: a flag, saved and set before `\csname` and `\ifcsname` expand their tokens and
restored after, so a `\csname` inside another leaves the outer one's flag as it found it. With it,
the `tilde` fixture's DVI is byte-identical to the one TeX Live 2023's `latex` (pdfTeX in DVI mode)
writes for the same body behind the preamble the dump was made with, with `SOURCE_DATE_EPOCH` set
to the engine's fixed date (run in the engine image); the engine before it differed in the width of
the page.

The format changes with it. LaTeX's `utf8.def` asks whether `\ifincsname` exists and, on an engine
without it, loads `utf8-2018.def` instead, the UTF-8 support LaTeX had before 2019, kept for old
e-pTeX builds. This engine had been loading that. Now it loads `utf8.def`'s own code, as pdfTeX
does, in which a UTF-8 character is a `\protected` macro that gives its own bytes inside a
`\csname`. The format is built from 145 files rather than 146, and BUILD-MANIFEST counts them now
instead of saying 146. expl3 copies the primitive to `\tex_ifincsname:D` and uses it nowhere; of the
other packages in TeX Live 2023 that test it (kvsetkeys, kvdefinekeys, babel, hologo, thmtools),
none is bundled. All 27 fixtures that were there before give the same DVI, transcript and SVG
(D13), and `scan:native` finds the same characters native. `tex.wasm` is 356,483 B, 77,339 gzipped,
and `core.dump.gz` 5,994,457 B; ENGINE_ID moves, in the release that already recompiles every
diagram. Two Docker builds produced the same 411 files.

None of those fixtures puts an accented letter where LaTeX makes a name of it, and that is where the
two UTF-8 supports differ. Rendered through the shipped workers of 0.1.5 and of this engine, a node
named `(café)`, a style named `grün` and `\edef\x{Grüße}` each failed on 0.1.5, with "Missing
\endcsname inserted", "Extra }, or forgotten \endgroup" or "Missing } inserted", and draw now; a
`\label{éq:ü}` with its `\ref` drew on 0.1.5 with "Missing \endcsname inserted" and a different
picture (1,621 B of SVG), and now draws with no error (1,168 B). `utf8-names` holds the four
together; on 0.1.5's engine it never finished.

**`\filesize` of a file that does not exist is empty.** web2js's `filesize.ch` prints whatever the
host's `getfilesize` returns, and both hosts, web2js's `library.js` that the format is built with
and `engine-src/library.ts`, returned 0 for a file they did not have. pdfTeX prints nothing. The
LaTeX of TeX Live 2023 has `\IfFileExists` ask `\filesize`, through expl3's `\file_full_name:n`,
and take any answer that is not empty for a file that exists, so on this engine every file
existed: a missing package was found and read as an empty file, and so was every `\input` of a
missing file and every probe for an optional file. The hosts now answer -1 for a file they do not
have, and `filesize-missing.ch` has `\filesize` print the size only when there is one. `library.ts`
looks the name up, in the run's own files, dvi2html's font metrics and the bundle, rather than
opening it as upstream did, so asking puts nothing in the run's table of files; a file TeX wrote
earlier in the run exists, with size 0, because that is how the host reads it back.

A missing package then stopped TeX at once, as it does on any TeX: LaTeX reports "File `x.sty' not
found", asks for another name, and TeX in nonstop mode cannot read one, so it ended with an
emergency stop, and the card showed LaTeX's message. 0.1.5 drew such a diagram, with the package
read as empty, and anything the package would have defined was an undefined control sequence further
on. A diagram that loads a package it does not use, `inputenc` or `fontenc` say, rendered in 0.1.5
and failed. D19 has the worker answer LaTeX's question as Return does, so such a diagram is drawn
again, with LaTeX's message on it. Every transcript changes in one place: LaTeX looks for
`input.aux` at `\begin{document}`, and where it used to find an empty file under the `TeXinputs:`
area it now says "No file input.aux.", as LaTeX does on a first run anywhere; the TS1 fixtures no
longer read a missing `omscmr.fd`. Every DVI and SVG is as it was.

The format changes as well. While it is built, expl3 sets `\c_sys_platform_str` by asking whether
`nul:` and `/dev/null` exist; with `nul:` found it said `unknown`, and now says `unix`, as on any
Linux TeX. `utf8.def` no longer reads `omlenc.dfu`, `omxenc.dfu` and `uenc.dfu` as empty files,
because they do not exist, and expl3's cache of files it has found no longer lists them,
`l3bitset.sty` or `nul:`. pgf 3.1.12, which TeX Live 2026 brings, decides how to load a library
with `\IfFileExists`, so this has to come before that engine (`TODO.md`, E1).

---

## D17 — A fatal error ends the run the way TeX ends it

**Amends D14, which ends the run at TeX's jump out and leaves TeX's own ending out.**

Since D14 TeX's `jump_out` calls the host's `jumpOut`, which ends the run where it stands. In
`tex.web` the jump goes to `end_of_TEX`, where `close_files_and_terminate` finishes the DVI file,
says "No pages of output." or "Output written on …", and closes the transcript; the jump through
`jumpOut` passed over all of it. TeX writes its DVI in halves of a 16,384-byte buffer, so a page it
had shipped before the error, which in a diagram is smaller than that, never reached the file: the
DVI came out empty and the diagram failed, where any other TeX draws the page. The transcript
ended at the error.

Section 81 of `tex.web` says what a compiler with no jump out of a procedure should do: have
`jump_out` call `close_files_and_terminate` before it ends the program, which is what web2c's TeX
does. `engine-build/changes/jump-out.ch` does that, and `close_files_and_terminate` is written to be
safe after a fatal error (section 1333). The `fatal-after-page` fixture ships a page and then
`\input`s a file that does not exist: it used to come back as an empty DVI and a missing file, and
now its page is drawn and the card shows LaTeX's "File `nosuchfile.tex' not found" with it, as
pdflatex gives a PDF of the pages it shipped before stopping. The transcripts of `runaway-macro` and
`missing-package` end with TeX's own last two lines now, "No pages of output." and "Transcript
written on input.log."; no other fixture changes, and the dump is the same bytes, because nothing
in the format build ends in a fatal error.

**What reaches the card.** TeX prints an error to the terminal and to its transcript file,
`input.log`, except in batch mode, where it prints to the file alone; the worker reads the terminal.
A diagram that switched to `\batchmode` and then failed came back with no error, and a hundredth
error, which ends the run, as "TeX produced no output". When the terminal shows no error, the worker
now reads the file as well, and if the file has one, the card is built from it and the file's lines
join the log, under a line that says where they come from. The file keeps blank lines the terminal
does not, and the worker drops them as it reads it: between LaTeX's "File `nosuchfile.tex' not
found" and TeX's `l.NN` they put the line nine lines down, past where it is looked for, and the card
of `batchmode-missing-file` named no line.

Each way TeX gives up has a fixture, and `verify:worker` holds the reply of the shipped worker to
what the fixture says it must be, then has the same worker draw `basic` and requires the drawing it
gives on its own. In Node, on the desktop D14 was measured on, each failure comes back in under
100 ms, and in 300 to 400 ms the one that loads pgfplots first:

| Fixture | How TeX gives up | Kind | First error on the card |
|---|---|---|---|
| `missing-package` | LaTeX asks for another name; nonstop mode cannot read one, so an emergency stop | `missing-file` | LaTeX Error: File `nosuchpackage.sty' not found. |
| `missing-pgfplots-library` | `\input` of a file that does not exist: "job aborted, file error in nonstop mode" | `missing-file` | I can't find file `pgflibrarypgfplots.nosuchlibrary.code.tex'. |
| `runaway-macro` | a macro that expands to itself: capacity exceeded | `capacity` | TeX capacity exceeded, sorry [input stack size=5000]. |
| `batchmode-errors` | `\batchmode`, then a hundred errors | `tex-error` | Undefined control sequence. |
| `batchmode-missing-file` | `\batchmode`, then `\input` of a file that does not exist | `missing-file` | LaTeX Error: File `nosuchfile.tex' not found. |
| `fatal-after-page` | a page shipped, then a missing file | drawn, with the error | LaTeX Error: File `nosuchfile.tex' not found. |

Since D19 `missing-package` no longer gives up: the worker answers LaTeX's question for it, and the
diagram is drawn with the error.

One way a run ends is not TeX's. Each level of an expansion, or of a box inside a box, is a few
calls deeper in the engine, and something nested a few thousand deep runs out of the worker's stack
before it reaches any limit of TeX's own: the engine throws a RangeError, TeX says nothing and
closes no file, and a page it shipped before is lost. Through the shipped worker in Node 22.19,
3,000 nested `\number` render and 5,000 do not; on 0.1.5's engine 1,000 render and 3,000 do not. The
worker used to report such a run as "TeX produced no output"; it now reports it as a capacity error,
"TeX nested deeper than the engine's stack allows.", with whatever TeX said before it, and
`verify:worker` checks that with 20,000. How deep the stack goes on an iPhone has not been measured.

The plugin's time limit stays as it is. A TeX run is synchronous inside the worker, so a run that
does not end, a `\loop` with no way out say, is still stopped only by terminating the worker; what
no longer reaches the limit is a run TeX itself has given up on.

D16 and D17 cost no TeX time that could be measured. Over the 26 fixtures 0.1.5 had, the minimum of
three runs of each, summed, in Node 22.19 on the desktop of D14, two paired runs of the three
engines gave 8,803 and 8,710 ms for 0.1.5, 4,547 and 4,460 ms for D15's engine, and 4,604 and
4,450 ms for this one. Every figure is about twice D15's because the desktop was busy with other
work while they were taken; the ratios are what the runs show, and the D15 engine and this one are
within a run's noise of each other. `tex.wasm` is 356,500 B, 77,347 gzipped, `core.dump.gz`
5,994,269 B and `main.js` 12,335,931 B, 1,125 B more than D15's. Nothing was measured on an iPhone.
Two Docker builds of the final source produced the same 411 files, the ones committed.

---

## D18 — The core dump ships, and starts each run, as the parts of it that are not zero

**Amends D10's item 3 and D12, which leave the dump whole: in `main.js`, at every boot, and in every
run's memory.**

The dump is the engine's whole memory as the LaTeX format left it, 2,500 pages or 156.25 MiB, and
most of it is zero: TeX's arrays are sized for the largest document it will take, and a diagram
fills a corner of them. Until 0.2.0 all of it went into `main.js` gzipped, every boot inflated all
of it, half a second on the desktop and the worker's largest allocation, and every run copied all
of it into a new Memory, writing every page.

A new `WebAssembly.Memory` is zero by the WebAssembly spec, so only what is not zero needs writing.
The plugin build inflates whatever `core.dump.gz` is committed and cuts it into runs, each starting
and ending on a byte that is not zero, split wherever 4 KiB or more of zeros lie between two of
them; splitting at every zero would make thousands of runs to save a few bytes. It gzips the runs'
bytes, back to back, with pako at level 9 (`scripts/engine-assets.mjs` `packCoreDump`). pako rather
than `node:zlib`, because what deflate emits is fixed by no standard, only what it inflates to, and
`node:zlib` is whichever zlib the running Node bundles: another Node could make another `main.js`
from the same commit. The worker carries the dump's size, the table of runs and the packed bytes. At
boot it inflates exactly the packed length into one buffer (`engine-src/inflate.ts`), checks the
table (in order, apart, inside the memory, no byte left over) and the size against the engine's
pages, and refuses to start on anything else. Each run then gets a new Memory with only the runs
written into it (`engine-src/core-dump.ts`). The committed archive is not changed by any of this,
and is still what the Engine workflow rebuilds and diffs. ENGINE_ID hashes the worker, which holds
the size, the table and the bytes, so it still covers the whole dump; a test moves each of the three
and requires the id to move.

What the reset rests on is tested rather than argued. `test/core-dump.test.ts` builds the memory a
job starts from through the build's encoding and the worker's unpacking and compares it with the
committed dump byte for byte. It also checks the edges of the cut (a zero gap exactly as long as the
split and one byte shorter, runs either side of a page boundary, a dump of all zeros and one with
none), that nothing is written outside the runs, and that a malformed table or a wrong size is
refused. Every fixture renders as the golden corpus records (D13).

With the 0.2.0 engine the dump is 28 runs and 22.3 MiB (23,364,197 B), against 10.8 MiB of bytes
that are literally not zero, and gzips to 5,897,406 B, where the archive of the whole dump is
5,994,269 B. On the 0.1.5 engine it was 28 runs and 21.5 MiB; D15's larger hash table spreads the
names over more of the memory.

The diagnostics view shows, under each compiled diagram, the queue, the engine's start, the memory
reset, TeX, DVI to SVG and the SVG pipeline (DESIGN.md §7.6). The worker times its own steps and
sends them with every reply. Every figure below is V8's, and that view is how the same figures will
be read off an iPhone.

**0.2.0 against 0.1.5.** Measured on 2026-10-13, `release/0.2.0` against `750b363` (built from an
export of it), in Node 22.19 on the Windows desktop of D14, with about a tenth of its CPU busy with
other work. Where there are two figures, they are two separate sets of runs.

| | 0.1.5 | 0.2.0 |
|---|---:|---:|
| TeX time, the 26 fixtures 0.1.5 has, summed | 4,612 and 4,661 ms | 2,539 and 2,546 ms (−45%; −37% to −49% per fixture) |
| Engine start, the worker evaluated until it says `ready` | 528 and 530 ms | 161 and 161 ms |
| Peak resident memory added by the start | 179.5 and 179.3 MiB | 55.5 and 55.0 MiB |
| ArrayBuffers held once started, after a collection | 157.5 MiB | 23.5 MiB |
| Resident memory once started, after a collection | 223.4 and 223.5 MiB | 88.7 and 88.7 MiB |
| Peak resident memory of the process after five renders | 702.6 and 702.7 MiB | 167.5 and 167.5 MiB |
| Memory reset, each render | 28.7 to 29.8 ms | 5.0 to 5.1 ms |
| Memory reset, each render, inside the shipped worker | 24.0 to 26.5 ms | 3.6 to 3.8 ms |
| Instantiating TeX, each render | 0.3 ms | 0.3 ms |
| `basic`, the third render, end to end in the worker | 61 and 63 ms | 27 and 27 ms |
| `pgfplots-axis`, the second render, end to end in the worker | 682 and 699 ms | 366 and 362 ms |
| `tex.wasm` | 526,378 B, 121,527 gzipped | 356,500 B, 77,347 gzipped |
| The dump in `main.js`, gzipped, before base64 | 5,938,537 B, all of it | 5,897,406 B, its non-zero runs |
| `main.js` | 12,320,058 B | 12,242,632 B |

`main.js` was 12,209,619 B when the rest was measured; pgfplotstable's two code files, bundled
since, add 33,013 B to it, and the other rows were not taken again for them.

How each was taken:

- **TeX time**: both engines in one process, interleaved fixture by fixture, the `executeAsync` call
  and nothing else, the minimum of five runs of each fixture, summed; each engine reset its memory
  its own way. Every SVG was compared with what 0.1.5's smoke run wrote, and all were identical.
  `runaway-macro` and the other fixtures added in 0.2.0 are left out, because 0.1.5 never finishes
  some of them.
- **Start, memory and the end-to-end renders**: the worker string exactly as `main.js` embeds it,
  evaluated in a fresh Node process with a stand-in `self`, as `verify:worker` runs it, seven
  processes for each version in each set, medians. Each process rendered `basic`, `pgfplots-axis`,
  `basic`, `tikz-cd` and `basic`. Memory is the process's peak resident size
  (`process.resourceUsage().maxRSS`), and its resident size and ArrayBuffers
  (`process.memoryUsage()`); the resident figures include the 57 MiB Node holds before the worker
  is evaluated.
- **Memory reset**: a new Memory and the dump written into it, each version's own way on its own
  dump, one version per process so that the other's dump is not resident, the median of 15 runs, in
  three processes for each. The worker reports the same step as 4 ms. Inside the TeX-time process,
  which held both engines and both dumps, its per-fixture minima averaged 24.9 ms for 0.1.5 and
  8.5 ms for 0.2.0. Taken again the same way, five processes each, the medians were 28.3 to 30.3 ms
  and 5.0 to 5.1 ms.
- **Memory reset inside the shipped worker**: the worker string as `main.js` embeds it, with
  `WebAssembly.Memory` and `WebAssembly.instantiate` wrapped to time each run from its new Memory to
  the instantiate that receives it, `basic` rendered 40 times in a process, the first three left
  out, the median of the rest, four processes for each version. This is the reset as a render pays
  for it, and the saving the changelog gives, about 20 ms; timed on its own, as above, the same
  step comes out a few milliseconds slower for both versions.

The third `basic` render shows where a small diagram's time goes. In 0.1.5, about 33 of its 61 ms
are TeX and nearly all the rest is the reset; in 0.2.0 the worker reports 22 ms of TeX, 4 of reset
and 1 of DVI to SVG. The start is three times as fast because it inflates 22.3 MiB instead of
156.25; the dump's archive grew by 55 KB with D15, and the packed runs are still 41 KB smaller than
0.1.5's whole dump. Nothing was measured on an iPhone or an iPad, and JavaScriptCore's costs are not
V8's. Every cached diagram compiles once more after the update, because ENGINE_ID changes with the
worker.

---

## D19 — A package the engine does not have is an error LaTeX goes on from

**Amends D16, under which a missing package stopped TeX, and keeps D4: existing blocks render
without edits.**

Since D16 LaTeX knows when a package is missing, and does what it does on any TeX: it prints "File
`x.sty' not found" and asks at the terminal for another name. TeX in nonstop mode cannot read an
answer, so the run ended in an emergency stop and the diagram failed, also when it never used the
package. Every cached diagram compiles again after the update (D14), so a vault whose blocks, or
whose shared preamble file, carry such a line would have turned into error cards all at once, and
pre-flight reads only the block, so a preamble file's line was never even warned about. Each
version's shipped worker in Node 22.19 was given `\usepackage{x}` and a plain `\draw` for the 30
common packages that are not bundled (amsthm, babel, bm, fontenc, geometry, hyperref, inputenc,
lmodern, standalone, textcomp and twenty more), and `[utf8]{inputenc}` and `[T1]{fontenc}`: 0.1.5
drew all 32, the engine of D16 failed all 32.

At LaTeX's prompt, Return goes on without the file: `\@missingfileerror` leaves the name empty, and
`\@onefilewithoptions` loads no package by an empty name. The worker gives that answer for TeX.
`engine-src/document.ts` puts LaTeX's own `\@missing@onefilewithoptions`, with the question replaced
by `\@latex@error`, on the input's first line after `\nonstopmode`, ahead of everything the block
and its preambles load. The run goes on as it does after any other error, and the card names the
file. A diagram that draws without the package is shown with LaTeX's message on it; one that needs
the package fails further down, as in 0.1.5, but the first error on its card is now the missing
file. The same 32 now draw the same SVG as 0.1.5, byte for byte, each with "LaTeX Error: File
`x.sty' not found." on it, and the bundled packages in the same run come out as before.
`missing-package`'s golden output is now that drawing, the same SVG 0.1.5 draws for the fixture; no
other fixture changes. Pre-flight's warning on such a line no longer says the `\usepackage` "will
fail", but that LaTeX reports it as an error and goes on without it.

`\IfFileExists` still answers what D16 needs. An `\input` of a file that does not exist still stops
the run, as `fatal-after-page` shows: Return at that prompt hands LaTeX the name `.tex`, which does
not exist either, so LaTeX has no way on to give. 0.1.5 read such a file as empty; that change
stays.

---

## D20 — What the engine cannot typeset is drawn over a box TeX sets for it

**Amends D8 and the backlog, which leave Greek, Cyrillic and CJK to a Unicode engine, and builds on
D16's `\ifincsname`. It came as pull request #2.**

The engine's fonts are Computer Modern, and its LaTeX has a definition for few characters beyond
Latin. Every other one TeX leaves out with "Unicode character … not set up for use with LaTeX", and
`¥` `¢` `‰` `½` `№`, which LaTeX sets in TS1, lose the whole diagram in the SVG converter. A Unicode
engine, or fonts and metrics for each script, are far off. The pull request draws them another way:
TeX sets each such character as a box one em wide, between two raw-SVG specials that mark it with
the character and the font's quad, and the worker writes the character over the box as a `<text>`
in the platform's `sans-serif`, centred in the space TeX set aside (`engine-src/unicode.ts`). TeX
keeps the layout: a node is as wide, and an arrow ends where it would, as for any text of that
width.

As written, the bridge replaced each run of such characters in the block's source with a call to a
macro that set the boxes. On 0.2.0 that broke what the engine already did. With `\ifincsname`, a
UTF-8 character in LaTeX is a macro that gives its own bytes where LaTeX makes a name of it (D16), so
on 0.2.0 a node, coordinate, style or colour named in Chinese or Greek, a `\label` key and its
`\ref`, `\csname 开始\endcsname`, `\def\开始` and `\edef` all work. Rebased onto 0.2.0 with nothing
else changed, the bridge put its boxes inside those names. Of 34 cases that 0.2.0's worker draws
without a TeX error, names, labels and symbols in Chinese, Greek, accented Latin and TS1 among them,
it changed 24: 18 failed with "Missing \endcsname inserted", one drew with that error,
`\detokenize{开始}` printed the macro, two `\ifx` tests between equal texts came out unequal, a
preamble's own `\DeclareUnicodeCharacter` was ignored, and the TS1 symbols left Computer Modern.

So the bridge leaves the source alone, and declares each character it draws to LaTeX's UTF-8 input,
`\DeclareUnicodeCharacter{5F00}{\tikzjaxUnicodeBridge{24320}}`, which changes only what the
character typesets. All 34 cases come out byte for byte as on 0.2.0. Of the 46 in which 0.2.0 left
characters out with an error or lost the whole diagram, 43 draw them, and in the other 3, where the
characters stand outside the picture or in `\nullfont`, the diagram is drawn without them and
without an error. Declaring reaches what replacing could not: a character in a preamble file or in a
macro's body, `\verb`, pgfplots' tick labels.

It declares what nothing else draws: not ASCII, not what `scan:native` measured native, and not what
the TS1 shim draws (0.1.5). The scan measures the bare engine, which cannot draw the shim's symbols,
so without that exception ° × ± µ £ € © and the rest came out of Computer Modern again, each in a
sans-serif em. The declarations go on the input's first line after the shim, ahead of everything the
user gave, so a preamble that declares a character of its own still wins, and a hundred to a line:
TeX reads a line into a buffer that a line of 250 KB fits and one of 300 KB overflows, and 6,000
declarations on one line came to 348 KB. A block with none of these characters gets nothing, so its
input, its DVI and its SVG are what they were; the 37 fixtures that were there give the same DVI,
transcript and SVG (D13).

Each character is a marker of its own. The worker joins the ones TeX set side by side, on one
baseline in one font and size, into one `<text>`, and across a gap of up to half an em, a space, so
that a phrase in Arabic or Hebrew is one string the browser orders right to left; drawn a word at a
time in TeX's order, its words came out reversed. The marker goes with the box: the sanitizer's
allowlist (0.1.5) has no `data-*` attributes and would report every character as removed active
content. A box that drew no glyph, set in `\nullfont` or outside the picture where dvi2html writes
HTML, is dropped, as TeX drops a character it has no font for, where the pull request lost the whole
diagram. An SVG whose groups no longer pair up, which a raw special can cause, is an error with TeX's
log, of the kind whose card shows its message; it was sent as an empty output, whose card says the
block is probably empty. A `<g/>` is not counted, since it opens and closes nothing.

TeX breaks a line only at glue or a penalty, and there is none between two boxes, so as the pull
request had it a line of Chinese in a `text width` node never broke; the plugin's SVG does not clip,
and the line ran past the node's border and over what stood beside it. A Han character, a kana, a
bopomofo letter and a fullwidth letter or digit are declared with a glue of no width in front of
them, in horizontal mode only; an opening bracket with a `\nobreak` after it as well, because a glue
after a penalty is no place to break; and closing punctuation, small kana, the iteration marks and
the prolonged sound mark with neither. So no line begins with closing punctuation or a small kana,
and none ends with an opening bracket. Korean is written with spaces and breaks there, like every
other script. The glue adds no width and writes nothing to the DVI. The box also starts a paragraph
where a letter would (`\leavevmode`): at the start of a `\parbox`, a minipage or a `p` column TeX is
in vertical mode, where each box had gone on a line of its own, and a word in Cyrillic in a
`\parbox` came out one letter under another. Through the worker, before and after, on the 184 cases
the review and the rebase of the pull request had collected, the only SVGs that changed, besides
the one with a `<g/>`, were those with Chinese in a `text width` node, now wrapped; a node
without `text width`, maths, Korean and text outside the picture came out byte for byte the same.
`unicode-wrap` in the golden corpus holds the breaks, and verify-worker the text of each line.

What it costs, measured in Node 22.19 on the Windows desktop of D14 through the worker, the shortest
TeX time of three runs, against the same nodes holding as many `M`s: 1,000 different CJK characters
in 20 nodes, 140 ms against 85; 3,000 in 60 nodes, 352 against 204; 6,000 in 120 nodes, 683 against
370; 250 nodes of the same two characters, 742 against 725. Finding the characters in 147 KB of
source takes 0.8 ms, and writing back the flowchart fixture's 21 markers 0.04 ms.

`unicode-bridge-probe`, the flowchart of the report the pull request began with, and
`unicode-names`, names in Chinese and Greek beside labels in Chinese and Cyrillic, are in the golden
corpus with the boxes and markers as TeX and dvi2html leave them. smoke writes the text back as the
worker does, so verify-worker compares the shipped worker with them byte for byte, and its fixtures
in `test/fixtures/worker` check the runs that come back, on one pass and two, and the error. Chrome's
XML parser accepts every SVG the bridge wrote in those cases, and the plugin's pipeline keeps every
restored text with nothing to report. What the bridge cannot do is in the README: the text is not
Computer Modern and takes an em a character, bold and italic are lost, a separate combining accent
is drawn beside its letter, and text outside the picture is not drawn. ENGINE_ID moves, so every cached
diagram compiles once more.

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
