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

## D20 — The cache key holds what the engine draws, not which build of it drew it

**Amends the cache-key part of D10 ("`ENGINE_ID` … still a cache-key input"), of D18 and D19
("every cached diagram compiles once more after the update"), and DESIGN.md §6.1, whose payload has
`engineId` where this puts `OUTPUT_REVISION`. Date of record: 2026-10-14.**

Until 0.2.0 the third field of the key was ENGINE_ID, the sha256 of the worker as it ships. Every
change to the worker therefore recompiled every diagram every user had cached, once, the next time
it was shown, also when the change drew every diagram the same to the byte. 0.2.0 did that for an
engine that only got faster and a few changes of output, and the 0.2.x plan has three more worker
changes in it, each held to the golden corpus byte for byte: the rebuilt engine, the faster start
and the preamble snapshot. Each would have been one more recompile of everything, on the phone
above all, where a compile is slowest.

The field now holds `OUTPUT_REVISION` (`src/cache/key.ts`), a string that moves when what the
engine draws can change: the DVI TeX writes, the transcript the plugin reads its errors from, or the
SVG the converter makes. Its first value is exactly the ENGINE_ID 0.2.0 shipped,
`5e861510239768c57ca2965eb2329bd2bafc1370df4821cd8d3b7088ce60efde`, in the same place in the
payload, so every key 0.2.0 derived is derived again and updating to 0.2.1 recompiles nothing, but
for a block with a character the Unicode bridge draws, which 0.2.0 drew without it (D26).
`test/key.test.ts` pins a key 0.2.0 derived, computed outside the implementation, and
`test/processor.test.ts` that a block keeps its key whichever build of the engine is running.

What keeps the revision honest:

- **The golden corpus.** `test/fixtures/golden/REVISION.json` records, under the revision, one
  sha256 per fixture over its recorded DVI sha256, transcript and SVG.
  `test/output-revision.test.ts` fails when a recorded fixture's output is no longer that, telling
  the developer to move `OUTPUT_REVISION` and record again; `node scripts/output-revision.mjs
  --record` writes the record and refuses to write a changed output under the old revision.
  `npm run verify:golden -- --update`, which is how an intended change of output is recorded,
  records `REVISION.json` with it, under the same refusal. A fixture new to the corpus is recorded
  without a bump: nothing was cached from its output before.
- **The worker.** `REVISION.json` also records the ENGINE_ID the corpus was last checked against,
  and `test/engine-id.test.ts` builds the worker that ships and fails when it is another one. That
  is the moment the decision is made, by a person, because the corpus is 37 diagrams and a change
  can alter what a diagram outside it draws. Through 0.2.1's first stage it was also the proof that
  the worker was 0.2.0's, byte for byte; the Unicode bridge (D26) is the change that ended that.
- **By hand.** Whenever the CHANGELOG says that diagrams draw differently, the revision moves, also
  when no fixture shows it: a package bundled that was missing, a fixed TeX file, a converter change
  for a glyph no fixture uses. CONTRIBUTING.md says so. The sha256 of the first worker that draws
  the new way is the convention for the new value; any new string works.

**What is cached when a render fails.** Read from `src/block/machine.ts` and
`src/block/render-child.ts`: an artifact is written to the cache only on the way from the SVG
pipeline to the note (`persist`, TRANSFORMING + ok), also for a block unloaded while it compiled.
An error card is never cached, nor is a mount whose pipeline skipped a stage (MOUNTED_DEGRADED). A
timeout poisons the key in the queue's set, which is in memory, lasts the session at most, and is
cleared by Retry, Restart the TeX engine and any settings change. So an engine that fixes a diagram
that failed shows the fix at once, with or without a bump. What is cached is every diagram TeX drew,
including one it drew after recovering from an error, with TeX's message on it: a diagram that
loads a package the engine lacks is drawn without it (D19) and that drawing is cached. A release
that bundles the package changes what that diagram draws, which is exactly the case the corpus does
not see and the bump by hand is for.

ENGINE_ID itself is unchanged in meaning: it is the build, stored with each artifact, shown in the
diagnostics, announced by the worker (`verify:worker`), and the engine `src/source/native-unicode.ts`
was scanned on. D3's extended engine, if it is ever built, draws differently from the core one and
needs a revision of its own in the key, as ENGINE_ID gave it for free.

---

## D21 — The diagnostics view times the whole wait, and copies as text without the diagrams

**Extends D18's diagnostics, which time a compile from the queue to the end of the SVG pipeline.
Date of record: 2026-10-14.**

Every figure 0.2.0 claims was measured in V8 on a desktop, and the device the plugin is slowest on
has no devtools. What the view showed left out the two waits around a compile: the time a diagram
spent between coming into view and being handed to the queue (the viewport gate and the debounce,
500 ms on a phone by configuration), and the time from the SVG pipeline to the diagram drawn in the
note (fonts, inserting it, the measurement that reframes it). It also said nothing of how often the
engine started, which on a phone is after every 30 s idle and every time the app goes to the
background.

- **Per diagram** (`CompileTimings`): `waited` from seen to asked, `drawing` from the end of the
  pipeline to drawn, and `seen to drawn`. "Seen" is the viewport gate letting the block through, or
  the cache missing for a block that skips the gate (an export, `lazy=off`, one the gate gave up
  on), or the press of Retry or "Render diagram". A block is reported when it comes to rest, as
  before, because "Render all diagrams in this note" counts it then, and again once it is drawn.
- **Per engine** (`WorkerHost.report`): the starts this session, each start's time from created to
  ready, and why each engine stopped: idle, background, timeout, restart, error or unload.
- **Copy** puts the view on the clipboard as plain text (`src/ui/report.ts`), less what it shows of
  the diagrams. It copies as Obsidian does, read in its 1.14.4 bundle: with the asynchronous
  clipboard only where the Permissions API is there too, which an older iOS WebKit lacks, and
  otherwise with the text selected in a textarea and the document's copy command; both start inside
  the click, as WebKit wants. Where neither copies, or the clipboard has not answered after 1.5 s,
  the text is shown, to copy by hand, and selected where the WebView lets a page select it, which iOS
  may not outside the click. None of it has run on a phone yet; `TODO.md` §9 has the check. It
  carries the plugin version, Obsidian's `apiVersion`, desktop, phone or tablet and
  the OS family from `Platform`, ENGINE_ID and OUTPUT_REVISION, the engine starts, the cache and
  queue figures, and the recent renders with their steps. It never carries a diagram's source, an
  error card's text (which quotes the source and names preamble files by path), the transcript or a
  note: a render is named by its place in the list and the first eight characters of its cache
  key, which the view shows beside each row too. That prefix of a hash cannot be read back into
  the diagram, though someone who has the same diagram with the same settings could tell that it
  is the one. `test/report.test.ts` holds the text to all of that.

`navigator.userAgent` was meant to be in it, for the iOS version and the WebKit build. The store's
rules forbid reading it (`obsidianmd/platform`) and forbid disabling that rule, so it is left out:
`lint:store` reports the read as an error, and the store's review would too. What that string would
have said about the WebView is asked of it instead, by feature check:
`DecompressionStream` and `Uint8Array.fromBase64`, which decide what 0.2.2's faster start can use,
and the cores and memory it reports. The iOS version is written down by whoever measures.

**Amended by D39.** A diagram also says which edit of its note made it wait for the debounce, or came
after it was made and did not, and why a run stored for its preamble was not sent with it; each
engine, what it handed over to be stored and what of that was dropped or failed; and the line on
stored preambles, what the store kept and refused this session, and why.

**Amended by D40.** And of an edit before the block was made, or with it, that did not make it wait
because its note already showed the diagram, that it did not count.

---

## D22 — Only a block of a note being typed in waits for the debounce

**Amends DESIGN.md §3.3's `GATING + intersect → DEBOUNCING` row and §5.4's "Debounce while
editing", which every uncached block paid. Date of record: 2026-10-14.**

Every block that missed the cache waited `debounceMs` after the viewport gate before it was queued:
300 ms on the desktop and 500 ms on a phone, by configuration (`src/platform/budgets.ts`), also when
a note was opened and nobody was typing at all. On a small diagram that is most of the wait; it was
the same in 0.1.5 and 0.2.0, and until D21 the diagnostics did not show it. It exists for one case,
typing (upstream #24): wherever a diagram is drawn while its text is edited, each keystroke remakes
the block, and a block that debounces is unloaded by the next keystroke before anything was queued,
so a burst of typing compiles once, at the pause.

So the debounce is kept for exactly that block and dropped for every other. A block is taken for one
being typed in when the text of its note changed within `editWindowMs` (1 s on both platforms) of its
cache miss, by any editor in any pane, as Obsidian's `editor-change` reports it, or by a change to
its file, as `vault.on('modify')` reports it (`src/block/edits.ts`); an `editor-change` that names no
note counts for every note. Such a block goes `GATING → DEBOUNCING` as before; any other goes
`GATING → SCHEDULING` the moment the gate lets it through, in band 1, and a `lazy=off` block to
SCHEDULING at once, in band 2. An export never gated or debounced, and still does not.

The decision is made at the cache miss, not when the block is processed, because of the order of
things in Obsidian, read in the 1.14.4 bundle: `editor-change` is triggered from the editor's update
listener, after Live Preview has remade the widget for that keystroke, so at processing time the
keystroke that caused the block may not have been reported yet; the miss comes after an IndexedDB
read, by when it has. The window covers the rest of the way from a keystroke to the miss it causes:
Live Preview remakes its widget in the keystroke's own update, a second pane on the same note and a
Reading view beside the editor are told 10 ms after it (`requestOnInternalDataChange`) and a Reading
view renders at once or, while still parsing, 200 ms later (`queueRender`), and an embed of the note
reloads on the same notice. A longer window costs only the debounce, to a block that first appears
in a note that was typed in within it, which is what every block paid before.

**Amended by D39.** The second is measured back from the block's making, not from its cache miss: an
edit reported after a block was made, in another run of code, did not make it, and at a desktop start
one made the note's first diagrams wait. The keystroke Live Preview reports after remaking its widget,
in the same update, is told by its run: the processor asks as the block is made, and the miss reads
the answer, with the edit that made the block, or one after it that did not, which the diagnostics'
waited step says.

**Amended by D40.** An edit before the block was made, or with it, does not count either where the
note had the block's text on screen as that edit's burst of edits began: a block made again, not
typed. Obsidian itself edits every open note once a session, resetting its syntax highlighting, and
a block Live Preview made again within the second after that waited.

How each place a diagram is drawn comes out:

- **Live Preview, one pane.** While the cursor is inside the fence, Live Preview shows the source
  and draws no widget (DESIGN.md §7.8, read in the bundle); the widget is drawn when the cursor
  leaves, and debounces if the last keystroke was less than a second before, as every block did.
- **A second pane on the note, a Reading view beside the editor, an embed of the note.** Remade at
  each keystroke, each time within the window, so each debounces and is unloaded by the next
  keystroke: one compile per pause.
- **Opening a note, scrolling, switching view, a hover preview of a note nobody types in, "Render all
  diagrams in this note".** No edit, so no wait.
- **A change that is not typing**: a sync or collaboration plugin, another program saving the file.
  No editor reports it, but the file's `modify` does, so a note redrawn in a Reading view for each
  change that comes in debounces, and changes arriving a moment apart compile once, as every change
  did before. Obsidian saving the note being typed in counts as one more edit of it, which changes
  nothing.
- **PDF export.** Unchanged: never gated, never debounced.

"The block at this place in the note had other text a moment ago" was the first idea, and was not
robust: with the same note in two panes, the second pane's block for a keystroke finds the first
pane's block with the same text at that place and would compile every keystroke; `getSectionInfo`
is null in exports, embeds and hover previews and is the whole callout for a block inside one; and a
line inserted above moves every place below it. The note-wide rule errs the other way, towards the
old behaviour.

A block now compiles where 0.2.0's would not have only if it reaches its cache miss more than the
window after the last change to its note and another change unloads it within the debounce: a
keystroke after a pause of more than a second, in a view that took more than a second to remake the
block. Nothing read in 1.14.4 takes that long. The plan's fallback, a debounce of 300 ms for every
block on the phone as well, stays the answer if typing in Live Preview turns out to compile
fragments on a device: every miss saying `editing: true` (`render-child.ts`), and the phone's
`debounceMs` at 300.

Tests: the transitions and both property tests in `test/machine.test.ts` (one settle, whatever the
`editing` of a miss; no debounce for a block nobody is typing in, over 2,000 seeded sequences, and
always one for a block that is), `test/edits.test.ts`, and the child and processor tests. Typing in
a diagram on an Obsidian 1.7.2 install and a current one, by hand, is in `TODO.md` §9.

---

## D23 — The engine starts at the first diagram that is not cached

**Amends DESIGN.md §4.3, under which the engine started when the queue handed the host its first
job. Date of record: 2026-10-14.**

Until 0.2.1 the engine was created when the first job reached it: after the diagram had been seen,
after its debounce, after its turn in the queue. Its start, 192–234 ms with 0.2.0's worker, measured
on 2026-10-13 in Playwright's WebKit 26.6 on the Windows 11 desktop the engine is maintained on (an
i9-13900K), was then paid in full by that diagram, and on a phone the engine stops after 30 s idle
and whenever the app goes to the background, so the first diagram after each of those pays it
again.

Now a block whose cache lookup misses asks the host to start an engine (`TexHost.ready`, through the
processor's `startEngine`), unless it is `lazy=manual` and waits for its button. The start then runs
while the block waits for the viewport gate and the queue, and the job's "engine start" step counts
only the part of it the job still had to wait for. At most one engine is started this way; it is
the host's own, so the idle teardown stops it like any other, which is what becomes of an engine
started for a diagram nobody scrolled to. The teardown is armed as soon as it starts, also while it
is still starting: before the early start every engine was started for a job, whose startup
allowance gave up on a start that never finished, and one started early has no job to do that.

- **Never at plugin load.** A session that only shows cached diagrams never starts an engine, as
  before. Starting one at load would cost every session its memory, about 81 MB once started for
  0.2.0's worker, measured the same day in Node 22.19 on the same desktop, and the start's CPU.
- **Never in the background.** On a phone the app going to the background stops the engine and
  pauses the queue so that nothing starts another (main.ts `registerTeardown`); the early start is
  not the queue, so it checks the visibility itself, of the block's own document: on a desktop the
  main window can be minimized while a pop-out window shows the note.
- **What it costs.** Creating the worker takes the main thread 9–11 ms in WebKit and 19–21 ms in
  Chromium 153 on the same desktop, with 0.2.0's worker, measured the same day, which the first job
  used to pay at the same moment of its life anyway.

What it gains was not measured in Obsidian: the "engine start" step of the first diagram in the
diagnostics view (D21) shows it, on each device.

---

## D24 — Two engines on a computer, one on a phone

**Amends the 0.1.5 decision that made the desktop's concurrency 1 like the phone's (TODO.md §3,
`DESKTOP.concurrency`), and DESIGN.md §4.3's one worker. Date of record: 2026-10-14.**

0.1.5 brought the desktop down to one job at a time because two jobs in ONE worker do not run side by
side: the second waited in the worker's own queue with its clock running. A second worker does run
side by side, at the cost of a second engine, and was left for later. It was measured for 0.2.x:
0.2.0 with a pool of two workers, its worker unchanged, against 0.2.0, in a harness that runs the
worker exactly as main.js carries it and hands it a note of 37 uncached diagrams, every fixture once,
all at once, from the worker's creation to its last reply, median of 5 fresh browsers (measured on
2026-10-13; Windows 11, i9-13900K, Playwright 1.63, busy with other work at 32–43% CPU):

| | one worker | two workers |
| --- | ---: | ---: |
| WebKit 26.6 | 6,897 ms | 3,705 ms (−46%) |
| Chromium 153 | 4,823 ms | 2,649 ms (−45%) |

The first reply came no sooner (334 and 315 ms in WebKit): two engines help a note with many new
diagrams waiting, not the first diagram. The second worker cost about 100 MB more at the peak, 141
against 237 MB above the process's start with 0.2.0's worker, measured the same day in Node 22.19. In
Obsidian the backlog is what the viewport gate lets through, so a note scrolled one diagram at a
time gains less than this.

Measured again on 2026-10-14 with the engine 0.2.1 ships (D27 to D31) and with 0.2.1-beta.1's, in
the same harness on the same desktop, five fresh browsers each, medians, every SVG byte-identical to
the golden corpus, with another job keeping one of the desktop's 32 threads busy throughout:

| 37 diagrams at once | one worker | two workers | peak working set, one → two |
| --- | ---: | ---: | ---: |
| Chromium 153, 0.2.1's engine | 2,052 ms | 1,102 ms (−46%) | 225 → 327 MiB |
| WebKit 26.6, 0.2.1's engine | 3,010 ms | 1,601 ms (−47%) | 392 → 583 MiB |
| Chromium 153, 0.2.1-beta.1 | 3,170 ms | 1,750 ms (−45%) | 291 → 425 MiB |
| WebKit 26.6, 0.2.1-beta.1 | 4,724 ms | 2,549 ms (−46%) | 494 → 734 MiB |

So a second engine still costs about 100 MiB at the peak in Chromium, the desktop app's engine, and
about 190 MiB in WebKit, where Obsidian never runs two: on the iPhone and iPad it keeps one.

What the host does (`src/engine/worker-host.ts`, first written as the prototype measured above):

- **A second worker starts only while a job waits that no worker running or starting can take.**
  The engine started early for a cache miss (D23) is one worker at most, and a job arriving while it
  starts waits for it rather than starting another.
- **A timeout or a crash takes down only its own worker**; the other keeps its job.
- **A worker that fails to start makes the pool one** until the workers next stop together, idle or
  by `kill()`, and the host tells the queue, which runs one job at a time meanwhile (`onSize`). A
  start that fails is most likely memory the computer does not have, which the memory rule below
  cannot see where the WebView reports 8 GiB or more, or nothing. Started again behind a busy first
  worker, the second would fail again for every job that waited; and when both were starting, a
  crash of one failed every waiting job while the other was about to come up. The waiting jobs now
  go to a worker that is up or still starting, and fail only when there is none.
- **`kill()` stops them all** — Restart the TeX engine, the app going to the background, unload — and
  interrupts every job, as it did the one worker.
- **They idle down together**, once neither has a job, after the platform's idle budget; one with
  nothing to do while the other works is kept.
- **The queue runs as many jobs at once as there are workers.** A job the queue started beyond the
  workers would wait in the host on its startup allowance, behind someone else's diagram.

How many (`engineCount` in `src/platform/budgets.ts`):

- **A phone or a tablet: one**, whatever the settings say. Each compile there is a new 156.25 MiB
  WebAssembly memory (D18), inside the one WebView the whole app runs in (`MOBILE.concurrency` in
  `platform/budgets.ts`), and nobody has measured a second engine on a device. That waits for a
  measurement on one.
- **A computer: two**, with three exceptions that make it one. The setting **Second engine**
  (`secondEngine`, on by default, shown on desktop only) is off. The computer reports less than 8 GiB
  of memory (`navigator.deviceMemory`). Or it reports no memory figure — Chromium gives it only to a
  secure context — and fewer than 4 logical cores (`navigator.hardwareConcurrency`): two engines
  compiling at once want two cores of their own beside the one Obsidian draws on. A computer that
  reports neither keeps two, since the second only starts while diagrams queue up and the setting
  turns it off. The copied diagnostics (D21) carry both figures, so whether desktop Obsidian reports
  its memory is something a bug report will show; it most likely does, since Obsidian 1.14.4's own
  `app.js` reads `crypto.subtle`, which a page has only in a secure context (read in the bundle).
  The figure is the browser's approximation, a power of two, so a computer near the line falls on
  whichever side the browser rounds it to. Where this rule misses a computer short of memory, a
  second worker that fails to start makes the pool one (above). The setting says "a computer that
  reports less than 8 GB", and on a computer these rules leave at one, says that this one does.
- **Changing the setting applies at once**, also when it arrives through Sync: the pool follows, and
  tells the queue, an idle second worker goes at once, and a busy one when it has finished its job.
  The diagnostics say "stopped when the second engine was turned off".

The pool leaves the worker as it was: when it came, `test/engine-id.test.ts` built the worker that
ships and held it to 0.2.0's ENGINE_ID, recorded in `test/fixtures/golden/REVISION.json` (D20), so
the pool changes nothing a diagram draws and nothing in anyone's cache. The preamble snapshot
planned for 0.2.3 keeps its saved preambles per worker, and with two workers only 32 of 52 possible
resumes happened in a note of 74 diagrams, every fixture twice, with a prototype of the snapshot
(measured on 2026-10-14 in the same harness); it needs each diagram sent to the worker that holds
its preamble, which is for that release.

Tests: `test/worker-host.test.ts` (the pool as the prototype had it, and idling down together, one
worker with a pool of one, a crash, the pool shrinking and growing, a second worker that fails to
start while the first is busy or starting), the queue's new slot count, `test/budgets.test.ts`, and
the settings tab.

---

## D25 — A job whose blocks went away before the engine had it is dropped

**Amends DESIGN.md §5.1's "Release: … a started job is left to complete and cache", and D23's
early start. Date of record: 2026-10-14.**

Until 0.2.1 a block in view waited for the debounce before it was queued, and one unloaded within
it — a note switched away from, a wrong tap in the file list, a hover preview that closed — had
submitted nothing. D22 took that wait away from every block nobody is typing in, so such a block is
queued the moment it is seen, and while a slot is free the queue starts its job at once. On a cold
engine the job then waits in the host for the engine to come up (D23), and the block is gone a
moment later. The queue left a started job to finish, so it held its slot and compiled for nobody,
and on a phone, with one slot, the next note's first diagram waited for it. The host, for its part,
stopped a worker still starting when the last job waiting for it was abandoned, so the early start
went with it.

- **The queue drops a started job the engine does not have yet** when its last block releases it:
  the runner has not said `running`, so nothing has been paid for. Its signal is aborted with
  `QueueError('cancelled')` and its slot is freed. A job the engine has is left to finish and cache,
  as before; a release could only stop it by terminating the worker, which throws the work away.
- **The host keeps a start going for a cancelled job.** A job abandoned before a worker took it
  stops a worker still starting only when it was not cancelled: when its startup allowance ran out
  (`stalled`), the start is presumed wedged. A cancel says nothing about the start, and the engine
  started early is there for the next note's diagrams, or idles down if none comes (D23). A WebView
  without `AbortSignal.reason`, an older iOS WebKit's, sees no reason and stops the start, and the
  next note's first diagram starts the engine again.
- **The block settles.** It was unloaded in COMPILING, which waits for its job's end; the drop
  arrives as the queue's `cancelled` rejection, and COMPILING, unloaded, takes it to DISPOSED.

What it still costs: a job the engine took before its block went away compiles to the end, and is
cached for the next time the diagram is shown. That is at most one compile per engine per switch,
on an engine already up, where 0.2.0's debounce compiled nothing for a view shorter than itself.
Switching notes quickly on a cold engine, on the phone, is in `TODO.md` §9.

**Amended by D40.** In the same window, started and not yet in the engine, a job also gives its slot
to a more urgent one and goes back in line, aborted with `cancelled` after the more urgent job has
reached the host, so that a start is kept here too.

Tests: `test/queue.test.ts` (dropped before the engine has it; kept once it has it, or while another
caller wants it; a caller asking again at once gets a job of its own; the randomised interleavings
with a startup), `test/worker-host.test.ts` (the start kept for a cancel, stopped for a stall),
`test/machine.test.ts` and `test/render-child.test.ts`.

---

## D26 — What the engine cannot typeset is drawn over a box TeX sets for it

**Amends D8 and the backlog, which leave Greek, Cyrillic and CJK to a Unicode engine, builds on
D16's `\ifincsname`, and amends D20's "updating to 0.2.1 recompiles nothing" for the blocks it
draws in. It came as pull request #2.**

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

What it costs, measured in Node 22.19 on the Windows desktop of D14 through the worker with the line
breaks above, the shortest of three runs, against the same nodes holding as many `M`s, as TeX's
time, the SVG converter's, and the worker's whole run up to the converter's SVG: 1,000 different CJK
characters in 20 nodes, 127 ms against 73, 22 against 2, and 157 against 80; 3,000 in 60 nodes, 355
against 190, 45 against 5, and 407 against 199; 6,000 in 120 nodes, 666 against 358, 81 against 10,
and 754 against 373, about twice the time; 250 nodes of the same two characters, 714 against 692, 19
against 13, and 738 against 712. Finding the characters in 147 KB of source takes 0.8 ms, and
writing back the flowchart fixture's 21 markers 0.04 ms.

`unicode-bridge-probe`, the flowchart of the report the pull request began with, and
`unicode-names`, names in Chinese and Greek beside labels in Chinese and Cyrillic, are in the golden
corpus with the boxes and markers as TeX and dvi2html leave them. smoke writes the text back as the
worker does, so verify-worker compares the shipped worker with them byte for byte, and its fixtures
in `test/fixtures/worker` check the runs that come back, on one pass and two, and the error. Chrome's
XML parser accepts every SVG the bridge wrote in those cases, and the plugin's pipeline keeps every
restored text with nothing to report. What the bridge cannot do is in the README: the text is not
Computer Modern and takes an em a character, bold and italic are lost, a separate combining accent
is drawn beside its letter, and text outside the picture is not drawn.

**What it does to the cache.** 0.2.0 cached what it drew of a block with such a character: TeX left
the character out with an error and drew the rest, and a diagram TeX drew after an error is cached
(D20). The key 0.2.1 derives for that block is the key 0.2.0 stored it under (D20), so the drawing
without the characters, with TeX's message on it, would have gone on being shown until the block was
edited. Moving `OUTPUT_REVISION` would have compiled every cached diagram once more, for the few
that have such a character. Instead a block whose TeX input has a character the bridge declares gets
one more field in its key (`usesUnicodeBridge` in `src/cache/key.ts`), and no other block does.
Everything the worker gives TeX is among the key's inputs: the block, and the packages with their
options, the libraries, the preamble's text and the border that `baked` holds. The main thread reads
them with the bridge's own test, `engine-src/bridged.ts`, which leaves out the TS1 shim's symbols
and the native table's characters as the worker does; the paths in `depHashes` are not read, since
TeX never sees them. For every other block the bridge adds nothing to TeX's input and changes
nothing in the SVG, and the 37 fixtures that were in the golden corpus come out byte for byte as
they did, so its key is 0.2.0's and nothing else compiles again. `test/key.test.ts` pins a key of
each kind, computed outside the implementation. Reading a block of 150,000 ASCII characters to the
end takes about 1 ms in Node 22.19 on the desktop of D14, and a block of a few lines well under a
microsecond. A later change to what the bridge draws moves `OUTPUT_REVISION` like any change of
output: the bridge's fixtures are recorded in `REVISION.json` under it.

---

## D27 — TeX's local variables are WebAssembly locals, and binaryen 132 optimises the engine

**Amends D14, which optimises the engine with web2js's binaryen 99 and leaves 132 for later. Date of
record: 2026-10-14.**

web2js compiles each Pascal procedure of TeX with its local variables and parameters on a shadow
stack in the WebAssembly memory: every read of a local is a load, every write a store, and every
argument is stored by the caller and loaded again by the callee. A JavaScript engine cannot keep
those values in registers, because any store into TeX's arrays might be a store into one of them.
TeX's time is mostly in procedures that do little else (`get_next`, `main_control`, `macro_call`,
`get_avail`, `id_lookup` in a V8 profile of `pgfplots-axis` taken during the 0.2.x study), and in
WebKit about 94% of it is inside the WebAssembly, not in the host's JavaScript.

So three files of web2js's compiler are replaced by ours, in `engine-build/web2js-codegen`, before
TeX is compiled:

- `function-declaration.js`: a procedure's scalar locals, its result and its parameters become
  WebAssembly locals and parameters. A variable whose address is taken (a `var` argument, a record,
  an array, a file) stays in memory: its first use as an address throws inside the compiler, and the
  procedure is generated again with it in memory. A value is narrowed where it is written exactly as
  a store and a load of the variable's width narrowed it, `& 255` for a byte, a sign extension for a
  signed one, so each variable holds what its memory slot would have held. A procedure with nothing
  left in memory does not touch the shadow stack at all.
- `function-evaluation.js`: a call to such a procedure passes its arguments as call operands.
- `memory.js`: each use of a variable's base address is a copy of it. web2js shares one expression
  node among every use, and an optimisation that rewrites a node in place changed them all; that is
  how the first attempt at this crashed.

Each was written against web2js's own file at the pinned commit. `build-engine.sh` checks the sha256
of each of web2js's files before putting ours in its place and stops if one differs, so a web2js
that moves cannot lose what it changed, nor ours what they change. `BUILD-MANIFEST.txt` records a
hash of the three, and `test/engine-build.test.ts` holds the files in the repository to it, so they
cannot be edited without the engine being rebuilt.

The engine is then optimised by binaryen 132's `wasm-opt`, still `--mvp-features -O4` (D14). It
comes from npm's registry as the package's tarball, which the Dockerfile checks against the
integrity npm publishes for `binaryen@132.0.0` before unpacking it, as Node and the font archive
are checked; it has no dependencies, so nothing else is resolved or installed. web2js keeps its own
binaryen 99 for compiling TeX. `scripts/wasm-mvp.mjs` passes on the new `tex.wasm`.

**Nothing draws differently.** The static memory image, TeX's globals and the compiled code's
string literals, is laid out as before, so the core dump is the same bytes up to byte 163,642,455 of
163,840,000: only the top 197,545 B differ, which are leftover frames of the shadow stack, 82,933
bytes that were not zero in the old dump and 33 in the new. Every fixture's DVI, transcript and SVG
is byte-identical to the golden corpus, and the shipped worker passes `verify:worker`. One thing
does change in principle: a local read before anything was written to it gives 0 where it gave a
stale byte of the shadow stack. No fixture depends on that. `OUTPUT_REVISION` stays where 0.2.0 left
it, `REVISION.json` records the new worker, `d50048c525aa…`, and updating compiles nothing again
(D20).

**What it gains.** Measured on 2026-10-14 on the Windows 11 desktop of D14 (i9-13900K, 128 GiB),
quiet at the start (3% CPU), with the 0.2.x study's harness: each build's worker exactly as its
`main.js` carries it, in a real Web Worker of Playwright 1.63's WebKit 26.6 (JavaScriptCore) and
Chromium 153, and on Node 22.19's main thread. Seven rounds, each a fresh browser or process per
build, the builds' order rotated every round. Each round: a cold `basic`, then the 37 fixtures of
0.2.0's corpus twice each. TeX is the worker's own `texMs`; the figure is each fixture's minimum
over the rounds, summed. Every reply of the campaign, 5,355 of them, was byte-identical to the
golden corpus.

| TeX time, 37 fixtures | 0.2.1-beta.1 | rebuilt engine | each round against beta.1's |
|---|---:|---:|---|
| WebKit 26.6 (JavaScriptCore) | 4,179 ms | 2,837 ms (−32.1%) | −31.6% median, −31.3% to −32.1% |
| Chromium 153 (V8) | 2,756 ms | 1,893 ms (−31.3%) | −30.6% median, −29.9% to −31.9% |
| Node 22.19 (V8) | 3,000 ms | 2,301 ms (−23.3%) | −23.0% median, −22.5% to −24.6% |

The second render of each fixture in a row gains the same: 4,133 → 2,803 ms in WebKit, 2,722 →
1,856 in Chromium, 2,955 → 2,258 in Node. In WebKit, `basic` takes 25 → 17 ms, `tikz-cd` 154 → 103,
`siunitx` 172 → 125, `pgfplots-axis` 451 → 304, `circuitikz` 486 → 316, `feynhand` 566 → 373. The
engine's start is unchanged (median spawn to ready 145 → 146 ms in WebKit, 161 → 159 in Chromium):
it is the dump's inflate, not TeX. JavaScriptCore still takes about 1.5 times V8's time on the same
diagrams; what is gained is less work for both. The study that built the change split the gain in
Node, over the same fixtures with five to seven runs each: the locals alone −18.1%, with the
parameters −19.7%, and binaryen 132 on top of that a further 4.2% by the minimum (0.6% by the
median). Nothing has been measured on a phone.

| | 0.2.1-beta.1 | rebuilt engine |
|---|---:|---:|
| `tex.wasm` | 356,500 B | 236,378 B |
| `tex.wasm.gz` | 77,347 B | 69,594 B |
| `core.dump.gz` | 5,994,269 B | 5,938,929 B |
| `main.js`, the same plugin code | 12,257,847 B | 12,174,339 B (−83,508) |

**What it costs.** Values held in WebAssembly locals live, while a call is made, on the JavaScript
engine's own stack instead of in the WebAssembly memory, so each level of TeX's recursion takes more
of that stack in V8. The deepest nesting of `\number` that still renders, verify-worker's
construction, bisected to one level in the shipped worker: in a Chromium worker 2,344 → 1,622, on
Node 22.19's main thread 3,798 → 3,132 (Node 24.21 4,615 → 3,194, Node 26.11 4,612 → 3,196). In a
WebKit worker it went 21,281 → 21,280, bisected after a ladder of shallower renders; bisected with
the deep render first, 0.2.1-beta.1's engine stopped at 20,049 and this one did not stop before
20,050, so what JavaScriptCore allows also depends on what it has compiled by then. JavaScriptCore
is not indifferent to the engine's code either: D31's marks, which touch nothing in V8's figure,
later took WebKit's to 19,950 (D31 has how it was measured). An iPhone's limit has not been
measured. A diagram nested past the limit fails as it did past the old one, with "TeX nested deeper
than the engine's stack allows."; D28 weighs what to do about it.

**The build.** Two builds of this source from a new image gave the same bytes, and the same as the
build the study measured. The Engine workflow rebuilds and diffs `engine-build/out` as before.
`engine-build/out/memory-layout.json` is new, written by the build: where web2js put each of TeX's
globals in the memory, its offset and size, an array's index range and entry size, with the
memory's pages, `hash_prime`, and where the globals and the string literals end. TeX's own counters
of how far it has filled its big arrays (`lo_mem_max`, `hi_mem_min`, `mem_end`, `pool_ptr`,
`str_ptr`, `fmem_ptr`, `hash_used`, `trie_max`, `save_ptr`, `max_save_stack`) are globals in it, so
the worker can find the parts of the memory a run can have written and reset only those. The build
stops unless every one of them and the arrays they count are there, shaped as TeX declares them,
and `test/engine-build.test.ts` reads each counter out of the committed dump and requires a value
that fits the array it counts, which an offset wrong by one variable does not give. `CHECKSUMS`
covers the file.

When web2js moves, the sums stop the build: port its change into our three files, update the sums,
and hold the result to the golden corpus and to `verify:worker`, whose floor (D28) is the check on
how deep TeX can still nest.

---

## D28 — How deep TeX can nest is held to a floor, and three deep inputs are fixtures

**Follows D27, which lowered the nesting the engine's stack allows in V8, and amends D17, which
measured that limit and left it unguarded. Date of record: 2026-10-14.**

Each level of an expansion, or of a box inside a box, is a few calls deeper in the engine, and the
JavaScript engine's stack gives out long before any limit of TeX's own (D17). D27 holds TeX's locals
in WebAssembly locals, which takes more of that stack per call in V8: the deepest nesting of
`\number` that renders, verify-worker's construction, went from 2,344 to 1,622 in a Chromium worker,
and from 3,798 to 3,132 on Node 22.19's main thread. In a WebKit worker it did not move (21,281 →
21,280), though D31's marks later moved it to 19,950. Obsidian's desktop app runs V8, and so does
Android, which has not been measured.

**What real input needs.** Fifteen deep or large inputs, rendered once each in a Chromium worker and
in a WebKit worker, by 0.2.1-beta.1's worker and by D27's, on the desktop of D27 (the 0.2.x review
chose them): `forest` trees 20, 40 and 80 levels deep, TikZ `child` chains as deep, 200, 1,000 and
4,000 nested brace groups, 50 and 200 nested scopes, pgfplots plots of 500 and 2,000 coordinates,
and `\foreach` over 500 and 2,000 items. All of them render in both browsers with both engines, and
each draws the same SVG, length and hash, with either engine.

**The alternative, measured.** The procedures nested `\number` recurses through, `expand`,
`macro_call`, `scan_int`, `get_x_token`, `conv_toks` and `x_token`, can keep their locals in memory
while every other procedure keeps D27's. Built that way, in the same campaign as D27's figures
(seven paired rounds, 37 fixtures, sum of each fixture's minimum):

| | D27's engine | expansion's locals in memory |
|---|---:|---:|
| deepest `\number`, Chromium 153 worker | 1,622 | 2,040 |
| deepest `\number`, Node 22.19 / 24.21 / 26.11 main thread | 3,132 / 3,194 / 3,196 | 3,685 / 4,016 / 4,019 |
| deepest `\number`, WebKit 26.6 worker | 21,280 | 21,280 |
| TeX time, WebKit 26.6 | 2,837 ms | 2,978 ms (+5.0%) |
| TeX time, Chromium 153 | 1,893 ms | 1,958 ms (+3.4%) |
| TeX time, Node 22.19 | 2,301 ms | 2,345 ms (+1.9%) |
| `main.js` | 12,174,339 B | 12,237,939 B |

It is not taken. It gives back 418 of the 722 levels Chromium lost, for this one path through TeX
only, and costs JavaScriptCore, the engine of the iPhone this work is for, 5% of TeX's time, where
WebKit's limit did not move with D27. No realistic input was found that needs the levels. The core
dump also grows by 47,799 B gzipped, from the frames those procedures leave on the shadow stack
while the format is built.

**The floor.** `verify:worker` now requires 2,900 nested `\number` to render in the shipped worker,
on Node's main thread where it runs, and prints the deepest that does, bisected up to the 20,000
that must still fail as a capacity error. D27's engine reaches 3,132, 3,194 and 3,196 there in Node
22.19, 24.21 and 26.11, the same after the fixtures have warmed it as before; 0.2.1-beta.1's
reached 3,798, 4,615 and 4,612. At this engine's ratio between Chromium and Node, 2,900 stands for
about 1,500 in a Chromium worker, the floor the review asked for. The ratio is not a constant, 0.62
for the old engine and 0.52 for this one in Node 22.19, so the browser's figure has to be measured
again when the code generator changes. A change that takes more of the stack than the floor allows
fails `verify:worker`, in CI and in the Engine workflow, and a smaller one shows in its log. Set to
3,300, above what the engine reaches, the check fails, as it should. What the floor cannot see is a
change only JavaScriptCore pays for: D31's marks cost WebKit 6% of its depth and Node nothing
measurable. So a change to the code generator also needs the depth read in a WebKit worker, before
and after, as D31 did (CONTRIBUTING.md).

**Three of the inputs are fixtures.** `stress-forest-depth` (80 levels), `stress-nested-groups`
(4,000) and `stress-plot-coordinates` (2,000 coordinates, drawn as one path without marks, so that
its golden SVG is 47,702 B; the review's plot, with marks, drew 616,245) are in the golden corpus,
recorded from D27's engine. 0.2.1-beta.1's engine gives the same DVI, transcript and SVG for each.
smoke, `verify:golden` and `verify:worker` run them like any fixture.

How deep an iPhone's worker lets TeX go is not known. WebKit on Windows stopped D27's engine where
it stopped 0.2.1-beta.1's, and the engine with D31's marks 6% sooner, which says only that
JavaScriptCore's limit moves with the engine's code too, not where a phone's stack ends. `TODO.md`
has the note to read it with.

---

## D29 — TeX's calls into the host make no new arrays

**Amends D10, under which the host's per-call code stayed as upstream wrote it. Date of record:
2026-10-14.**

TeX calls the host for every line it reads (`inputln`), every byte of a binary file (`get`) and
every character of its transcript (`printChar`, twice when it prints to the terminal and the log).
Each `inputln` made a view of TeX's buffer and two of its `first` and `last`, each `get` and `put` a
view of the whole memory, and each `printChar` to a file an array of one byte: a pgfplots run reads
some 60,000 lines and prints 18,000 characters, counted in the 0.2.x study's profile of
`pgfplots-axis`. The views are now made once a run, in `setMemory`, and a character is appended
where it was wrapped in an array of its own (`engine-src/library.ts` change 9).

They answer as before, and fail as before: a RangeError wherever a view of the old kind would have
refused one, which matters because a RangeError out of TeX is how the worker recognises a run cut
off by the engine's stack. `test/library.test.ts` keeps `inputln` as it was and runs it beside the
new one over empty, blank, long and over-long lines, into buffers that fit, end at `first`, are too
small, misplaced or outside the memory, with `first` and `last` misaligned or one variable, and
compares every byte of the memory after each call. Changing either new check, the one for a
negative pointer or the one for a line that does not fit, fails it.

**A line longer than TeX's buffer** is the one place where failing as before was wrong. A line that
did not fit in what was left of the buffer, 300,000 bytes, threw the RangeError of `set`, and since
0.2.0 (D17) the worker has reported that as "TeX nested deeper than the engine's stack allows.":
the review of this release's engine found 20,000 `\expandafter\def\csname…` on one line, about 960
KB, failing that way, where on lines of their own they render. tex.web's own `input_ln` stops at a
full buffer with "TeX capacity exceeded, sorry [buffer size=…]". `inputln` now throws
`LineTooLong` there, which is not a RangeError, and the worker reports a capacity error, "TeX
cannot read a line longer than its buffer of 300,000 bytes.", and leaves a new Memory to the next
run, as after any run cut off before TeX ended it. Only the message changes, so `OUTPUT_REVISION`
stays where it is. `test/library.test.ts` compares `inputln` with the old code as before, with
`set`'s error taken for `LineTooLong`; `verify:worker` sends a line of 310,000 bytes and then
`basic`, and `verify:reset` has the same line among its inputs.

**What it gains.** Measured on 2026-10-14 on the desktop of D27 (Windows 11, i9-13900K, 128 GiB),
quiet at the start (9% CPU), with the 0.2.x study's harness as D27 measured: each build's worker as
its `main.js` carries it, in a real Web Worker of Playwright 1.63's WebKit 26.6 and Chromium 153,
and on Node 22.19's main thread; seven rounds, a fresh browser or process per build per round, the
builds' order rotated; the 37 fixtures of 0.2.0's corpus twice each; TeX is the worker's own
`texMs`, each fixture's minimum over the rounds, summed. Against the commit before, D28's:

| TeX time, 37 fixtures | before | without the allocations | each round against before's |
|---|---:|---:|---|
| WebKit 26.6 | 2,832 ms | 2,723 ms (−3.8%) | −4.4% median, −3.9% to −5.2% |
| Chromium 153 | 1,897 ms | 1,819 ms (−4.1%) | −5.1% median, −4.6% to −5.9% |
| Node 22.19 | 2,295 ms | 2,197 ms (−4.3%) | −3.8% median, −1.8% to −5.0% |

Every reply of the campaign was byte-identical to the golden corpus. Fewer allocations also means
V8 collects less often during a run, which left more of the old per-run Memories uncollected at a
time; D31 has that, and why it no longer matters.

---

## D30 — The engine starts from a payload the host sends it, and inflates it natively where it can

**Amends D10, under which the build writes the engine's assets into the worker's script, and D18,
which inflates the dump with pako. Date of record: 2026-10-14.**

Until 0.2.1 the worker carried tex.wasm, the core dump and the 247 TeX files in its script, as
string literals of base64, which every start parsed before it ran a line, and then decoded every
TeX file, inflated the dump with pako, JavaScript's zlib, and compiled tex.wasm, one after another.
With D27's engine the script was 10,143,443 characters, 9,796,494 of them in the 289 literals of a
thousand characters or more. The 0.2.x study timed the parts in WebKit and Chromium on the desktop:
pako's inflate of the dump was 105 to 114 ms of a 192 to 205 ms start.

- **The payload is data.** The worker's script is its code, 481,510 characters as 0.2.1 ships it;
  tex.wasm, the dump and the files, 9,669,247 characters of base64, go to the worker as the first
  message to each worker the host starts (`engine-src/protocol.ts` EngineAssets), which starts from
  it and answers `ready`. `main.js` holds the payload as an object beside the worker's code, instead
  of inside it.
- **The platform's own gzip.** Both tex.wasm and the dump are inflated by `DecompressionStream`
  where the platform has one (iOS and Safari 16.4, Chrome 80), read a chunk at a time into one
  buffer of exactly the size the build recorded, and by pako where it has none. A native attempt
  that rejects falls back to pako once, so a platform that has the API and fails with it costs time,
  not the start; a payload that is really wrong then fails in pako too. One that never settles is
  not bounded: it holds the start until the host's startup allowance gives up on it, 20 s on a
  computer and 30 s on a phone, and every start after it the same way. No platform is known to do
  that, and a bound would have to be long enough for the slowest phone's real inflate.
- **tex.wasm compiles while the dump inflates**, with `WebAssembly.compile`, which the platform
  runs off the worker's thread.
- **The TeX files stay base64** until TeX first opens one, which is then decoded and inflated, and
  kept as before (D10's item 3).
- **Without `Uint8Array.fromBase64`** (Safari before 18.2, Chromium before 140, so Obsidian's
  desktop app before it is built on that, and Node 22), base64 is decoded four characters at a time
  straight into the bytes, where `atob` made a string to copy out a character at a time. The study
  measured the dump's decode at 15.2 → 9.1 ms in Chromium and 12.0 → 7.0 ms in WebKit, cold, with
  the API hidden.
- **ENGINE_ID** hashes the worker's code and then the payload, so it still moves with anything the
  worker runs, a TeX file changed under its name among them (`test/engine-id.test.ts`).
- **The diagnostics view** shows, beside each engine start, the worker's own breakdown from `ready`:
  decode, inflate, what the compile added once the dump was ready, the total, and whether the
  platform's gzip and base64 were used. On a phone, which iOS has which is what to read there.

**A start that fails ends in the worker's error event**, as one always has (`worker-host.ts`
`crashed`): the worker throws the failure again outside the promise, since a promise that rejects
in a worker raises none, and the host would otherwise wait for a `ready` that never comes.
`test/worker-boot.test.ts` starts the shipped worker on a thread of its own with the dump or
tex.wasm changed, cut short, of the wrong size or missing, with and without the platform's
decoders, and each ends in the error event. A changed and a cut dump do the same in Chromium 153
and WebKit 26.6, run with the study's harness on 2026-10-14: the error event, with pako's
"incorrect data check" and "buffer error", each whole run taking 2.7 to 4.6 s with the browser's
launch. `verify:worker` starts the worker as the host does, and runs a second time in CI and in the
Engine workflow with `--legacy`, without `DecompressionStream` and `Uint8Array.fromBase64`, as on
iOS 14.5 to 16.3.

**What it gains.** The campaign of D29, the median of the seven rounds' engine starts, from the
`Blob` on the main thread to `ready` arriving there, and the worker's own breakdown:

| Engine start | before | this | in the worker: decode, inflate, compile |
|---|---:|---:|---|
| WebKit 26.6 | 145 ms (141–156) | 57 ms (56–59) | 3, 32, 1 ms |
| Chromium 153 | 160 ms (158–162) | 51 ms (50–52) | 3, 31, 0 ms |
| Node 22.19 | 155 ms (155–156) | 101 ms (90–105) | 13, 68, 0 ms |
| WebKit, without the native decoders | 155 ms (153–157) | 114 ms (114–121) | 13, 80, 1 ms |
| Chromium, without them | 174 ms (174–177) | 127 ms (127–128) | 14, 96, 1 ms |

The two rows without them are seven more rounds the same day, with the harness hiding both APIs
from the worker as `--legacy` does, a stand-in for iOS 14.5 to 16.3. The main thread's own share of
a start, creating the worker and posting it the payload, went from 8 to 5 ms in WebKit and from
15.7 to 4.6 ms in Chromium. Node 22 has no `Uint8Array.fromBase64`, so it decodes with the worker's
own loop; it is not where the plugin runs. Nothing has been measured on a phone.

**What it costs.** `main.js` grows by 2,081 B, the worker's start code. Chromium's working set
right after a start is about 24 MiB higher (159 → 183 MiB, medians of the same campaign) and
WebKit's 32 MiB lower (176 → 144).

The study had also measured Chromium's private commit 281 MiB higher over a round with this build,
and left the cause open. It is not the start, after which commit rose only 34 MiB (114 → 148 MiB):
it is per-run Memories not yet collected, D29's fewer allocations giving V8 fewer reasons to
collect. D31 measured it, and ends it.

---

## D31 — One memory per engine, and only what a run wrote is put back

**Amends D18, under which every run starts from a new Memory with the dump's non-zero runs written
into it. Date of record: 2026-10-14.**

Every run of TeX took a new `WebAssembly.Memory` of 156.25 MiB with the dump written into it, and
the old ones waited for the collector. Engines commit a Memory whole when it is made, and count
every page a run touched as resident until it is freed. In the campaign of D29, the harness counted
the Memories made and not yet collected (a `FinalizationRegistry` on each) at every reply: up to 5
to 9 in Chromium 153 over a round of 85 renders, depending on the build, and up to 8 to 17 in
WebKit 26.6, the engine of every iPhone. The content process committed a median of 3,139 MiB over
such a round in WebKit, and its working set peaked at 679 MiB.

**The 281 MiB.** That count explains what the 0.2.x study found and D30 inherited: Chromium's peak
commit over a round rose 945 → 1,232 MiB with D29's change alone and to 1,372 with D30's (three
rounds each, measured with the study's harness on 2026-10-14), while the most Memories alive at a
reply rose 5 → 7 → 8, 156.25 MiB each. With a full collection forced after every reply
(`--js-flags=--expose-gc`), three rounds each, both builds held 2 at most, and the build with D30
committed less, 310 to 323 MiB against 480. It was garbage the collector had not got to: nothing
leaked, and nothing about it was the start's.

**What changes.** A worker keeps the Memory of its last run, and before the next one writes the
dump's bytes back over only the parts that run can have written (`engine-src/reset.ts`):

- every global of TeX's whole, but for its big arrays;
- of those, the part TeX's own counters say is in use, since TeX never writes past them and they
  only move outwards: `mem` up to `lo_mem_max` and from `hi_mem_min` to `mem_end`, `font_info` up to
  `fmem_ptr` (only the engine's own fonts load, so none stops half-way), the hash table's primary
  slots and from `hash_used` up, `save_stack` up to `max_save_stack` and the seven entries e-TeX
  may write past a check for room, and `trie` up to `trie_max`;
- the pattern arrays not at all: TeX refuses `\patterns` once a format is loaded;
- `str_pool` and `str_start` up to the highest `pool_ptr` and `str_ptr` reached in the run, and the
  shadow stack from the lowest point it reached to the top of the memory: three marks TeX does not
  keep, which the engine now does (below);
- the string literals after the globals, which nothing writes, as a guard;
- whatever the host wrote into the memory (`library.ts` `hostWrites`): TeX's buffer and the file
  variables `get` reads into, all among the globals.

That is 26.5 to 27.3 MiB over the fixtures, in 14 stretches, and takes 2 ms a run in both browsers
where a new Memory took 4 to 5, medians of the campaign. A run that jumped out of TeX, overflowed
the engine's stack, was cut off at a line longer than TeX's buffer (D29) or trapped leaves a new
Memory to the next, rather than trusting what it left behind, and so does a memory whose counters
do not lie within their arrays. So does a run whose
reset bookkeeping fails once TeX has ended, and its diagram is drawn all the same: the worker works
out what to keep in a try of its own, since an error there read as a run that wrote nothing ("TeX
produced no output", with the marks made to throw), and a fault in the reset must cost a new
Memory, never the diagram. The diagnostics view says "new memory" for a diagram that took one, and
"memory reset" for the rest.

**Why the engine had to mark three things.** TeX's counters are where a run ended, not how far it
went, for two arrays. A string TeX builds and then flushes, as `\detokenize`, `\meaning` and
`\string` do, leaves its characters past where `pool_ptr` ends: `stress-plot-coordinates` leaves
40,228 bytes there, a `\detokenize` of 10,400 characters 9,249, and `str_ptr` comes back down the
same way. The snapshot prototype of the 0.2.x study bounded the pool at `pool_ptr` plus 4,096,
which its 37 fixtures never exceeded, and `verify:reset` fails at once with that bound. Nothing
records how far down the shadow stack went: 200 nested `\frac` take it 3,297 bytes below the top of
the memory, 300 nested `\sqrt` 2,497 bytes, of which only the top 37 differ from the dump, so its
contents cannot say how far a run went either, and six of the eighteen procedures that grow it are
recursive.
D27's code generator, ours, now keeps `getPoolPtrHigh`, `getStrPtrHigh` and `getStackLow`,
WebAssembly globals each instance starts afresh: every store to `pool_ptr` and `str_ptr` raises its
mark, and every growth of the stack lowers that one. Taking the address of either variable stops
the build, since a write through it would not move the mark, and so does a `tex.wasm` without the
three exports. The core dump, its layout and the TeX files come out byte-identical; `tex.wasm` grows
from 236,378 to 238,195 bytes, 69,594 to 69,861 gzipped, and TeX's time does not move measurably
(the campaign's two builds either side of the marks: WebKit 2,740 and 2,737 ms, Chromium 1,800 and
1,811, Node 2,219 and 2,220). Two builds from a new image, `tikzjax-engine:v021-reset`, gave the
same bytes.

**What the marks cost: 6% of how deep TeX nests in WebKit.** The deepest nesting of `\number` that
renders, verify-worker's construction, in a Web Worker started as the host starts one, with the
payload posted to it, bisected to one level, on the desktop of D27 on 2026-10-14:

| | Chromium 153 | WebKit 26.6 |
|---|---:|---:|
| 0.2.1-beta.1 | 2,344 | 21,281, or 20,049 |
| D27, D28, D29, D30 (no marks) | 1,622 | 21,280 |
| the marks | 1,622 | 19,950 |
| one Memory, and as 0.2.1 ships | 1,621 | 19,950 |

The two builds either side of the marks differ only in `tex.wasm`. The review of this release read
every row by bisection from a new browser, and 0.2.1-beta.1, D27's engine and the shipped build also
after a ladder of 500 to 3,000 and after six fixtures rendered twice; 0.2.1-beta.1 and the shipped
build were read again for this record, twice each way. Every reading agrees but 0.2.1-beta.1's in
WebKit, which reached 21,281 after the ladder and only 20,049 when the first diagram it compiled
was 20,050 deep. On Node 22.19's main thread the shipped worker reaches 3,132, where D27's did
(`verify:worker`). So the marks cost JavaScriptCore 1,330 levels and V8 none measurable; why has not
been looked into, and `verify:worker`'s floor, which runs in Node, cannot see it (D28). WebKit still
lets TeX nest twelve times as deep as Chromium, and an iPhone's limit has not been measured.

**The proof** is `npm run verify:reset`, in CI and in the Engine workflow. It runs the worker that
ships over every fixture and twelve inputs the fixtures do not reach, in five orders shuffled from
fixed seeds, a worker each:

- the `\detokenize`, the `\frac`s, a stack overflow, a fatal error and two passes;
- a line longer than TeX's buffer, at which the host cuts the run off (D29);
- a macro of 2,621,440 tokens, which runs TeX's free list of one-word nodes dry and takes
  `hi_mem_min` from the dump's 6,077,926 down to 3,477,793, where no fixture moves it;
- a font's parameters grown, and two `\fontdimen` errors, which write the dummy entry TeX keeps at
  `font_info[fmem_ptr]`;
- `\dump` in the body;
- every font metric the engine can load, 121 of them, at once, which holds the assumption above,
  that none stops loading half-way, against a later bundle: a font that does not load fails it;
- 20,000 names, a line each, which fill the hash table's overflow slots from `hash_used` down;
- `\scantokens`, whose pseudo-files e-TeX keeps in `mem`.

The free list's input and the names' fail the check if they stop moving their counter by a million
words and by ten thousand slots, so that neither can stop testing what it is there for unnoticed.
Before each run of TeX the check compares the Memory the worker hands TeX with the dump, all
163,840,000 bytes, which is what a new Memory holds; it requires a new Memory after a run that did
not end normally and the worker's own after any other; and it requires the same reply for an input
in every order, and a fixture's SVG to be the one smoke drew. On 2026-10-14: 285 runs, 241 on the
worker's Memory, reset, 44 on a new one, every one equal.

What it catches, each tried as one change in a scratch copy of the repository, run with one order:
the pool bounded at `pool_ptr` plus 4,096, `str_start` at `str_ptr`, `font_info` 600 entries short
of `fmem_ptr`, the stack at 64 bytes below the top, and, since the inputs above, `font_info` one
entry short of `fmem_ptr` (the `\fontdimen` input), `mem` from one word above `hi_mem_min` (the free
list's), `save_stack` without its slack of eight entries, and the hash's overflow slots left out.
What it cannot catch: the host's writes left out of the reset, since every one of them lands in a
global the reset writes back whole anyway, so `hostWrites` is a guard no input can show failing
(`test/library.test.ts` holds what it records); `save_stack`'s slack cut from eight entries to two;
and the one entry past `lo_mem_max`, `pool_ptr` and `str_ptr` left out, an entry TeX does not write.
`verify:golden` now runs the corpus on one Memory too, 38 of the 44 fixtures on the run before's,
and `test/reset.test.ts` holds the stretches to the committed dump's counters and the writing back
to the dump.

**What it gains.** The campaign of D29, the content process's working set and private commit, at
their peak over the round and at its end, sampled right after the last render with the worker still
alive; median (range) of the seven rounds, in MiB, for D28's commit, before any of D29 to D31, and
after each change in turn:

| WebKit 26.6 | peak working set | peak commit | working set at the end | commit at the end | most Memories alive at a reply |
|---|---:|---:|---:|---:|---|
| before | 679 (502–782) | 3,139 (2,145–3,440) | 306 (231–340) | 1,047 (590–1,366) | 9 to 17 |
| D29 | 470 (442–602) | 2,236 (1,907–3,140) | 270 (199–339) | 953 (467–1,474) | 8 to 15 |
| D30 | 445 (408–586) | 2,042 (1,854–3,120) | 221 (188–518) | 616 (458–2,683) | 8 to 16 |
| the marks | 451 (420–586) | 2,174 (1,880–3,158) | 239 (213–343) | 774 (615–1,546) | 8 to 15 |
| one Memory | 423 (405–471) | 1,755 (1,533–1,786) | 347 (275–405) | 1,268 (672–1,461) | 7 to 8 |

| Chromium 153 | peak working set | peak commit | working set at the end | commit at the end | most Memories alive at a reply |
|---|---:|---:|---:|---:|---|
| before | 344 (322–346) | 1,099 (943–1,102) | 235 (231–299) | 321 (317–786) | 5 to 6 |
| D29 | 343 (338–346) | 1,233 (1,228–1,236) | 232 (207–255) | 453 (294–610) | 7 |
| D30 | 350 (331–380) | 1,373 (1,221–1,537) | 265 (197–291) | 753 (284–913) | 7 to 9 |
| the marks | 331 (325–350) | 1,221 (1,215–1,376) | 262 (193–290) | 750 (280–912) | 7 to 8 |
| one Memory | 236 (234–239) | 582 (581–585) | 196 (194–199) | 277 (276–279) | 3 |

The reset's own share is the last two rows. In WebKit it is 451 → 423 MiB at the peak and 2,174 →
1,755 MiB committed; most of the drop from 679 and 3,139 came with D29. In Chromium it is nearly all
of it, 331 → 236 and 1,221 → 582.

Node 22.19's peak resident memory went 192 → 171 MiB. TeX's time does not change: the paired
rounds against the commit before put the whole of D29 to D31 at −4.2% in WebKit, −5.5% in
Chromium and −4.6% in Node, D29's gain. Every reply was byte-identical to the golden corpus.
`main.js` grows by 4,492 B for the reset and the places of the 23 globals it reads. Nothing has
been measured on a phone.

**What it does not gain.** The end of a round did not come down in WebKit, the engine of every
iPhone: across the reset its working set went 239 → 347 MiB and its commit 774 → 1,268 MiB, where
it was 306 and 1,047 before D29. The ranges are wide and the sample falls wherever the collector
happens to be, so this is not a proven regression, but the review of this release reproduced it in
three paired rounds of its own (the 0.2.0 corpus twice each, working set after the last render:
257, 235 and 235 MiB against 352, 349 and 349). Most of it is the new Memories taken after the
round's ten runs that jump out of TeX: in the five rounds of the trial below, trusting those runs
left WebKit at 300 MiB and 659 MiB committed at the end of a round, against 337 and 1,232. A kept
Memory also stays committed while its worker idles, 156.25 MiB a worker, until the idle stop: 30 s
on a phone, 5 minutes on a computer, which can have two. Nothing has measured that. The end of a
round is the figure nearest to what an idle iPhone holds, so the iPhone's memory check in `TODO.md`
reads the memory once the diagrams have settled, not only at the peak.

**0.2.1 against 0.2.1-beta.1**, the figures the CHANGELOG gives: a campaign of seven rounds on
2026-10-14, on the desktop of D27 and with the harness as D29 ran it, of 0.2.1-beta.1's published
`main.js` against 0.2.1's (worker `0ccfc5f69326…`), each round a fresh browser or process per build,
the builds' order rotated, a cold `basic` and then the 37 fixtures of 0.2.0's corpus twice each.
Another job, a WebKit benchmark without its JIT, kept one of the desktop's 32 threads busy
throughout, and both builds ran beside it; the sums came out within 1.5% of what D27's and D31's
campaigns measured for the same engines. All 3,570 replies were byte-identical to the golden
corpus. TeX is the sum of each fixture's minimum over the rounds, and the first `basic` its
minimum; the rest are medians (range) of the rounds, memory in MiB:

| | WebKit 26.6, beta.1 | WebKit 26.6, 0.2.1 | Chromium 153, beta.1 | Chromium 153, 0.2.1 |
|---|---:|---:|---:|---:|
| TeX, 37 fixtures | 4,213 ms | 2,773 ms (−34.2%) | 2,794 ms | 1,828 ms (−34.6%) |
| the first `basic` after the start | 32 ms | 27 ms | 27 ms | 24 ms |
| engine start | 147 ms | 58 ms | 162 ms | 51 ms |
| peak working set | 645 (488–758) | 423 (411–429) | 318 (316–323) | 235 (234–238) |
| peak commit | 2,954 (2,156–3,178) | 1,754 (1,538–1,791) | 939 (938–944) | 582 (581–586) |
| working set at the end | 226 (204–398) | 378 (301–410) | 272 (247–298) | 195 (195–199) |
| commit at the end | 575 (502–1,804) | 1,423 (1,134–1,470) | 625 (466–785) | 277 (276–281) |

Each round against beta.1's: −34.2% in WebKit, −35.3% in Chromium, −27.5% in Node 22.19 (3,028 →
2,207 ms), medians. Every fixture took at least 28% less in both browsers by its minimum, the least
`arrows-meta` in WebKit (64 → 46 ms) and `broken` in Chromium (14 → 10 ms). The end of the round
rose in WebKit against beta.1 too, as above.

**Not taken, for the maintainer to decide: trusting a run that jumped out of TeX.** The round's
fixtures include five that end in a jump out of TeX, each rendered twice, so each round makes ten
new Memories, and they are what WebKit still holds at a reply. A jump is TeX's own end of a fatal
error (D17), at a point where its counters hold, and the marks are kept however the run ends: with
the worker trusting it like a normal end, `verify:reset` passed with every Memory equal (240 runs
on the worker's own, 10 new), and five rounds against this build, the same day, gave WebKit a peak
commit of 662 MiB (635–665) against 1,752 (1,726–1,760), a working set of 301 against 423, and
Chromium 323 against 582 MiB of commit. It is not taken because a jump is an exception through the
engine, after which the design this follows takes a new Memory, and how often a real note's
diagrams end that way has not been measured. `TODO.md` lists it as open.

---

## D32 — A diagram starts from the run an earlier one with the same preamble saved at its \begin{document}

**Amends D24, whose closing paragraph left the preamble snapshot and routing by preamble to 0.2.3,
D31, whose reset now also covers a run that resumed, and DESIGN.md §4.3 and §5.4. Builds on the
0.2.x study's prototype and its review (findings M1, M3, S2, S3, S4, S5, S7, N3, N4), and amended
after the review of 0.2.1-beta.3's changes: what is saved and kept, the switch, how runs are named,
the proof, and a campaign at a phone's budget. Date of record: 2026-10-14.**

A diagram that loads packages spends most of TeX's time loading them, and every diagram did it
again, also the second of two with the same preamble in one note. Since this release a diagram's
first pass is saved where TeX stands once its `\begin{document}` is done, and a later diagram whose
input is the same up to there starts from that point and compiles only its body.

**The point in the engine.** `engine-build/changes/snapshot.ch` adds `\tikzjaxsnapshot`, a command
of `main_control`'s own, so that when it runs the WebAssembly call stack is the program,
`main_control` and the host, and all of TeX's state is in its memory: the input stack and the token
lists it is reading among it. It sets a new global, `resume_pending`, to 1, calls the host's new
`snapshotPoint` import, sets it back to 0, and then does what `\ignorespaces` does. A run started
from a memory copied during the call finds `resume_pending` 1 at the top of the program, goes
straight to `main_control`, and `main_control` carries on where the command left off.
`\tracingcommands` does not show it.

The prototype put the command on a line of its own after the line of `\begin{document}`, in the
input file, and took that line out of TeX's count of lines. The review found that the line was still
there for every other reader of the file: `\edef\sz{\filesize{\jobname.tex}}` drew 441 where 0.2.0
drew 424, and a preamble that counted the file's lines with a second `\openin` counted one more,
also in a run that saved nothing (M1). So the command is not in the input at all. The format runs it
from LaTeX's `begindocument/end` hook, the last thing `\begin{document}` does before its
`\ignorespaces`: the engine build adds `\AddToHook{begindocument/end}{\tikzjaxsnapshot}` to the
terminal lines the format is made with (`engine-build/build-engine.sh`). Code added there from the
preamble is the hook's top-level code, which LaTeX runs after every package's labelled code for the
hook. `\ShowHook` in a diagram's preamble shows it so: a label of the preamble's own first, then, as
top-level code, the snapshot point, then etoolbox's `\AfterEndPreamble` code and the preamble's own
`\AddToHook{begindocument/end}` code, which a resumed run reads on from the saved token lists as the
run that saved it did. standalone then appends `\standalone\ignorespaces` to `\document`, which runs
after the point too. TeX has read its input through the end of the line holding the real
`\begin{document}`, whichever line that is: a `\begin{document}` given by a macro or written into a
`filecontents` file ahead of the real one moves nothing (N3), and the text after it on its line is
part of what the run stands for.

tex.wasm grows from 238,195 to 238,370 bytes, 69,861 to 69,926 gzipped, and `core.dump.gz` from
5,938,929 to 5,939,303. Two builds from a new image, `tikzjax-engine:v021-snapshot`, gave the same
bytes. All 44 fixtures give the golden corpus's DVI, transcript and SVG. Through the shipped worker,
saved preambles on, each fixture and each case of `verify:snapshot` below, drawn with its first
body, its second and its first again, gives every reply field the plugin reads as 0.2.1-beta.2's
worker, built from its release commit, gives it, but one: with `\tracingmacros` and
`\tracingonline`, the transcript shows the hook's top-level code as `->\tikzjaxsnapshot ` where it
was `->`, on one of its 156,067 lines. `filesize-self` and `read-self` draw what beta.2 draws. So
`OUTPUT_REVISION` stays where it is, and nothing cached compiles again.

**What a saved run stands for.** The exact text TeX had read when the point ran, through the newline
that ends that line, and whether the log is kept, since a run that kept none has none to say again.
Everything else a run depends on is fixed for a worker's life: the engine, its files, its clock, and
the first pass's job name, `input`; the files only since D35, before which a diagram that wrote a
file named as a bundled font's metrics wrote into that font for every later diagram. A later first
pass resumes from the saved run whose text its input starts with, the longest if several do,
compared as text in the worker, so two inputs that differ anywhere up to there never share one.
Nothing is saved when TeX learnt more of the job's own file than the lines its main input read (M1):
the host notes a `\filesize` of `input.tex` and any second opening of it, by `\openin`, `\input` or
`\openout`, and then says nothing can be saved (`library.ts` `jobFileRead`), nor when the main input
has read the file to its end. A second pass never resumes: it reads at `\begin{document}` the `.aux`
the first wrote.

**What is saved.** At the point, the worker reckons the parts of TeX's globals the run can have
written so far exactly as the reset does after a run (D31: every global but the big arrays, those up
to TeX's counters and the engine's marks, and what the host wrote), rounds them out to blocks of 256
bytes, and keeps each block in which a byte differs from the core dump, blocks side by side as one
stretch (`engine-src/snapshot.ts`). Not the string literals, which instantiating the engine writes
afresh, nor the stack: its frames belong to calls a resumed run does not return to. With the
stretches go the host's table of files, the bytes of the files TeX is writing (`input.log`,
`input.aux`, a `\write` stream left open) copied, the files it reads by their place in them but the
job's own, whose text a run that resumes is always given anew, and what TeX had said on the
terminal and failed to find by then. Until the review of beta.3 the saving diagram's whole text was
kept too, twice, by reference, outside what the budget counts. The build now packs the dump's runs
on 8 bytes (`scripts/engine-assets.mjs` `packCoreDump`), so that the comparison reads TeX's memory
and the dump a word at a time; the dump's bytes are as before. A word cut by the end of a run of the
dump that is not on a word, from a dump packed some other way, is read a byte at a time: until the
review the zeros up to such a run were read a word at a time, rounded down, and up to three changed
bytes before it were never compared. A saved run of the fixtures is 0.60 MiB
for TikZ alone, 2.62 for siunitx, 6.42 for pgfplots and 8.83 for circuitikz, the same as the
prototype's.

**Starting from it.** The worker writes the stretches over the dump in its one Memory, after the
reset (D31), puts the host's files back with the job's file holding the new diagram's text, says
again what the saved run had said, and calls the engine. The reset before the next run writes the
dump back over what the resumed run wrote and over the stretches: a string the saving run made and
flushed before the point lies in the stretches past where the resumed run's own marks reach.

**A save that fails keeps nothing (S2).** The whole save is in a `try`, and the host's
`snapshotPoint` in another, so that nothing it throws reaches TeX, where a RangeError would read as
the engine's stack running out. The diagram is drawn as from the start, says `saving the preamble
failed`, and the worker counts it.

**What a save costs the first diagram of its preamble (S4).** The comparison reads the 26.5 MiB of
TeX's globals a run can have written and the dump's bytes beside them; in Node 22.19 that is 7.7 to
13.7 ms, 19.7 for the first save of a process, and the rest of the save under 2 ms. Three ways of
paying it were built and measured with the 0.2.x study's harness on the desktop of D27 on 2026-10-14
(Playwright 1.63, WebKit 26.6 and Chromium 153): seven rounds per build, each a fresh browser, a
cold `basic` first and then every fixture twice in a row, every SVG as smoke draws it. The first
diagram is the time from posting `basic` to its reply on the main thread; medians (range) over the
rounds, in ms:

| | first diagram after the start | its save | every save | the round's renders, whole |
|---|---:|---:|---:|---:|
| Chromium, saved preambles off | 48 (35–53) | – | – | 10,878 (8,487–11,478) |
| Chromium, saved there | 70 (47–79) | 16 (12–19) | 9 (7–19) | 8,911 (6,966–9,628) |
| Chromium, copied there, compared after the reply | 60 (40–63) | 7 (6–9), the copy | 5 (4–9) | 8,996 (6,986–9,431) |
| Chromium, saved at a preamble's second diagram | 51 (35–60) | – | 9 (7–18) | 10,139 (8,488–10,705) |
| WebKit, saved preambles off | 65 (55–71) | – | – | 16,728 (14,750–17,548) |
| WebKit, saved there | 70 (67–85) | 11 (10–14) | 6 (3–14) | 12,789 (11,118–13,747) |
| WebKit, copied there, compared after the reply | 72 (49–78) | 7 (6–11), the copy | 8 (3–12) | 12,637 (9,963–13,388) |
| WebKit, saved at a preamble's second diagram | 62 (41–67) | – | 6 (3–10) | 15,028 (11,308–15,780) |

The first ships. Comparing after the reply took 10 ms off the first diagram in Chromium and nothing
in WebKit, the engine of the phones this is for, for a copy of 26.5 MiB at every save, which on a
phone is memory it may not have. Saving at the second diagram of a preamble spared the first its
save and cost 23 of the 74 resumes of a round. A further variant, saving at the second sighting only
once the budget is full, so that a note drawn a second time finds what was saved first, resumed 66 a
round against 74, 48 against 52 in the note of 74 below, and 32 against 33 in the spread one, and
was not kept either. In the build that ships the save's time is its own step, not TeX's.

**What is kept, and the switch.** An engine holds saved runs up to a budget the host sends with
every job: 32 MiB on a computer, which holds the three largest preambles of the fixtures beside
TikZ's, and 12 MiB on a phone or a tablet, well under that until a phone has been measured (S7),
and on a computer that reports less than 8 GiB of memory, which runs one engine already (D24;
`src/platform/budgets.ts` `snapshotBytes`, since the review of beta.3). Least recently used goes
first, but never the run the render under way resumed from, nor one resumed from within the last 16
renders, so that diagrams cycling through more preambles than the budget holds do not each save and
evict the one the next needed.

A run that would not fit once everything that may go had gone is not kept, and nothing is evicted
for it; and a run is not saved at all where the room there would be is less than the last run saved
under the same name took, or, for a name with none, the smallest run saved yet. Until the review of
beta.3 this paragraph said that a run that would not be kept is not saved, and it was not so:
`wants()` asked only whether anything could go, and `set()` evicted before it knew whether the run
would fit. With 12 MiB, through the worker in Node 22.19, basic, siunitx twice, pgfplots-axis twice,
then circuitikz and basic in turn three times: circuitikz's 8.83 MiB could not fit beside the two
runs being resumed from, took TikZ's 0.60 with it at each circuitikz diagram, and every basic after
saved again, in 14 to 16 ms of TeX where it resumes in 5 to 7; the save's time was counted as TeX's
and nothing said so. Now circuitikz's run is saved once and not kept, TikZ's stays, the later
circuitikz diagrams save nothing, and every later basic resumes. A save that was not kept is the
save's time, not TeX's, and the diagnostics say "preamble saved in N ms, not kept: no room".

**Amended by D39.** Where the host asks for a run to store (D36), a run the worker could not keep is
saved all the same, once a name in the worker's life, handed over and let go: until then a preamble
that came after runs filling the worker was not saved at all, and so not stored from that worker. A
name is saved for the store again after its hand-over was dropped for room, or the store cleared, not
after a hand-over that failed.

The runs go with the engine: its idle stop, the app going to the background, Restart the TeX engine
(S3, and `TODO.md` for keeping them across restarts). Settings → Rendering → Saved preambles,
`"preambleSnapshots"` in `data.json`, turns them off without a release: the host then sends 0, and
the worker neither saves nor resumes and lets what it holds go. Until the review of beta.3 it was in
`data.json` only, to save a string to translate and a setting nobody should need, but a phone, where
saved preambles are least proven, cannot reach `data.json`: the Files app on iOS hides folders whose
names start with a dot, and Sync brings the file only with "Installed community plugins", which the
README tells Sync Standard users to turn off. A release can still change its default.

**Two engines (S5).** Each engine keeps its own runs, so the host names each job's run
(`engine-src/document.ts` `routeOf`, from the input's first `\begin{document}` line that is not in a
comment) and gives the job to the idle engine that holds it; else to one that holds none of the runs
the other waiting jobs want, else to the first idle one (`src/engine/route.ts`). The worker names
each run it saves as the host named the diagram that saved it, so that the host finds it again for
the next diagram it names the same, or, where the host has no name, by the text the run stands for.
The name is only for routing: since the review of beta.3 the worker saves whether or not there is
one, where it saved only a diagram the host could name, so that a block whose `\begin{document}`
followed `\%` on its line, or was written nowhere in its text, never saved its preamble; and a `%`
is a comment only with an even run of backslashes before it (`engine-src/comment.ts`). It never
keeps a job waiting for a busy engine. The worker reports the names with each reply. In a note the
queue hands the host as many jobs as there are engines (D24), and in this harness's note of 0.2.0's
37 fixtures twice, handed over that way, routing changed little:

| a note of 74, 0.2.0's 37 fixtures twice, two engines, ms | 0.2.1-beta.2 | routed | not routed |
|---|---:|---:|---:|
| each fixture twice in a row, Chromium | 2,194 (2,166–2,201) | 2,233 (2,218–2,242), 32 resumed | 2,249 (2,227–2,260), 32 resumed |
| each fixture twice in a row, WebKit | 3,188 (3,183–3,208) | 3,128 (3,083–3,138), 32 resumed | 3,152 (3,109–3,157), 32 resumed |
| every fixture, then every fixture again, Chromium | 2,168 (2,160–2,183) | 1,999 (1,982–2,243), 33–40 resumed | 1,973 (1,765–2,186), 34–44 resumed |
| every fixture, then every fixture again, WebKit | 3,198 (3,184–3,212) | 2,814 (2,761–3,153), 33–41 resumed | 2,797 (2,739–3,136), 34–42 resumed |

Time from the first job to the last reply, median (range) of five rounds, each a fresh browser, the
builds interleaved, on the desktop of D27 on 2026-10-14, with the harness's note handing the host
two jobs at a time as the queue does, and every SVG as smoke draws it.

With the fixtures in pairs, both diagrams of a pair start together, one on each engine, and neither
has a run to resume; spread out, an engine's budget no longer holds every preamble of the note.
Routing helps a note whose diagrams share a preamble but are not side by side, and a block typed in
while another engine is busy.

**The proof (M3).** `npm run verify:snapshot`, in CI and in the Engine workflow, renders every
fixture and every case of `scripts/snapshot-hazards.mjs`, each with two bodies under one preamble,
from the start, saving, resumed from its own run and resumed from the other body's, and compares:

- in the engine, run with the worker's own modules: the DVI, the terminal output, `input.log`, the
  files TeX did not find and every other file it wrote, byte for byte, and the resumed runs again
  with the stack filled with 0xAA, which a run may not read before it writes (N4, the review's R7);
  and, at every save, that every byte of TeX's globals that differs from the dump lies in what the
  save compared, the prototype's `validate-ranges` over the layout the build writes;
- in the shipped worker: every reply field the plugin reads, and that each case saved and resumed,
  or did not, as it says, once with TeX's log kept, the plugin's default, and once without, which a
  setting can have and which a saved run stands for (since the review of beta.3, which ran every
  case without the log by hand and found every reply as from the start); and that a run saved with
  the log kept starts no diagram drawn without it;
- and that a save that fails at its first copy, or at its comparison, keeps nothing, draws the
  diagram as from the start, and is counted.

It reads no golden output, so it holds when the corpus is recorded again for TeX Live 2026. The
hazards are the prototype's eighteen (counters, `\jobname`, two passes, a `\write` and a `\read`
left open, catcodes, an error in the preamble and in the body, random numbers, the clock, a preamble
of several lines, a block's own `\begin{document}`, `\AtBeginDocument` and `\AtEndDocument`,
`\batchmode`, `\inputlineno`, a group and a conditional left open, the point redefined, tracing),
the review's two, a `\filesize` of the job's own file and a second `\openin` of it read to the end,
both saving nothing, and ten of this release's: a missing package, a fatal error in the preamble,
which saves nothing, the body on `\begin{document}`'s line, `\begin{document}` from a macro, a
`filecontents` file holding one, the hook's order, characters the Unicode bridge declares, the job's
file read in the body, a terminal line unfinished at the point, and two blocks that differ only
after `\begin{document}` on its line, which must not share a run; and the review of beta.3's three:
a body that writes `eufm10.tfm` under a preamble that loads the font (D35), a `\begin{document}`
after `\%` on its line, and one written nowhere in the block's text, the last two of which saved
nothing before. On 2026-10-14, on the build that ships: 77 cases, 880 runs in the engine, 572 of
them resumed, and in the worker 292 renders that saved and 428 that resumed, over both passes, every
one as from the start, in two minutes. `npm run verify:reset` now sends the budget with every render
and requires a resumed run's Memory to be the dump with the globals of the run it resumed from, as
they stood at the point, and nothing else: 290 runs in five orders, 163 of them resumed, every
Memory as required; one of its inputs writes a file under the name of every bundled font's metrics
(D35). `verify:worker` sends the budget too, so the fixtures run there as the plugin runs them.

What the checks catch, each tried as one change in a copy of the repository: the job file's size or
second opening no longer stopping a save (`filesize-self` and `read-self` resume a run that saw the
first body, in the engine and in the worker); the save leaving out `eqtb` (4,102 to 4,160 bytes of
the globals changed outside what was compared, and every resumed run differs); the saved terminal
lines not said again (every resumed reply differs); the unfinished terminal line not put back (the
unfinished-line case, and only it); and the reset after a resumed run leaving out the stretches
(`verify:reset`, in two of its five orders, a byte of `str_pool` past where the resumed run's marks
reach). Copying the written files again when a run resumes is a guard none can show failing: the
saved copies are exactly as long as what was written, so the first write grows them into a new array
anyway. The review of beta.3's changes, each undone in turn on this branch: a bundled `.tfm` opened
to write handed the bundled bytes (the hazard fails in the engine and in the worker, `verify:reset`
in four of its five orders); a save planned only for a diagram the host can name (the two new
hazards' first bodies are drawn from the start, not saved); and the zeros before a run of the dump
read a word at a time (`test/snapshot.test.ts`, a change two bytes before a run that starts off a
word is not kept).

**What it gains**, against 0.2.1-beta.2 built from its release commit, on the desktop of D27 on
2026-10-14 with the harness as above, the build before the review of beta.3's changes, with saved
preambles on as the plugin sent them at a computer's 32 MiB (the build that ships, and 12 MiB, are
measured below):

| | 0.2.1-beta.2 | this release |
|---|---:|---:|
| TeX, the 44 fixtures' second render in a row, sum of each one's fastest, Chromium 153 | 4,197 ms | 2,639 ms (−37.1%) |
| the same, WebKit 26.6 | 5,861 ms | 3,876 ms (−33.9%) |
| TeX, their first render, after a cold `basic`, Chromium | 4,164 ms | 3,734 ms (−10.3%) |
| the same, WebKit | 5,907 ms | 5,443 ms (−7.9%) |
| every render of the round, wall time, median (range), Chromium | 10,441 (8,808–10,850) | 8,367 (6,949–8,510) (−19.9%) |
| the same, WebKit | 13,839 (12,487–15,276) | 11,892 (10,056–12,416) (−14.1%) |
| the first diagram after the start, `basic`, wall time, Chromium | 46 (37–55) | 63 (47–75), its save 14 (12–20) |
| the same, WebKit | 42 (41–59) | 69 (50–75), its save 10 (8–14) |
| every save, median (range), 90th percentile | – | Chromium 9 (7–20), 11; WebKit 5 (3–14), 6 |
| a note of 74, each of 0.2.0's 37 fixtures twice in a row, one engine, Chromium | 4,180 (4,165–4,202) | 3,114 (3,096–3,135) (−25.5%) |
| the same, WebKit | 6,237 (6,187–6,285) | 4,491 (4,487–4,517) (−28.0%) |
| the same note spread, every fixture and then every fixture again, one engine, Chromium | 4,183 (4,157–4,199) | 4,240 (4,200–4,284) (+1.4%) |
| the same, WebKit | 6,211 (6,183–6,270) | 6,023 (5,988–6,064) (−3.0%) |

Seven rounds for the fixtures and five for the notes, each round a fresh browser per build, the
builds interleaved, the order of the browsers reversed every other round; TeX is the worker's own
`texMs`, which leaves the save out, and each sum is of each fixture's fastest over the rounds. Every
reply was as smoke draws it. The second render of a diagram resumes, the first resumes when an
earlier diagram had its preamble, which for the fixtures without packages of their own is the cold
`basic`: by each one's fastest, a second render of `basic` took 14 → 5 ms in Chromium and 19 → 7 in
WebKit, `siunitx` 93 → 10 and 127 → 19, `tikz-cd` 68 → 34 and 105 → 53, `circuitikz` 213 → 68 and
321 → 108, `pgfplots-axis` 209 → 81 and 311 → 130, `feynhand` 242 → 166 and 388 → 278. The spread
note gains nothing on one engine: its preambles do not all fit in the budget, so a run is let go
before its second diagram comes. The first diagram after the start pays its save; in the rounds in
which both builds compiled it equally fast, that is all it paid. The absolute figures differ from
D27's to D31's: these campaigns ran at another hour, beside other work on the desktop, and only
figures from the same campaign are compared.

**What it costs.** `main.js` grows by 11,416 bytes, 12,182,125 to 12,193,541: the worker's code by
6,802 characters, the engine by 364, and the host by the input's assembly, which it now runs for
each job to name its run. Memory: over the fixtures' round above, the peak working set went from 235
to 280 MiB in Chromium and from 427 to 449 in WebKit, the peak private commit from 582 to 632 MiB
and from 1,756 to 1,790 MiB, and the working set after the last render, the saved runs still held,
from 205 to 259 MiB and from 344 to 351 (medians of seven rounds); in the one-engine note, the peak
working set from 238 to 290 MiB and from 411 to 469, and WebKit's peak commit from 1,748
(1,746–1,757) to 1,956 (1,766–1,983) MiB. Nothing has been measured on a phone.

**Without the JIT.** WebKit with `JSC_useJIT=false`, which runs JavaScript and WebAssembly as
Lockdown Mode does on an iPhone, on the same desktop: `basic`, `siunitx`, `circuitikz` and
`pgfplots-axis` twice each after a cold `basic`, three rounds per build. The second render's TeX, by
each one's fastest, went from 415 to 148 ms, 3,402 to 362, 8,659 to 3,028 and 7,862 to 3,709, and
the round from 45,201 to 30,758 ms (medians, −32%); the first diagram after the start from 497
(437–531) to 612 (553–847) ms, its save 124 (115–169) ms, and every save 114 (92–169). Without the
JIT a save costs a tenth of a second where it costs ten milliseconds, and a resumed diagram saves
seconds.

**Measured again after the review of beta.3**, because the campaigns above, of the build before its
changes, all ran at a computer's 32 MiB and none at the 12 MiB a phone has. The build that ships
against 0.2.1-beta.2's `main.js` as published, on the same Windows desktop on 2026-10-14, with
Playwright 1.63's headless WebKit 26.6 and Chromium 153 and the 0.2.x study's harness, sending
the budget with every render as the plugin does, five rounds of each, each a
fresh browser, the builds interleaved, every SVG as smoke draws it:

| | 0.2.1-beta.2 | 0.2.1-beta.3, 32 MiB | 0.2.1-beta.3, 12 MiB |
|---|---:|---:|---:|
| TeX, the 44 fixtures' second render in a row, sum of each one's fastest, WebKit | 5,444 ms | 3,550 (−34.8%) | 4,296 (−21.1%) |
| the same, Chromium | 3,671 ms | 2,432 (−33.8%) | |
| their first render, after a cold `basic`, WebKit | 5,468 ms | 4,992 (−8.7%) | 5,128 (−6.2%) |
| the same, Chromium | 3,695 ms | 3,405 (−7.8%) | |
| the round's renders, each posted to its reply, added up, WebKit | 11,504 (11,472–11,642) | 9,345 (9,233–9,400) | 10,202 (10,176–10,231) |
| the same, Chromium | 7,840 (7,808–7,971) | 6,434 (6,364–6,465) | |
| saves a round, of them not kept, and resumes, WebKit | – | 23, 0, 74 | 22, 3, 68 |
| the first diagram, `basic`, posted to its reply, WebKit | 40 (39–46) | 49 (48–55), its save 9 (8–10) | 49 (49–50), its save 9 (8–10) |
| the same, Chromium | 34 (33–37) | 45 (44–52), its save 12 (12–14) | |
| a note of 74, 0.2.0's 37 fixtures each twice in a row, one engine, WebKit | 5,824 (5,791–5,875) | 4,231 (4,201–4,282) (−27.4%) | 4,777 (4,764–4,822) (−18.0%) |
| the same, Chromium | 3,881 (3,837–3,908) | 2,894 (2,852–2,922) (−25.4%) | |
| saves, of them not kept, and resumes in it, WebKit | – | 20, 0, 52 | 19, 4, 47 |
| the same note spread, every fixture and then every one again, WebKit | 5,824 (5,797–5,858) | 5,652 (5,626–5,713) (−3.0%) | 5,644 (5,569–5,655) (−3.1%) |
| the same, Chromium | 3,869 (3,844–3,895) | 3,928 (3,911–3,975) (+1.5%) | |
| peak working set, the fixtures' round, WebKit | 428 (426–468) MiB | 456 (452–491) | 453 (448–454) |
| the same, Chromium | 235 (234–239) MiB | 277 (276–280) | |
| peak working set, the note in pairs, WebKit | 420 (412–430) MiB | 447 (440–534) | 445 (439–514) |
| the same, Chromium | 237 (225–243) MiB | 286 (284–299) | |
| peak working set, the note spread, WebKit | 447 (442–464) MiB | 488 (484–542) | 489 (481–493) |
| the same, Chromium | 244 (243–246) MiB | 326 (320–327) | |

Medians (range); a note is the time from its first job to its last reply. At a phone's 12 MiB the
fixtures run twice in a row keep 19 runs of 22 saved where 32 MiB keep all 23, and resume 68
diagrams where 32 MiB resume 74: `forest`'s, `pgfplots-fillbetween`'s and `pgfplotstable`'s runs, in
every round, could not fit beside the runs resumed from within the last 16 renders, and the note in
pairs kept 15 of 19. So the second render's TeX went down by a fifth there rather than by
a third, and the note in pairs by 18% rather than 27%. Spread, the note keeps and resumes as many at
12 MiB as at 32: neither holds its preambles until their second diagram. The peak working set grew
by more than the budget: at 12 MiB by 25 to 42 MiB in WebKit, the medians of the three, and at 32
by 27 to 41 in WebKit and 42 to 82 in Chromium. A save copies what it keeps, and a run let go is
memory until the collector frees it, so the budget bounds what is held, not the peak; on a phone,
the 12 MiB stand until `TODO.md` §9's check of the memory, procedure C under the Web Inspector, says
what a phone pays.

Without the JIT, WebKit with `JSC_useJIT=false`, the same desktop and harness, three rounds of
`basic`, `siunitx`, `circuitikz` and `pgfplots-axis` twice each after a cold `basic`, at the 12 MiB
a phone in Lockdown Mode has: the second render's TeX, by each one's fastest, went from 375 to
136 ms, 3,103 to 354, 7,660 to 7,646 and 7,186 to 2,989, and the round from 37,471 (37,414–37,518)
to 30,404 (30,376–30,407) ms; the first diagram from 416 (410–416) to 509 (500–511) ms, its save 108
(108–110), and every save 103 (83–110). `circuitikz`'s run of 8.83 MiB did not fit beside TikZ's and
siunitx's, resumed from just before, and was not kept, so its second render compiled from the start.

And the sequence that showed runs evicted for nothing, at 12 MiB in WebKit, two rounds of each:
`basic`, `siunitx` twice, `pgfplots-axis` twice, then `circuitikz` and `basic` in turn three times.
With the build before the review, each `basic` after a `circuitikz` saved again, in 16 to 18 ms of
TeX, and `circuitikz` saved nothing it said; with the build that ships, `circuitikz`'s first save
says it was not kept, the later ones are not made, and each `basic` resumes, in 6 to 7 ms.

`main.js` is 12,202,333 bytes, 20,208 more than beta.2's and 4,525 more than the build before the
review's.

**Not done, and open.** Saved runs do not survive the engine's stop; keeping them in IndexedDB,
keyed by ENGINE_ID, is the 0.2.4 plan's, and on a phone, where the engine stops after 30 s idle and
in the background, they matter most (S3); D36 keeps them, in 0.2.1-beta.4.
`\ShowHook{begindocument/end}` and `\tracingmacros` show the command, and a diagram that calls
`\tikzjaxsnapshot` itself saves where it calls it, which stands for the text read up to there as
well as any other point; one that redefines it saves nothing. TeX Live 2026 (0.3.0) has to apply
`snapshot.ch` (tie stops the build otherwise), keep `\document`'s `begindocument/end` hook and its
top-level code last, and pass `verify:snapshot` before the corpus is recorded again (S9).

---

## D33 — The engine says whether WebAssembly runs with a JIT, and an iPhone without one says why diagrams are slow

**Extends D21's diagnostics and D30's `ready`. Date of record: 2026-10-14.**

On the maintainer's iPhone with 0.2.0, read off the diagnostics view, a circuitikz diagram took
7.3 s of TeX with Lockdown Mode on and 0.27 s with Obsidian excluded from it, and the engine started
in 1.3 s instead of 0.13 s. Lockdown Mode runs Obsidian's web content without the JIT compiler, and
the TeX engine with it. Nothing in a WebView says whether it has a JIT, and `navigator.userAgent`
is out of bounds anyway (D21), so someone in that state saw slow diagrams and nothing to say why.

The phone, written down on 2026-10-15 with the maintainer's figures for 0.2.1's notes: an iPhone 16
Pro on iOS 27.0.1, with Obsidian 1.14.5, the same as in D38. The README gives these readings with
that device, iOS version and date.

**The probe** (`engine-src/jit.ts`). At each start, beside tex.wasm, the worker compiles a module of
its own, 68 bytes of WebAssembly 1.0 with one function that takes a step of a linear congruential
generator `n` times: a chain of dependent integer multiplies and adds that no compiler can shorten,
whose result it returns. Once both are compiled, it calls it once for 2,000 steps, untimed, so that
no attempt pays for the function's first compile, and then times attempts of 600,000 steps, each in
8 calls of 75,000, by the worker's `performance.now()`. An attempt that reaches 3 ms before it is
done stops there and is slow. The JIT is taken to be off when 4 attempts in a row are slow, and on
at the first that is not. `ready` carries what it found in its BootTimings (`jit`: on or off, the
fastest attempt, how many attempts, what the probe took).

- **WebAssembly, not JavaScript**, because TeX is WebAssembly: whichever of an engine's compilers
  is off, the probe says what TeX gets. JavaScriptCore with its WebAssembly compiler off and its
  JavaScript ones on, below, is taken for without; with only its optimising JavaScript compiler
  off, for with.
- **Compiled beside tex.wasm, off the worker's thread** (`WebAssembly.compile`), because in
  JavaScriptCore the first WebAssembly module of a process costs more: in the calibration below, the
  probe's module took 4 to 5 ms to compile in the first worker of each fresh WebKit with its JIT,
  and under a millisecond by its clock in every later one. Until the review of beta.3 it was
  compiled with `new WebAssembly.Module` on the worker's thread once tex.wasm was compiled, which on
  the loaded desktop below cost WebKit's starts tens of milliseconds and up to 242, while each
  start's first attempt read 0 to 1 ms; see "What it costs the start".
- **Four attempts**, because an attempt the system takes the thread away from in the middle is
  slow whatever the JIT does. With three, on the loaded desktop below, one start of 130 with the JIT
  needed its third.

**Calibration**, on the desktop of D27 (Windows 11, i9-13900K) on 2026-10-14, with Playwright 1.63's
WebKit 26.6 and Chromium 153, and Node 22.19; each worker started from a Blob of its source, as the
host starts one. The loop alone first, in nanoseconds a step, the fastest of five calls of at least
8 ms, in fresh workers, two browsers or processes of two workers each:

| | WebAssembly | the same loop in JavaScript |
| --- | ---: | ---: |
| Chromium 153 | 0.77–0.83 | 0.77–0.82 |
| WebKit 26.6 | 0.78–0.86 | 0.78–0.86 |
| Node 22.19 | 0.80–0.83 | 0.81–0.85 |
| WebKit, `JSC_useJIT=false`, as Lockdown Mode runs it | 13.75–15 | 22.5–25 |
| WebKit, `JSC_useBBQJIT=false`: WebAssembly interpreted | 13.75–15 | 0.78 |
| WebKit, `JSC_useDFGJIT=false`: JavaScript's baseline compiler only | 0.78 | 8.75–10 |
| Chromium, `--js-flags=--jitless` | no WebAssembly | 32–35.25 |
| Node, `--jitless` | no WebAssembly | 21.94–23.69 |

Interpreted, the loop is 16 to 19 times slower in WebAssembly. TeX lost more: in D32's campaigns
circuitikz's second render took 8,659 ms of TeX in WebKit without the JIT, and 321 ms with it. V8 without its JIT has no WebAssembly at all, so the engine does
not start there: the shipped worker in Node 22.19 with `--jitless` fails its start with
"WebAssembly is not defined", before the probe.

Then the shipped worker's own probe, at each of its starts, a fresh browser for each round and
every worker terminated once ready; idle is the desktop as it was, with other work on it, and loaded
is the same with 48 processes spinning on its 32 threads at normal priority:

| starts of the shipped worker | with the JIT: said on | without it: said off | what the probe took |
| --- | ---: | ---: | --- |
| Chromium 153, idle | 50 of 50 | | 0.5–0.8 ms |
| WebKit 26.6, idle | 50 of 50 | | 0–1 ms |
| WebKit, idle, left to Windows' power throttling | 30 of 30 | | 0–1 ms |
| WebKit, `JSC_useDFGJIT=false`, idle | 15 of 15 | | 0–1 ms |
| Chromium and WebKit without the platform's decoders, idle | 30 of 30 | | 0.5–0.7 and 0–1 ms |
| Node 22.19, idle | 10 of 10 | | 0.6–0.8 ms |
| WebKit, `JSC_useJIT=false`, idle | | 20 of 20 | 12–13 ms |
| WebKit, `JSC_useBBQJIT=false`, idle | | 12 of 12 | 12–13 ms |
| WebKit, `JSC_useJIT=false`, without the platform's decoders, idle | | 9 of 9 | 12–14 ms |
| Chromium 153, loaded | 100 of 100, one at its second attempt | | 0.8–6 ms |
| WebKit 26.6, loaded | 100 of 100, four at their second | | 1–242 ms |
| WebKit, loaded, left to power throttling | 30 of 30, one at its second | | 1–73 ms |
| Chromium without the platform's decoders, loaded | 10 of 10 | | 0.8–1.1 ms |
| WebKit, `JSC_useJIT=false`, loaded | | 12 of 12 | 12–16 ms |

The loaded figures are of a build whose worker is this one byte for byte (the same ENGINE_ID); the
hundreds of milliseconds there are the thread waiting for a processor, not the loop. With the JIT,
the fastest attempt read 0.4 to 0.6 ms in Chromium idle and 1.8 at most loaded, and 0 or 1 ms in
WebKit idle and 2 at most loaded: WebKit's clock moves a millisecond at a time in a page that is
not cross-origin isolated, as Obsidian's is not. Without the JIT, every attempt reached the
threshold.

**The threshold** is 5 ns a step, or 3.3 where WebKit's clock reads 3 for anything over 2 ms.
Compiled code would have to run the loop four times slower than this desktop does to come near it,
and an interpreter almost three times faster than JavaScriptCore's here to stay under it. Where it
is likeliest to be wrong is a slow Android phone, whose V8 runs the loop compiled but nobody has
measured how slowly; so the diagnostics say "on (probably)" and "off (probably)", and only iOS acts
on it (below).

**Amended by D38 (0.2.1-beta.5).** A slow attempt no longer says off by itself: a hot iPhone with its
JIT reached the threshold with every attempt, and so did WebKit held to one efficiency core on the
desktop. After a slow first attempt the worker pauses 4 ms and measures the loop, and weighs it
against the platform's inflate of the core dump in the same start; the verdict is on, off or unclear.
What follows here is the probe as it was until then.

How narrow the margin is, by arithmetic from the figures above, not by measurement: compiled, the
loop takes 0.77 to 0.83 ns a step on a core of about 5.5 to 5.8 GHz, some 4.2 to 4.8 cycles a step.
At that, compiled code reaches WebKit's 3.3 ns on a core below about 1.4 GHz, and V8's 5 ns below
about 0.9 GHz, and a phone's efficiency cores, Low Power Mode, a phone hot from launching the app,
or an A10 iPad on iPadOS 17, which has Lockdown Mode, could run that slowly. In WebKit, with its
clock a millisecond at a time, fast and slow are one tick apart: loaded attempts with the JIT read
up to 2, and slow is 3. So since the review of beta.3 the plugin says less of one reading (below).

**What it costs the start.** With the JIT, under a millisecond in Chromium and Node and 0 to 1 ms by
WebKit's clock, the start being 27 to 38 ms there; without, 12 to 16 ms, four attempts of about 3 ms,
where the start without the JIT took 52 to 59 ms with the platform's gzip and base64 and 1,762 to
1,794 ms without them. `main.js` grows by 2,615 bytes, 692 of them the probe in the worker and the
rest what the view and the notice below say.

Loaded, it cost more, and not in its attempts. Measured again for the review of beta.3 on the same
desktop on 2026-10-14, with Playwright 1.63's WebKit 26.6 and the 0.2.x study's harness (each
worker started from a Blob of the build's worker and terminated once ready), the build before the
probe was compiled off the thread against the build after it, five rounds of ten starts each,
interleaved, with 48 processes spinning on the 32 threads: the probe took 1 to 68 ms, median 8, 28
of 50 starts over 5 ms, compiled on the worker's thread, and 0 to 36 ms, median 1, 2 of 50 over
5 ms, compiled beside tex.wasm. Every start said on, and the fastest attempt read 0 to 1 ms in both.
Idle, nothing changed: 0 to 1 ms in WebKit and 0.4 to 0.7 in Chromium, 30 and 20 starts of each
build, all on; without the JIT, 8 starts of each, all off, in 12 to 13 ms. The whole start, loaded,
is the thread waiting for a processor: 80 to 2,022 ms, median 244, before, and 76 to 2,578, median
305, after, too spread to tell the two apart.

**What it says.** The diagnostics view has a JIT line, "on (probably)", "off (probably)", "not
measured yet" or "no WebAssembly", from the latest engine to start that timed it, and each engine's
line says what its probe found and took; Copy carries both. On iOS and iPadOS, when it is off, the
view says that TeX seems to run without the JIT compiler there, about twenty times slower, that if
Lockdown Mode is on it is the likely cause, and where to exclude Obsidian from it (Settings →
Privacy & Security → Lockdown Mode → Configure Web Browsing), with a link to the README's answer.
When two engine starts of a session have found the JIT off there, and none on, a notice says the
same once, and stays until it is tapped; `"jitNoticeShown": true` in `data.json` remembers it, and
false shows it again. One start is one moment of the phone's, which a hot or busy phone, or Low
Power Mode, can make slow; the engine starts again after every 30 s idle and every return from the
background, which is another. Until the review of beta.3 the first start without it showed the
notice, and both said as fact that TeX ran without the JIT and that Lockdown Mode was the usual
cause, though iOS before 16 has no Lockdown Mode. Naming Lockdown Mode only where a feature check
says iOS 16 was left out: the wording is conditional, and a check of a feature Lockdown Mode itself
turns off would mislead. `data.json` is synced with the plugin, so a notice one device showed is not
shown on another, whose view still says it, and a `data.json` Sync brings back from before can show
it again. Not on Android: nothing a user knows of turns the JIT off there, and a slow phone is where
the probe is likeliest to be wrong. Not on a computer, where Obsidian runs V8, which without its JIT
has no WebAssembly and would not start the engine.

**No WebAssembly at all.** On some versions of iOS, Lockdown Mode takes WebAssembly away rather than
only its JIT: WebKit's bug 273824, "REGRESSION (iOS 17.4): WebAssembly blocked in lockdown mode,
even if exception is added", reports that since iOS 17.4 WebAssembly does not work in app WebViews
or Safari in Lockdown Mode, even with an exception, which restored it on iOS 17.3 (status NEW, last
changed 2025-03-14, read 2026-10-14). The maintainer's iPhone, which ran it interpreted, shows that
not every version does. The engine's start then fails at its first use of WebAssembly, as in
Node with `--jitless` above, before the probe, and the card said that the engine could not start,
"on mobile this is usually memory pressure, so close other apps first", and the view "not measured
yet". Since the review the host starts no worker where `WebAssembly` is not there, and the job fails
with "This device runs no WebAssembly."; that, or a worker's "Can't find variable: WebAssembly" or
"WebAssembly is not defined", puts on the card that the device runs no WebAssembly, that Lockdown
Mode turns it off on some versions of iOS, how to exclude Obsidian, and that on some versions this
does not bring it back (`src/engine/hints.ts`). The view's JIT line says "no WebAssembly", with the
same hint on iOS, and the copied WebView line whether there is WebAssembly. Nothing here has run on
such a phone.

**Not measured, and open.** No phone has run the probe. An iPhone with Lockdown Mode on has to say
off, at two starts, and with Obsidian excluded on, and the oldest iPhone and Android device at hand
have to say on, in Low Power Mode and at a cold launch too; `TODO.md` §9 has it, and the iOS version
it was all read on. The desktop also suggests why the start took 1.3 s with Lockdown Mode: 0.2.0
inflated the dump with pako, in JavaScript, which the interpreter runs, and here the start without
the JIT took 1.8 s with pako and 0.05 s with the platform's gzip, which iOS has from 16.4. Whether
0.2.1 starts faster under Lockdown Mode is for the phone to say.

Tests: `test/jit.test.ts` (the module is WebAssembly 1.0 and takes the generator's steps; on at the
first attempt with a JIT's speed, off only when every attempt is slow, each stopped at the
threshold; on after one or two interrupted attempts; just over and just under the threshold; on in
Node), `test/worker-boot.test.ts` (the shipped worker's `ready` carries it), `test/worker-host.test.ts`
(the plugin hears of each start), `test/report.test.ts`, `test/debug-view.test.ts` and
`test/notices.test.ts` (what is said, and only on iOS), and `test/readme.test.ts` (the README has the
answer the link points to).

---

## D34 — main.js says which version it was built as, and a device Sync left an old one on says so

**Date of record: 2026-10-14.**

The maintainer's devices showed it on 2026-10-14: Obsidian Sync Standard caps a file at 5 MB, and
with "Installed community plugins" on it copied a new `manifest.json` to another device and left the
old `main.js`, about 12 MB, in place. Obsidian and BRAT read the version from `manifest.json`, so that
device showed the new version, offered no update, and ran the old code. Nothing said so. The README
says what to do; this makes the plugin say it.

- **The build bakes the version in.** `scripts/plugin-version.mjs` reads `manifest.json`'s version,
  and the build hands it to esbuild as the `define` for `__TIKZJAX_NEXT_VERSION__`, which
  `src/platform/version.ts` reads; the minified `main.js` holds it as a string literal. Nothing but
  `manifest.json` goes into it, so a commit still builds to the same bytes.
- **The plugin compares it at load** with `this.manifest.version`, which Obsidian reads from the
  `manifest.json` beside it, right after its settings are loaded. When they differ, a notice says
  which version each is, what can have left them so, and how to put it right: reinstall the plugin
  on that device, with BRAT's "Choose a single plugin to reinstall" or by uninstalling it and
  installing it again from the community store. It links to the README's answer and stays until it
  is tapped. Either way round warns, and what it says left them so depends on which is newer, by
  semantic versioning's order (`compareVersions`): a newer `manifest.json` is what Obsidian Sync
  Standard can leave, with how to turn that off, and an older one something brought back, a sync
  service or a backup. Until the review of beta.3 it said of both that "Obsidian Sync Standard
  leaves the plugin like this", which reads as the diagnosis to someone who syncs with iCloud or not
  at all, and no copy of a new `manifest.json` explains an older one.
- **Once for each pair.** `data.json` keeps the pair it was shown for, `"outOfStepNoticeShown":
  "0.2.1-beta.3 → 0.2.1"` (`main.js`'s version first), so it is not shown at every start, and is
  shown again when the pair changes. Not in the app's `localStorage`, which would be this device's
  alone: `App#saveLocalStorage` came in Obsidian 1.8.7, above the floor of 1.7.2 (D6), and the
  store's rules flag `localStorage` itself. `data.json` is synced with the plugin, so a second device
  out of step in the same way is not told again; its diagnostics view still says so.
- **The diagnostics view** has the plugin's version by `manifest.json` and the version `main.js` was
  built as, and when they differ, what the notice says. Copy carries both, as `Plugin: 0.2.1, main.js
  0.2.1-beta.3, out of step: reinstall the plugin on this device`.
- **A normal build never warns**: `test/version.test.ts` builds `src/platform/version.ts` with the
  build's own `define` and holds what it gives to `manifest.json`'s version, and the release workflow
  already refuses a tag that is not the manifest's version, from whose commit `main.js` is built.

**What it cannot do.** Only a `main.js` that has this can tell, so a device whose `main.js` is
0.2.1-beta.2 or older says nothing, however far behind it is: the first update it can tell about is
the one after 0.2.1-beta.3, or after 0.2.1 for someone on the store. Nor can the plugin put it right
itself: that would mean fetching its own release, and the plugin makes no network request
(CONTRIBUTING.md).

`main.js` grows by 1,652 bytes.

Tests: `test/version.test.ts`, `test/notices.test.ts` (once per pair; never for the same version or
an unknown one), `test/report.test.ts`, `test/debug-view.test.ts`, `test/settings.test.ts` and
`test/readme.test.ts`.

---

## D35 — A font's metrics stay as bundled, and a preamble's last comment ends at its line

**Found by the review of 0.2.1-beta.3's saved preambles, outside what they change. Amends D32, whose
"its files … fixed for a worker's life" did not hold until this. Date of record: 2026-10-14.**

**A .tfm opened to write starts empty.** `library.ts` `openSync` took its branch for font metrics for
any name ending in `.tfm`, also one TeX opened to write. For a font of the bundle, `cmex7`,
`eufm5`/`7`/`10`, `rsfs5`/`7`/`10` or `tcrm0500`/`0700`/`1000`, that handed TeX the very array the
worker keeps inflated for its life, and `\immediate\openout\w=eufm10.tfm` wrote into it. Every later
diagram in the worker read the font from what was written: "Bad metric (TFM) file", and with saved
preambles on, a diagram resumed from a run that loaded the font before drew what the same diagram
from the start no longer drew. `tcrm1000` is the TS1 font behind the stand-ins for `°` and `×`. The
branch is now taken only to read (change 13); a `.tfm` opened to write starts empty, as any other
name does. One the engine has no metrics for was refused, and TeX stopped with "I can't write on
file `nosuch.tfm'." and drew nothing; it opens now. `verify:snapshot` has a hazard of it,
`font-metrics-written`, and `verify:reset` an input that writes a file under the name of every
bundled font's metrics: on the host as it was, the hazard failed in the engine and in the worker,
and `verify:reset` in four of its five orders, where `every-font` no longer loaded all 121 metrics
and `mathfrak` and `mathscr` replied differently.

**A preamble whose last line is a comment ends with a newline.** The worker writes its own
`\begin{document}`, and a block's `\standaloneconfig` of `border=`, on the end of the preamble's
last line (`engine-src/document.ts`, `src/block/processor.ts`). A preamble file saved without a
newline at its end, as VS Code saves one, whose last line is a comment had both taken for the rest
of the comment: through the worker in Node 22.19, `\usepackage{amsmath}` and `% end of preamble` as
the preamble drew 375 bytes with "LaTeX Error: Missing \begin{document}.", and with a newline after
the comment the diagram's 402. Nor did such a block save its preamble, as the host named no run for
it. `src/preamble/resolve.ts` now ends the resolved preamble with a newline when its last line holds
a comment as TeX's default catcodes read one, a `%` with an even run of backslashes before it
(`engine-src/comment.ts`), and the line it adds is the file's next, as a file that ended in a newline
gives.

**Why neither moves `OUTPUT_REVISION`.** The fixtures draw as before. The resolved preamble is part of
the cache key, so the second fix gives exactly the blocks under such a preamble a new key, and each
compiles again, which the broken drawing each has cached needs (D20: a diagram TeX drew after an
error is cached); a block with its own `\begin{document}` under such a preamble, which drew
correctly, compiles again too, a line lower. The first changes what a diagram draws only after it,
or a diagram before it in the same worker, wrote a file under the name of a bundled font's metrics,
which a diagram does not do but to break one; moving the revision would compile every cached diagram
of every user again for it.

Tests: `test/library.test.ts`, `test/preamble.test.ts`, `test/processor.test.ts`, and the two
checks above.

---

## D36 — Saved preambles are kept in the device's own storage, and outlive the engine

**Amends D32, whose runs went with the engine that saved them ("Not done, and open"), and DESIGN.md
§4.7, §5.4 and §6.2. The 0.2.x plan's 0.2.4, built into 0.2.1-beta.4. Date of record: 2026-10-14;
the changes its review asked for, and the figures below, 2026-10-15.**

A saved run lived in the engine that saved it (D32), and went with it: at Restart the TeX engine, at
the idle stop, and on a phone whenever Obsidian went to the background. On a phone, where the engine
stops after 15 s without a diagram (D37) and at every trip to the background, the first diagram of a
preamble after each of those compiled the preamble again, and the first diagram after Obsidian
starts always did. The review of the 0.2.x plan (S3) proposed keeping the runs in IndexedDB, keyed
by ENGINE_ID, and measured reading back runs of 0.6, 2.6 and 8.9 MiB in 3 to 21 ms on the desktop
(R6).

**What the worker hands over** (`engine-src/stored-run.ts`). The run as the engine holds it, written
out as bytes: TeX's globals where they differ from the core dump, the host's table of files and its
terminal, what TeX had said and failed to find by then, the text the run stands for, whether the log
was kept, and the ENGINE_ID of the worker that saved it. A fixed head, a header of JSON and the
blobs it points at, each on 8 bytes, and, in a run kept uncompressed, a checksum of all but the head
(below). The files of the worker's own that TeX read, a bundled TeX file, which openSync hands TeX
as the very array it keeps inflated, or dvi2html's metrics for a font, are named and not copied, and
put back from the reading worker's own, which are the same bytes in every worker of one ENGINE_ID.
Most of what a preamble reads TeX has closed by its `\begin{document}`, and TeX never reads a closed
file again, as a file opened again is an entry of its own: the host now notes a close (`library.ts`
change 14), and a run read back finds the bytes of a closed file of the worker's own only if
something asks for them. Read whole, they cost a fresh worker the inflating of every file the
preamble had read: in Chromium on the desktop, siunitx's run took 16 ms to put back that way and 8
ms with the closed files left alone (two probes on 2026-10-14). Leaving their bytes out altogether,
which was tried first, is not the same state: `verify:snapshot` read `eufm10.tfm` back as the body's
file where a run from the start reads the font, in the `font-metrics-written` hazard. A file TeX
wrote is always copied.

**When.** Writing a run out and gzipping it is the worker's own time, on its own thread, which
`CompressionStream` is too: for circuitikz's run of 8.9 MiB, 77 to 81 ms of the worker's time in
WebKit and 225 to 230 in Chromium, in the campaign below. Spent right after the reply, it held the
next diagram up by as much. So the worker hands a run over only once no render has been under way
for 100 ms, which is when the host has nothing more for it (the queue posts the next job as the
reply comes in), and gzips it 256 KiB at a time, each slice in a task of its own once the worker is
idle again: a render posted meanwhile starts first, and waits at most for the slice under way, or
for the writing out, which is one step before the slices, and took 0 to 3 ms for every run of the
campaign below, circuitikz's included, in WebKit with the JIT and without it and in Chromium
(`SavedRunMessage.writeMs`). Until the review of this release the writing out also took a checksum
of the whole run, which only a run kept uncompressed needs, and without a JIT that was most of the
step: writing out and gzipping circuitikz's run took 110 to 123 ms of the worker's time in WebKit
with the JIT and 232 to 256 without it, gzip being native in both (the campaign of 2026-10-14). The
next diagram of a preamble, handed over at once after the first, took what beta.3's did (below).

**Amended by D38 (0.2.1-beta.5).** On a phone this left a note's heaviest preambles out of storage:
in a note the worker is idle only at its end, the runs it let go meanwhile were capped and dropped,
and the engine was stopped in the background with what was still waiting. A run is now written out
between diagrams from the reply on and gzipped on a thread of its own, and an engine about to stop
finishes handing its runs over first, for 2 s at most at the idle stop and 1 s in the background.
And when the store is full, a run whose preamble took longer is kept longer.

The runs waiting cost memory once the worker no longer keeps them itself: in a note of many
preambles the worker is idle only at its end, and a run it has let go is held by the queue alone. So
the runs waiting that it no longer keeps hold at most its budget of saved runs between them, the
oldest of them let go first, the newest always kept; one it still keeps waits at no cost. Until the
review they held that budget between them all, kept or not. In WebKit on 2026-10-15, the 37 fixtures
drawn once each, two rounds of each build: at a computer's budgets 20 runs were handed over, 16.01
MiB, where the build before the change handed over 13, 9.64 MiB; at a phone's, 7 runs, 4.34 MiB,
plain TikZ's among them, against 6, 4.09 MiB, without it. D37's trial, with a build before both,
ended with 9 runs stored and plain TikZ's not among them, which is why its next diagram after the
stop compiled its preamble. A phone's 12 MiB of runs waiting still leaves its 16 MiB store far from
full after a busy first session: filling it would take holding more in memory.

**Gzipped where the platform has its own gzip** (iOS and Safari 16.4, Chrome 80), and as they are
where it has none, iOS 14.5 to 16.3: the host counts its budget in bytes stored, so there fewer runs
fit, and the run's own checksum, taken there a slice at a time as the gzip is elsewhere, guards
bytes no CRC covers. Not skipped there, as the alternative was: storing costs those devices nothing
but room, and reading back the stretches is a copy. Not pako's deflate either, which is JavaScript,
at an interpreter's pace where there is no JIT (D33), and more code for the worker to carry. Gzip's
CRC-32 is checked by the inflate, which both browsers were seen to do on 2026-10-14 (a changed byte
in the middle, in the CRC and in the length, and a cut stream, all refused by `DecompressionStream`
in WebKit 26.6 and Chromium 153), so the checksum is taken and checked on uncompressed runs only.
Sizes over the fixtures, gzipped/written out, in MiB: TikZ alone 0.24/0.64, `tikz-cd` 0.40/1.26,
`siunitx` 0.78/2.72, `feynhand` 0.81/2.72, `pgfplots-axis` 2.03/6.50 and `circuitikz` 2.83/8.88 in
WebKit, and within 0.03 MiB of those in Chromium.

**What the host keeps** (`src/cache/runs.ts`). In the app's IndexedDB, in a database of its own
beside the diagram cache's, `tikzjax-next-<appId>-preambles`, so that neither's schema or failures
reach the other, and never in the vault or the plugin's folder, which Obsidian Sync and a vault in
iCloud Drive copy to every device: a run is megabytes of one build's memory. One database per vault,
as the diagram cache has, since every vault of a desktop install shares one origin: the budget below
is a vault's, and a vault not opened again keeps what it stored until it is opened and cleared. Two
stores: `runs` with the bytes, read only to send one, and `index`, a small record per run, read
whole once a session when the engine first starts (D23's early start), so that whether a run is
stored is known without touching its bytes; a put, a delete and an eviction write both in one
transaction. The key is `<ENGINE_ID>/<route>`, the run's name the host routes by
(`engine-src/document.ts` routeKey, a hash of the text it stands for and of the log flag): at that
first read every record of another ENGINE_ID is deleted, unread, and the worker checks the ENGINE_ID
inside the bytes and the text again. Nothing waits for that delete. Until the review the index was
set only once it had committed, so the first diagram after an update that changed the engine waited
for every byte of the old engine's runs to be deleted, when nothing of the new engine's could be
stored yet. With 13 runs of another build stored, 9.6 MiB, the first diagram after a fresh start of
the browser took 487 (476–488) ms in WebKit with the delete waited for and 130 (124–131) without,
and in Chromium, where the delete was done before the engine was up, 91 (90–93) and 92 (91–95)
(three rounds each on 2026-10-15, the same worker under the host before and after the change). The
budget is in bytes stored: 64 MiB on a computer, 16 MiB on a phone or a tablet and on a computer
that reports less than 8 GiB of memory (`platform/budgets.ts` storedRunBytes), least recently used
out; a run larger than the whole budget is not kept and evicts nothing. Keeps run one after another,
so that two at once, from two engines, cannot both fit the budget and together pass it.

**Sending one.** A job whose run is stored is not posted, while the run's bytes are read, to an
engine that does not hold the run: the read starts when the job reaches the host, so when the engine
is starting it runs meanwhile, and the job is then sent with the bytes, transferred. Meanwhile it
goes at once to an idle engine that turns out to hold its run, and the jobs behind it go first, as
an engine left idle while a job could run costs more than the read. It waits for the read at most
250 ms once an engine is idle for it, and then goes without the run, as with nothing stored; with
the engine up a read took 9 to 13 ms in WebKit and 1 to 3 in Chromium on the desktop (2026-10-14).
While a read a job stopped waiting for has not settled, no other is begun: storage is not answering.
Until the review a job whose run was being read held every job behind it, also one for another
engine, and the read had no limit, so a read that never settled held them all until the first one's
startup allowance ran out, 20 s on a computer and 30 on a phone, and failed it as an engine that
would not start. The run is read unless an engine that holds it will take the job, one that is idle,
or the only engine there can be. With two engines, the computer's default (D24), a job never waits
for a busy engine, and until the review one whose run only a busy engine held went to the other
without it, which compiled the preamble, saved it and stored it again. A job is asked to hand its
run over only when none is stored under its name or one was sent with it, so that the worker does
not write out and gzip again a run the store has.

The worker inflates and checks the bytes, reads the run back, keeps it as if it had saved it where
its budget has room, so that the diagrams after it resume from memory, and resumes from it either
way. A run the worker cannot keep beside the ones it is using, as circuitikz's 8.9 MiB could not at
a phone's 12 (D32), is started from all the same, at every diagram of its preamble that finds it
stored, where until now each compiled the preamble. Bytes that do not read back, refused by the
inflate or by the format, are reported, and the host deletes them and counts a storage error; a run
that could not be put back for want of memory, a RangeError, as inflating 8.9 MiB can on a phone
short of it, is kept for the next session and not sent again in this one, where until the review it
was deleted as if its bytes were wrong. A run that stands for other text under the same name, which
a hash or a `\begin{document}` the host guessed wrong can give, is not used, and the diagram saves
its own, which replaces it.

**Amended by D39.** A run its worker had no room to keep reaches storage too: where the host asks for
the run, the worker saves it for that alone, once a name in its life, and hands it over like any
other. Until then one it saved and did not keep was handed over, and one it had no room to save at
all was not. And the diagnostics say each way a run fails to get from a diagram to the store and back:
why a stored run was not sent with a diagram, what each engine handed over and what of that was
dropped or failed, and what the store kept and refused, and why.

**Only when it is cheaper.** A run is sent, and kept at all, only when putting it back is likely to
cost less than its preamble and its save did in the engine that saved it, which the worker measures
and hands over with it. Putting back is estimated as a time to read anything from IndexedDB, 12 ms,
1 ms a MiB stored and 2.5 ms a MiB of the run, the slower of WebKit and Chromium on the desktop
(below). For sending, the estimate then leans on what it took on the device, a quarter at a time,
leaving out a read made while the engine was starting; a read is timed on the main thread, behind
other transactions and whatever the thread was doing, so a sample counts for at most four times the
larger of the estimate and the starting figure, and one slow read moves the estimate by 1.75 times
at most, and each run not sent for its cost moves it a quarter of the way back, so that one is sent,
and measured, again after a few. Until the review a sample counted as it came: one read of 300 ms of
`tikz-cd`'s 0.40 MiB, a case the review built in a test, raised the read cost from 1 ms a MiB to
181, after which circuitikz's run was estimated at 546 ms and sent no more that session, nor kept.
Whether a run is kept goes by the starting figures alone: it is for later sessions, which start from
them. Over the fixtures on the desktop every run was worth it, the smallest, TikZ alone, whose
preamble took 20 to 21 ms to reach in WebKit and its save 8 to 10 more, where putting it back took 3
ms and reading it ran while the engine started.

**Storage that will not.** IndexedDB missing or refusing to open (a private window, blocked site
data, a WebView that keeps none) turns this off for the session. A write refused for want of room is
tried once more after as much again as the run has been freed from the least recently used runs, in
a transaction of its own, as the diagram cache makes room (`cache/idb.ts`); refused again, nothing
more is written that session, and what is stored is still read and sent. Until the review the first
refusal stopped the reading too, so that a phone nearly out of room, where the browser refuses most
often and a stored run helps most, used none for the rest of the session. Clearing tries again.
Another failure costs that one run. Each run lost, and each whose bytes did not read back, counts as
a storage error, which the diagnostics view shows. A diagram is drawn either way.

**The switch.** Settings → Saved preambles covers stored runs too: off, the host sends no budget, so
nothing is saved, handed over, read or sent, and what was stored is deleted, at the change, also one
that comes through Sync, and at the next start if it was turned off elsewhere (without creating the
database where there is none); the diagnostics view then says "Stored preambles: off". Clearing the
diagram cache clears them. A worker hands its runs over up to its budget after a note, so a run
saved before a clear could reach the store after it and be kept, which until the review it was: each
render now carries where the store stood when it was posted, an epoch every clear moves, the worker
hands it back with the run, and the store keeps no run saved under an earlier one.

**The proof.** `npm run verify:snapshot` gains a third way to resume. In the engine, each saved run
of every fixture and hazard is written out, gzipped, gunzipped, read back and resumed from, and must
give what the run from the start gives, byte for byte. In the shipped worker, the bytes it hands
over for each run it saves are sent back with the same diagram to a second worker that holds none,
as after a stop, which must resume from them, then the other body, which must resume from the run it
kept, then the other body again, sent the stored run, which must resume from it where the two share
their preamble and refuse it where not; every reply as from the start. A worker without
`CompressionStream` hands the same run over uncompressed, its checksum taken a slice at a time,
which must be byte for byte the gzipped run's bytes sealed whole, and is resumed from; one with a
byte changed, gzipped or not, or cut short, is refused and the diagram drawn as from the start. A
stored run larger than the worker's budget is started from all the same, and not kept. On
2026-10-15, on the build that ships: 77 cases, 1,166 runs in the engine, 858 of them resumed and 286
of those through storage, and in the worker 292 renders that saved and 428 that resumed, 282 of them
from a run sent back from storage, every one as from the start, in 217 s. `verify:worker` asks for
the runs as the plugin does, and with `--legacy` hides `CompressionStream` too, and the runs come
back uncompressed. Unit tests hold the format and the checksum in slices
(`test/stored-run.test.ts`), the store (`test/runs.test.ts`: another engine's runs never read and
deleted without being waited for, bytes that do not read back deleted and counted, a write refused
for room, once and twice, reading on after it, storage that will not open, the budget, keeps at
once, clearing and its epoch, the estimates' bounds), the host's sending and keeping
(`test/worker-host.test.ts`: the wait limit, the jobs that go first, a busy holder, the runs not
asked for again, a run that could not be put back), the closed files (`test/library.test.ts`), the
runs a worker still holds (`test/snapshot.test.ts`) and the switch's text.

**What it gains.** Measured on the desktop of D27 on 2026-10-15, with Playwright 1.63's headless
WebKit 26.6 and Chromium 153 and the 0.2.x study's harness, extended so that each build runs its own
WorkerHost, and RunStore, driving the worker its `main.js` ships, on a persistent profile: this
release's build against 0.2.1-beta.3's `main.js` as published. Each fixture in two sessions, each a
fresh browser on one profile, the first on an empty profile and the second on what the first left;
the engine started and the diagram handed to the host at the same moment, as at a cache miss (D23),
and timed from there to its reply. Three rounds, the builds interleaved, saved preambles at a
computer's 32 MiB and 64 MiB stored; every SVG as smoke draws it. These figures replace those of the
campaign of 2026-10-14, made before the review's changes on a desktop busier with other work; only
figures of one campaign are compared. The first diagram after a fresh start of the browser, in ms,
median (range):

| | WebKit, beta.3 | WebKit, stored | Chromium, beta.3 | Chromium, stored |
|---|---:|---:|---:|---:|
| `basic` | 104 (104–111) | 97 (90–97) | 92 (91–92) | 72 (72–77) |
| `siunitx` | 225 (225–231) | 103 (99–104) | 187 (185–188) | 88 (85–89) |
| `tikz-cd` | 210 (209–220) | 151 (150–153) | 164 (163–165) | 112 (111–127) |
| `circuitikz` | 434 (428–494) | 223 (219–296) | 336 (332–338) | 170 (170–174) |
| `pgfplots-axis` | 425 (424–430) | 246 (242–252) | 328 (327–331) | 182 (180–185) |
| `feynhand` | 495 (492–497) | 393 (381–416) | 383 (379–389) | 277 (276–280) |

Reading the run took 21 to 34 ms in WebKit and 4 to 10 in Chromium, while the engine started, which
took 60 to 137 and 52 to 68, so it added nothing; putting it back took 3 to 14 ms in WebKit and 2 to
15 in Chromium, for runs of 0.64 to 8.88 MiB, gzipped to 0.24 to 2.83. The second diagram, handed
over at once after the first in the first session, took what beta.3's did: `circuitikz` 112
(109–116) against 111 (109–112) ms in WebKit, 69 (68–69) against 69 (68–73) in Chromium, while
writing the run out and gzipping it took 8 to 81 ms of the worker's idle time in WebKit and 15 to
230 in Chromium.

Without the JIT, WebKit with `JSC_useJIT=false`, as Lockdown Mode runs it, at a phone's 12 MiB and
16 stored, two rounds: the first diagram after a fresh start took 233 (229–237) ms for `basic`
against beta.3's 600 (596–604), 464 (456–471) for `siunitx` against 3,426 (3,424–3,428), and 2,750
(2,671–2,828) for `circuitikz` against 8,202 (8,118–8,286). Reading the run took 25 to 34 ms and
putting it back 3 to 19, much as with the JIT, as the platform's inflate and a copy do that work,
against 260 to 5,437 ms for TeX to reach the point the run stands for; writing it out and gzipping
it took 7 to 82 ms after the reply, where it took 21 to 256 before the review, most of that the
checksum, and of it the writing out, the one step not sliced, 1 to 3.

A note of 74 diagrams, the 37 of 0.2.0's corpus twice each, in the same two sessions, a job at a
time as the queue hands them over, or two with two engines, from the first job to the last reply,
median (range) of three rounds, in ms:

| | beta.3, 2nd session | stored, 1st session | stored, 2nd session |
|---|---:|---:|---:|
| WebKit, each twice in a row, 32 MiB, one engine | 4,541 (4,478–4,593) | 4,406 (4,401–4,570) | 3,460 (3,453–3,562) (−24%) |
| Chromium, the same | 2,926 (2,893–3,006) | 2,894 (2,890–2,917) | 1,892 (1,889–1,912) (−35%) |
| Chromium, the same with two engines, as the desktop app runs | 2,072 (2,061–2,077) | 2,092 (2,059–2,100) | 1,079 (1,069–1,089) (−48%) |
| WebKit, each twice in a row, a phone's 12 MiB and 16 stored | 5,012 (4,996–5,159) | 4,963 (4,962–5,087) | 4,512 (4,506–4,577) (−10%) |
| WebKit, every one and then every one again, 12 and 16 MiB | 5,866 (5,860–5,982) | 5,896 (5,865–5,962) | 5,249 (5,224–5,276) (−11%) |

beta.3's first sessions took 4,440, 2,884, 2,072, 4,999 and 5,865 ms. In the first session nothing
is stored before the note is over: the worker hands runs over only when it is idle, and in a note it
is idle only at the end, when the runs waiting go, 20 runs, 16 MiB, a note at 32 MiB, and 7, 4.3
MiB, at 12 (above). So the first session takes what beta.3 takes. In the second, 18 diagrams a note
started from a stored run at 32 MiB with one engine, 35 with two, and 8 and 13 at the phone's
budgets, the first among them: `arrows-meta`, 47 (45–54) ms against 80 (74–84) in WebKit and 27
(27–28) against 66 (63–67) in Chromium, with one engine. With two engines, until the review, a job
whose run only the busy engine held went to the other without it (Sending one, above).

The worker by itself, sent no stored runs and asked for none, against beta.3's, through the 0.2.x
study's bench, which drives a worker without the host (three rounds each, saved preambles at 32
MiB): TeX's time over the fixtures, each drawn twice, 5,268 and 3,739 ms against 5,250 and 3,758 in
WebKit, 3,572 and 2,545 against 3,599 and 2,546 in Chromium, and the note of 74 drawn in 4,332 and
2,924 ms against 4,398 and 2,954, its peak memory as beta.3's; within this desktop's noise, as they
should be.

**What it costs.** `main.js` is 12,220,718 bytes, 18,385 more than beta.3's: the worker's code by
7,640 characters, and the host the rest. The campaigns above ran a `main.js` 12 bytes shorter, before
a guard the store's lint asked for in the host's queue, which changes nothing it does; the worker is
the same.

The store costs WebKit's engine start a few milliseconds on this desktop. The same build with and
without its RunStore, five rounds on an empty profile, started in 60 and 61 ms against 56 and 58, by
the host's clock, and drew the first diagram in 113 and 232 against 106 and 230 (medians, `basic`
and `siunitx`). The worker's own start, from its payload to its reply that it is ready, took the
same either way, 39 and 37 ms against 37 and 39 (`BootTimings.totalMs`), so the difference is
outside the worker: starting its thread, delivering the payload or the reply, or the main thread's
work meanwhile, which was not broken down further. WebKit on Windows delivers a worker's messages on
a timer: an empty message's round trip to a worker took 14 to 16 ms in 31 of 32 tries, against 0.2
ms at most in Chromium (a probe of 2026-10-14), so a little more work on the main thread can push a
delivery to the next tick; an iPhone's WebKit is another port. In the campaign above, on an empty
profile, the first diagram took 108, 232 and 218 ms in WebKit for `basic`, `siunitx` and `tikz-cd`
against beta.3's 107, 226 and 216; in Chromium, nothing beyond the noise. With a run stored, read
while the engine started, the start took 62 to 74 ms in WebKit (medians by fixture) against beta.3's
58 to 61, the worker's own start 37 ms against 38 (medians), and in Chromium 53 to 54 against 52 to
53.

Memory, which this campaign did not break down. The peaks, reached while the note compiled, in
working set: in WebKit at 32 MiB 494 (483–513) MiB in the first session and 502 (482–534) in the
second against beta.3's 487 (482–509) and 492 (479–506), at the phone's budgets 488 and 486 against
486 and 481; in Chromium 345 (326–347) and 300 (297–308) against 285 (285–288) and 290 (286–291)
with one engine, and 535 (518–576) and 469 (444–512) against 445 (437–453) and 440 (426–479) with
two. At the end of the note, once every run handed over had been stored, the working set was higher
than beta.3's, and 5 s later still, so it was held, not hand-overs under way: in WebKit at 32 MiB
455 (453–498) and 463 (385–516) MiB against 404 (370–442) and 435 (388–443), 5 s later 454 and 462
against 403 and 434; at the phone's budgets 463 and 402 against 370 and 364, 5 s later 430 and 399
against 369 and 363; in Chromium's first session 302 (299–324) against 252 (251–253), and in its
second, when nothing is handed over, 254 against 255. WebKit's private commit at the end was much
the same, 1,129 and 1,405 MiB against 1,229 and 1,382 at 32 MiB. A phone's engine stops after 15 s
idle (D37), which gives this back with the rest. Storage: up to 64 MiB a vault on a computer and 16
on a phone.

**Not measured on a phone.** The maintainer's iPhone 16 Pro, Obsidian 1.14.5, with Obsidian excluded
from Lockdown Mode, read a start of 48 ms and circuitikz's TeX at 237 ms with 0.2.1-beta.2 in the
diagnostics view; what reading a run back from its storage takes there, after a force-quit and with
the files no longer in the system's cache, is `TODO.md` §9's check, and so is the memory.

---

## D37 — A phone's idle engine stops after 15 s, and keeps its Memory until then

**Amends DESIGN.md §5.4's 30 s, and answers what D31 left unmeasured: what an idle engine holds.
Date of record: 2026-10-14; corrected after the review of 0.2.1-beta.4, 2026-10-15.**

Until 0.2.1-beta.4 a phone's engine stopped after 30 s without a diagram, and at once when Obsidian
went to the background. D31 recorded that WebKit, the engine of every iPhone, held more at the end
of a round of diagrams with one Memory per engine than without (working set 226 → 378 MiB against
0.2.1-beta.1), and that a kept Memory stays committed while its worker idles, which nothing had
measured. D36 changes what a stop costs: the next diagram pays a start and the putting back of its
stored preamble, no longer the whole preamble. The 0.2.x plan asked two questions of that: whether
the 30 s should change, and whether a worker should let go of its Memory after a shorter idle.

**How it was measured.** On the desktop of D27 on 2026-10-14, with Playwright 1.63's WebKit 26.6,
and Chromium 153 for Android's engine, through each build's own WorkerHost (the 0.2.x study's
harness, extended): a round of diagrams in a fresh browser, one engine, saved preambles at a phone's
12 MiB and 16 MiB stored, then the content process's working set and private commit sampled for 31 s
after the last reply, with one of three things done 2 s after it: nothing; the worker letting go of
the Memory its last run left, through a message added to this release's worker for the trial and
taken out again; or the engine stopped, as the idle stop does. Then one more diagram, timed. Medians
of the rounds, in MiB, the first sample before anything was done:

| WebKit 26.6 | nothing | Memory let go | engine stopped |
|---|---:|---:|---:|
| 37 fixtures, 3 rounds: working set, 1 s → 31 s after the last reply | 537 → 501 | 531 → 498 | 538 → 123 |
| the same, private commit at 31 s | 1,594 | 1,562 | 415 |
| 6 fixtures, 3 rounds: working set, 1 s → 31 s | 335 → 292 | 331 → 292 | 333 → 120 |
| the same, private commit at 31 s | 688 | 665 | 354 |
| 2 fixtures without the JIT, 2 rounds: working set, 1 s → 21 s | 208 → 188 | | 208 → 106 |

Stopped, the engine gave back most of it within 4 s: 159 to 165 MiB of working set at the sample 6 s
after the last reply in every round of 37 fixtures and of 6. In Chromium (37 fixtures, 2 rounds) a
Memory let go was given back only by a collection about 30 s after the round, which came in the
round that let nothing go too: private commit 327 and 339 MiB at 21 s, 122 and 120 at 31 s, against
279 and 277 with nothing done and 73 and 71 stopped, where stopping gave 100 back within 4 s.

What the stop cost the next diagram, on the same desktop: after 37 fixtures, `basic`, whose run had
never been stored, 108 to 123 ms against 10 to 13 kept, of which the engine's start 57 to 62 and TeX
from the start 27 to 32; after 6 fixtures, `siunitx`, stored, 143 to 155 ms against 21 to 32 kept,
of which the start 81 to 88, putting its preamble back 7, and TeX resumed 32 to 34 (these rounds
shared the desktop with verification runs of this release, which slowed the starts); and without the
JIT, `siunitx`, 577 to 613 ms against 434 to 437, the start 105 to 108 and putting back 9 to 11.

`basic`'s run was not let go by the store, as this record first said: the store held 9 runs, 8.45
MiB of its 16, at the end of every round that kept the engine, and never filled. The worker had let
it go from the runs waiting to be handed over, which it hands over only once idle, at the end of the
round, and which held at most its 12 MiB between them, the newest kept. Since the review of this
release only the runs the worker no longer keeps count against that (D36). With this release's
build, on 2026-10-15, three rounds of the same trial: plain TikZ's run was among the 7 stored, 4.3
MiB, and `basic` after the stop took 104 to 106 ms against 11 kept, of which the start 68 to 71,
putting its preamble back 2 to 3 and TeX resumed 13 to 14. Kept, the working set went from 443 to
510 MiB a second after the last reply to 406 to 481 at 31 s; stopped, to 146 to 153 at 6 s and 123
to 124 at 31 s. A phone's 12 MiB still leaves its store far from full after a busy first session.

**Decided.**

- **The Memory is not let go before the stop.** Neither engine gave anything back for it within the
  stop's time: WebKit not in 30 s, V8 only at a collection about 30 s on. A Memory let go is the
  collector's, and an idle worker allocates nothing that would call it; the next diagram would then
  take a new Memory, 156.25 MiB committed beside the one not yet collected.
- **A phone's idle stop is 15 s**, half what it was (`platform/budgets.ts` MOBILE.idleTeardownMs).
  What an idle engine holds is held until it stops, and stopping is what gives it back, most of it
  at once. A stop now costs the next diagram a start, 48 ms on the maintainer's iPhone 16 Pro (one
  reading of 0.2.1-beta.2 in the diagnostics view, Lockdown Mode excluded), and the putting back of
  its preamble, 7 to 11 ms on the desktop with the JIT or without, where until D36 it cost the
  preamble itself. Halved rather than cut further, conservatively: a diagram being typed in compiles
  at each pause, and every pause longer than the idle stop costs its compile a start; nobody has
  measured how long people pause. A computer keeps its 5 minutes.
- **What it does not change.** The peak, which is reached while the diagrams compile, and the stop
  when Obsidian goes to the background, which comes at once as before. (Since 0.2.1-beta.5 an idle
  engine first hands over the saved runs it has not yet, for 1 s at most, and 2 s at the idle stop:
  D38.)

`TODO.md` §9 has the phone's check: the page's memory before and after the 15 s stop, under the Web
Inspector, and the next diagram's start and putting back.

---

## D38 — What 0.2.1-beta.4 did on the maintainer's iPhone: a JIT probe a slow phone fooled, heavy preambles that never reached storage, and a shared compile shown as a block's own

**Amends D33 (the probe's verdict), D36 (when runs are handed over, and which go when the store is
full) and D37 (the stops), and D21's timings. Found by the maintainer testing 0.2.1-beta.4 on an
iPhone 16 Pro, iOS 27.0.1, Obsidian 1.14.5, with Obsidian excluded from Lockdown Mode. Date of
record: 2026-10-15; corrected the same day after the review of beta.5's first build (daa19f5), whose
findings and figures are given where they change what is said.**

The maintainer's readings, from the diagnostics view's Copy, are the only phone figures here; every
other figure is from the desktop of D27 (Windows 11, i9-13900K) on 2026-10-15, with Playwright 1.63's
WebKit 26.6 and Chromium 153 and Node 22.19, each named with how it was taken.

### The JIT probe

**What the phone said.** Twice. The first time the phone was slow all over, apparently throttled, in
the maintainer's words, by a low power state, heat or the battery; which of them was not known: the
view said "JIT: off (probably)", its probe took 13 ms in four attempts all slow, the
engine started in 194 ms (in the worker 117: decode 15, inflate 86 with the platform's gzip, compile
2), and TeX took 867 ms for circuitikz, 749 for pgfplots, 648 for pgfplotstable. The day before, with
0.2.1-beta.3, the same phone's probe had taken 1 ms, the inflate 26 ms, circuitikz 231 and pgfplots
211. The platform's inflate is native code that has nothing to do with the JIT, and it took 3.3
times as long: the processor was slow, and the JIT was on. Closed and opened again, it said on, the
probe took 1 to 2 ms and the inflate 39 to 47. D33's threshold was absolute, 3 ms for 600,000 steps of
its loop, and a phone slowed down enough reaches it with its JIT: the hint and the notice about
Lockdown Mode then tell someone with nothing to fix to go and fix it.

**Taken again on the desktop.** WebKit held to one efficiency core (the browser's processes given an
affinity of logical processor 16) does the same with its JIT on: 0.2.1-beta.4's own worker, started
as the host starts it, said off in 12 of 16 starts, and in 7 of 16 more. Through a worker of the
harness's own that starts as the engine does (`DecompressionStream` into one buffer, beside tex.wasm's
inflate and compile) and then runs beta.4's attempts, off in 6 of 16: each attempt finished one or
two calls of 75,000 steps before the clock read 3 to 5 ms, and measured right after, the same loop ran
at 0.67 to 0.92 ns a step in its fastest call of 8 ms or more. JavaScriptCore compiles a hot
WebAssembly function on threads of its own while the loop runs on uncompiled, and on one core those
threads and the worker's take turns.

**What it does now** (`engine-src/jit.ts`):

1. The first attempt is as before: done within PROBE_SLOW_MS, 3 ms, it settles the JIT on.
2. Otherwise the worker gives its thread up for PROBE_PAUSE_MS, 4 ms, and tries again, up to four
   attempts in all, each run on to PROBE_MEASURE_MS, 6 ms, so that it measures how slow the loop is;
   any attempt done within 3 ms settles it on.
3. Otherwise it is weighed (`verdict`): the loop's ns a step at the fastest attempt, from the calls
   each finished, against the platform's inflate of the core dump in the same start, in ns a byte
   inflated, which the worker now times by itself. Four times that or more is off; twice or less is
   on, unless the loop took 10 ns a step or more; anything else is unclear. Where the platform has
   no `DecompressionStream`, iOS before 16.4, pako inflated the dump, which is JavaScript and slows
   without a JIT as the loop does: then 20 ns a step or more is off, and anything slower than step 1
   allows but faster than that is unclear.
4. Where that did not find the JIT on, the worker takes the probe again JIT_RECHECK_MS, 1 s, after
   `ready`, once no render is under way, with the same function, and sends what it found
   (`JitMessage`): that second probe is what the start says. Added after the review of beta.5's
   first build; see "The phone's two readings" below.

The notice still needs two starts that said off and none that said on; an unclear start counts as
neither, and shows no hint. A start counts once it has settled: at `ready` where its first probe
found the JIT on, else when the second has come (`WorkerHostOptions.onJit`); one stopped before then
counts as neither, and the view says "checking again" while it waits and "unclear" if it stopped
first. `JitProbe` carries `state` (`on`, `off`, `unclear`) where it carried `on`, and, when it was
weighed, `nsPerStep` and `inflateNsPerByte`, which the engine's line in the view and in Copy shows,
for both probes: `JIT probe 30 ms (12.5 ns a step, inflate 1.51 ns a byte), again a second later
31 ms (…)`. Those figures are what a phone that says off with its JIT, or on without it, should be
reported with.

**The pause.** In the harness's worker, WebKit held to one efficiency core with its JIT, 24 starts
each: attempts run on to 6 ms without a pause were off by the rule above in 20; with a timer of 0 ms
between them, 14 off and 2 unclear; of 1 ms, 22 off; of 2 and 8 ms, all 24 on, and of 4 ms all 48 of
two such runs, every one at its second attempt, the probe taking 8 to 17 ms. 4 ms it is, paid only
after a slow first attempt.

**Calibration**, the harness's worker, 2 rounds of 8 fresh workers each, the loop's fastest call of
8 ms or more against the inflate of the same start, the ratio of their ns a step and ns a byte:

| | with the JIT | without it (`JSC_useJIT=false`) | WebAssembly interpreted (`JSC_useBBQJIT=false`) |
| --- | ---: | ---: | ---: |
| WebKit, idle | 0.45–0.72 | 7.72–8.69 | 10.30–12.76 |
| WebKit, one efficiency core | 0.45–0.62 | 13.05–20.59 | 9.14–24.21 |
| WebKit, one efficiency core, power throttling on | 0.47–0.62 | 7.26–25.97 | 15.44–24.21 |
| WebKit, 48 processes spinning on the 32 threads | 0.02–0.39 | 0.74–9.78 | 1.73–12.09 |
| WebKit, the same with power throttling on | 0.27–0.94 | 4.98–19.17 | 6.62–20.72 |
| Chromium, idle | 0.50–0.54 | | |
| Chromium, one efficiency core | 0.32–0.45 | | |
| Chromium, 48 processes spinning | 0.15–0.69 | | |
| Node, idle | 0.16–0.18 | | |

With every core busy at normal priority, the inflate shared its core with the spinning processes
more than the loop's short attempts did, and the ratio fell for both; without the JIT it fell to 0.74
in one start, which is why a loop at 10 ns a step or slower is never taken for compiled code, however
fast it is against the inflate: the fastest interpreter measured, JavaScriptCore's on this desktop's
fastest core, takes 12 to 13. A processor slowed down all over, as hot or in Low Power Mode, slows
both alike: the ratio is a figure of the code, not of the processor. "Power throttling on" is
Windows' EcoQoS, turned on for the browser's processes; it slowed neither by much on this desktop.

ON_MAX_NS, 10 ns a step, keeps about a fifth of margin below that interpreter, the only one
measured, and it has not been measured on Apple silicon: an Apple core that interprets the loop in
under 10 ns a step would let a start in Lockdown Mode whose inflate shared its core with other work
be called on, as the shipped worker's starts without the JIT and 48 processes spinning would have
been, an inflate of up to 27 ns a byte against a loop of 20 to 31 ns a step; and one start that says
on keeps the notice away for the session. TODO §9's Lockdown check asks for both probes' figures.

**The shipped worker** (`--mode shipped`: the worker a build's `main.js` carries, started as the host
starts it; a build whose probe and start are this release's, before the hand-over changes below), 2
rounds of 8 starts each:

| | starts | on | off | unclear | the probe took |
| --- | ---: | ---: | ---: | ---: | --- |
| WebKit with the JIT: idle, one efficiency core, with power throttling, with two processes spinning on that core, 48 on all, 48 with power throttling | 96 | 96 | | | 0–129 ms |
| WebKit with the JIT, without the platform's decoders | 16 | 16 | | | 0–1 ms |
| WebKit with the JIT, its clock run 3.3, 5 and 8 times fast | 48 | 48 | | | 0–80 ms |
| Chromium: idle, one efficiency core, 48 spinning | 48 | 48 | | | 0.5–14.8 ms |
| Chromium, its clock run 3.3, 5 and 8 times fast | 48 | 48 | | | 1.3–143 ms |
| Node, idle | 16 | 16 | | | 0.5–1.2 ms |
| WebKit without the JIT: idle, one efficiency core | 32 | | 32 | | 33–40 ms |
| WebKit without the JIT, its clock run 3.3, 5 and 8 times fast | 48 | | 48 | | 66–152 ms |
| WebKit without the JIT, 48 spinning | 16 | | 4 | 12 | 36–665 ms |
| WebKit with WebAssembly interpreted, idle | 16 | | 16 | | 33–35 ms |
| WebKit without the JIT and without the platform's decoders | 16 | | | 16 | 44–59 ms |

A clock run `k` times fast is the worker's `performance.now()` multiplied by `k`: every step the
start times, the inflate's and the loop's alike, reads `k` times as long, as on a processor `k` times
slower; Chromium's clock at ×8 made 14 of its 16 starts weigh the loop, at 5.33 to 7.11 ns a step
against an inflate of 12.16 to 13.81 ns a byte, 0.39 to 0.55, all on. WebKit's clock moves a
millisecond at a time, and at ×3.3 to ×8 a millisecond of it reads as several, so that most of its
starts with the JIT read 0 and settled at once. Without the JIT and the platform's decoders, as on iOS
14.5 to 16.3, the loop ran at 11.43 to 15.56 ns a step, under the 20 needed to say off with nothing
to weigh it against: unclear, by design.

**What it costs.** With the JIT, nothing: the first attempt settles it, 0 to 1 ms in WebKit idle and
0.5 to 0.7 in Chromium. Where the first attempt is slow and the second, after the pause, is not, 8 to
10 ms (WebKit on one efficiency core). Without the JIT, 33 to 40 ms where beta.4's probe took 12 to 16,
the start in WebKit 82 to 94 ms against D33's 52 to 59; the engine is twenty times slower there in
every diagram after it. `main.js` grows by 757 bytes for it.

**The phone's two readings**, as the rule takes them (`test/jit.test.ts`, a clock a millisecond at a
time): the second, a probe of 1 to 2 ms, settles at its first attempt, as before. The first: an
inflate of 86 ms, as beta.4 timed it with the dump's unpacking, over its 22.1 MiB is 3.71 ns a byte,
and four attempts all slow put the loop at 3.3 ns a step or slower. That fits two models alike, as
the review of beta.5's first build pointed out, and beta.4's probe read 12 to 14 ms in four slow
attempts under either. In one the loop was compiled and slowed down as much as the inflate was, about
3.3 times its usual 1 ns: 0.9 to 1.8 times the inflate between 3.3 and 6.6 ns a step, on. In the
other JavaScriptCore had not compiled it yet, its compile threads short of a core on a phone 3.3 times
slow, and it ran interpreted, 13.75 ns a step slowed to 45: 40 ns a step against 3.71 a byte, a ratio
of 10.8, off. Weighed against the inflate or not, one probe cannot tell a loop not compiled yet from
no JIT, and the maintainer's reading cannot say which it was. In the simulation the first probe calls
on a loop compiled up to 28 ms into it, unclear at 32 and off from 36, where beta.4's was off from 12.
So the start's probe is taken again a second later, step 4 above, and that one is what the start
says: in the simulation, on for a loop compiled at any time up to that second, and off for one not
compiled by then either.

**Taken again in WebKit.** JavaScriptCore's own option `JSC_thresholdForBBQOptimizeAfterWarmUp` holds
a hot WebAssembly function back from its compiler for longer: the not-compiled-yet model, with the
JIT on. The shipped worker of this release (`--mode shipped`, waiting for the second probe where there
is one), 2 rounds of 8 starts each, on 2026-10-15:

| | starts | probe at the start | what the start says | the second probe took |
| --- | ---: | --- | --- | --- |
| WebKit, held to 1,000,000 | 16 | on 16 (26–27 ms) | on 16 | |
| WebKit, held to 2,000,000 | 16 | off 16, 10–13.33 ns a step | on 16 | 9–38 ms |
| WebKit, held to 3,000,000 | 16 | off 16 | off 10, unclear 5, on 1; 5–8.33 ns a step | 40–55 ms |
| WebKit, held to 3,000,000, one efficiency core | 16 | off 16 | off 16 | 45–94 ms |
| WebKit, held to 6,000,000 | 16 | off 16 | off 16 | 48–57 ms |
| WebKit with the JIT: idle, one efficiency core, with power throttling and two processes spinning on that core, its clock run 3.3 and 8 times fast | 80 | on 80 | on 80 | |
| Chromium: idle, its clock run 8 times fast; Node, idle | 48 | on 48 | on 48 | |
| WebKit without the JIT: idle, its clock run 3.3 times fast | 32 | off 32 | off 32 | 43–172 ms |
| WebKit without the JIT, one efficiency core | 16 | off 15, unclear 1 | off 15, unclear 1 | 44–59 ms |
| WebKit with WebAssembly interpreted, idle | 16 | off 16 | off 16 | 45–56 ms |
| WebKit without the JIT and without the platform's decoders | 16 | unclear 16 | unclear 16 | 48–54 ms |

The option counts what the loop has run, not time: held to 2,000,000 steps, the second probe ran the
loop past it and found it compiled in every start; held further, it found it partly compiled or not at
all. So the second probe catches a loop compiled by the time it runs, and not one compiled later
still. A real phone's compile threads, which the option does not touch, are what the second is for:
held back by a busy processor rather than by a count, they have had a second. Every second probe came
1,010 to 1,106 ms after `ready`.

**What the second probe costs.** Nothing where the first found the JIT on, which is everywhere with
the JIT above but the held-back rows. Without the JIT, once a start, between two diagrams: 43 to 59 ms
in WebKit idle or on one efficiency core, 122 to 172 with its clock run 3.3 times fast; a render
posted meanwhile starts between its attempts. `main.js` grows by 716 bytes for it, with the view's
"checking again".

**Not measured on a phone.** Whether the iPhone, slowed down or in Low Power Mode, now says on, what
its engine line's figures are at both probes, and how often a start shows "checking again"; with
Lockdown Mode, that both probes say off at two starts and the notice shows. `TODO.md` §9 has them.

### A note's heaviest preambles never reached storage

**What the phone said.** Across both sessions the heavy diagrams of the maintainer's test note, a
circuitikz (`ad18c71e`), a pgfplots axis (`dd914518`) and a pgfplotstable (`f2198e3d`), said
"preamble saved in N ms" every time they compiled, never "resumed from a stored preamble", with
"Stored preambles: 4, 5.5 MB" in the second. D36 had measured why it could be so: at a phone's
budgets, after the 37 fixtures, only 7 runs, 4.34 MiB of the 16 the store may hold, were stored.

**Why**, taken again on the desktop with the persistence harness: each build's own WorkerHost and
RunStore driving the worker its `main.js` ships, in WebKit 26.6 on a persistent profile, at a phone's
budgets (12 MiB of runs in the worker, 16 MiB stored), one engine, the 15 s idle stop, and each
session ended as a phone ends it: Obsidian sent to the background a while after the last diagram
(the host's `kill('background')`, as `registerTeardown` calls it), or left to the idle stop. Three
things, all in beta.4:

- A worker handed a run over only once no render had been under way for 100 ms, which in a note is
  at its end. Until then the runs it had let go for room waited, held to its 12 MiB between them, the
  oldest dropped: of the 23 runs a first visit of the 44 fixtures saved, 10 were handed over and
  stored, 6.00 MiB, none of circuitikz's, pgfplotstable's or siunitx's.
- The engine was stopped at once when Obsidian went to the background, with whatever was still
  waiting: sent there as the last of the 44 was drawn, none of the 23 was stored; 200 ms after a
  single diagram, circuitikz's, pgfplots-axis's and pgfplotstable's runs were not.
- Writing a run out and gzipping it took the worker's own thread, 7 to 75 ms a run here, which is why
  it waited for a quiet worker in the first place (D36).

**What it does now.**

- **The worker writes a run out in its reply's own task** (`engine-src/worker.ts` handOverAll): the
  render ends, then its run is queued, and the first run waiting, the ones the worker has let go for
  room first, is written out at once and handed to the gzip helper, before the worker takes the next
  render from its queue: one step on its thread, 0 to 4 ms here for every run, circuitikz's 8.9 MiB
  included. A run after it waits only for no render to be under way. The first build of beta.5
  (daa19f5) meant to do this, and in WebKit did not, as its review traced: each run first waited for
  a task of its own, a message the worker sent itself, which WebKit delivered only after the next
  render, posted by the host the moment the reply reached it; and the run was queued before the render
  ended. Its tests, in Node, where that message is not late, said the runs went over while the next
  diagram was under way; `test/worker-handover.test.ts` now holds the worker's messages to itself
  back, as WebKit did, and that build fails it.
- **It gzips them on a thread of its own**: a worker it starts, from `engine-src/gzip-helper.ts`,
  which needs nothing but the platform's `CompressionStream`, while TeX goes on with the next diagram;
  73 to 97 ms for circuitikz's run here, writing out included. The helper starts with the first render
  the host asks to hand its run over, so that it is up when that run is written out; started at the
  first run, as the first build of beta.5 did, its message that it was up reached the worker in
  WebKit two diagrams later in the review's trace, the runs waiting meanwhile. One that has not said
  it is up after 2 s and one more task is stopped and its URL let go, where the first build kept it
  for the worker's life.
  Where it cannot start one, or it fails, the gzip is sliced on the worker's own thread as before,
  128 KiB a slice, each when no render is under way, so that a render posted meanwhile waits at most
  for one. A slice is a task of its own by a message the worker sends itself: timers nested that deep
  wait 4 ms each. Where there is no `CompressionStream`, iOS 14.5 to 16.3, the run's checksum is
  sliced so, as before. The helper goes with the worker, which the host stops with the engine.
- **An engine about to stop with runs still to hand over hands them over first**
  (`src/engine/worker-host.ts` drain): at the idle stop, for 2 s at most, and when Obsidian goes to
  the background on a phone, for 1 s at most, the host asks it (`FlushRequest`) and stops it when it
  says it is done (`FlushedMessage`); a job posted to it meanwhile keeps it, and so does a diagram
  that turns out not to be cached (`ready()`, which until the review took a draining engine for one
  that was up and started none). Each reply says how many runs the worker has still to hand over
  (`SnapshotState.pending`), and the worker says unasked when it has handed over the last; an engine
  whose last word was that none is waiting is stopped at once, as every engine was in beta.4, where
  the first build of beta.5 asked every idle engine and waited for its answer. Both limits are this
  page's timers, and a phone that suspends Obsidian's web content before either runs out, or before
  the worker answers, keeps the engine's memory for as long as it is suspended, which stopping it at
  once was for (#111, #91): stopping at once where nothing waits keeps that to the few hundred
  milliseconds after a diagram in which its run is handed over. Whether iOS does suspend it then is
  not known; TODO §9 has a check. An engine sent to the background while it hands its runs over at
  its idle stop takes the shorter limit, where the first build kept the longer. An engine still
  starting, or one with a job, is stopped at once, as before, and so is every engine at a restart or
  an unload. Stopping it on `pagehide` or `freeze` as well was considered and not done: `freeze` is
  Chromium's Page Lifecycle, which WebKit does not have, and `pagehide` marks a page being left,
  which an app sent to the background is not.
- **The store keeps a run whose preamble took longer for longer** (`src/cache/runs.ts` keptUntil):
  a minute more for each millisecond its preamble and save took, counted from its last use, and a
  run that would itself go first is not kept, evicting nothing. And a diagram that starts from a run
  its engine held counts as a use of the run stored under that name (`StoredRuns.used`), written down
  at most once a minute a run. With every run handed over, the least-recently-used order filled the
  16 MiB with a note's last preambles, and the next visit, from the top, found its first ones gone
  and stored them again over the last: in an intermediate build that handed everything over and kept
  the old order, a second visit of the 44 started 6 diagrams from storage against beta.4's 11, and
  took longer, 7,836 (7,836–8,570) ms against 6,703 (6,703–8,142). circuitikz's run, whose preamble
  and save took 220 to 330 ms here, is kept four to five hours longer than plain TikZ's, 15 to 30.
  Over a day or more, recency decides.

An intermediate build that only handed runs over a slice at a time between diagrams, on the worker's
thread, without the helper, still dropped runs in a dense note: 12 to 13 of the 23 handed over, and
siunitx's and pgfplotstable's preambles compiled again on the second visit. Its figures are not
compared below.

**Measured**, on 2026-10-15, the first build of beta.5 (daa19f5, "this release" in the two tables
below) against 0.2.1-beta.4 as published, two rounds each, the builds interleaved, two sessions per
round, each a fresh browser on one profile, the second on what the first left; every diagram's SVG
as the golden corpus has it, but for four fixtures whose reference this harness does not reproduce
(`expl3` and three of the Unicode ones), which both builds drew alike. Medians (ranges) in ms, the
note handed over a diagram at a time as the queue hands them on a phone. The build after the review
is measured further below:

| | stored after the first visit | second visit: from storage, preamble compiled | second visit, the note | first visit, the note |
| --- | --- | --- | ---: | ---: |
| 44 fixtures, background 1 s after, beta.4 | 10 runs, 6.00 MiB | 11, 11 | 6,562 (6,562–6,606) | 7,496 (7,496–7,588) |
| the same, this release | 19 runs, 15.91–15.93 MiB | 16–18, 4 | 5,693 (5,693–5,758) | 7,454 (7,454–7,458) |
| 44 fixtures, background at once, beta.4 | none | 0, 23 | 7,610 (7,610–7,713) | 7,529 (7,529–7,726) |
| the same, this release | 19 runs, 15.93–15.94 MiB | 16–20, 3–4 | 5,825 (5,825–5,834) | 7,377 (7,377–7,428) |
| 44 fixtures, idle stop, beta.4 | 10 runs, 6.00 MiB | 11, 11 | 5,249 (5,249–6,693) | 5,869 (5,869–7,484) |
| the same, this release | 19 runs, 15.92–15.94 MiB | 16–18, 1–4 | 4,542 (4,542–4,624) | 5,762 (5,762–5,811) |
| 74 diagrams (37 twice in a row), background 1 s after, beta.4 | 7 runs, 4.34 MiB | 8, 10 | 5,876 (5,876–5,936) | 6,508 (6,508–6,618) |
| the same, this release | 19 runs, 15.77 MiB | 21, 0 | 4,415 (4,415–4,493) | 6,863 (6,863–7,019) |
| 74 diagrams, idle stop, beta.4 | 7 runs, 4.34 MiB | 8, 10 | 4,585 (4,585–4,616) | 5,101 (5,101–5,267) |
| the same, this release | 19 runs, 15.77 MiB | 21, 0 | 3,549 (3,549–3,651) | 5,210 (5,210–5,329) |

On the second visit of the 44, circuitikz, pgfplots-axis, pgfplotstable, siunitx, forest, tikz-cd,
feynhand and chemfig all started from storage with this release, in every round of every ending,
and plain TikZ in all but one round of two endings; with beta.4, circuitikz, pgfplotstable, siunitx, feynhand and chemfig
compiled their preambles, and after a background at once all 23 did. The first visit took what
beta.4's did, within this desktop's noise, 6 % either way, the gzip being off the worker's thread;
in it, two diagrams that beta.4 compiled from the start this release started from runs stored earlier
in the same visit, which the worker had let go for room. The engine was gone 19 to 20 ms after the
background at once, its runs handed over; 1,028 to 1,044 ms after a background 1 s after the last
diagram, the drain taking 28 to 44.

The first diagram after a fresh start of the browser, one diagram a session, the background 200 ms
after it, median (range) of the second session, in ms:

| | beta.4 | this release |
| --- | ---: | ---: |
| `basic` | 95 (95–97), stored | 91 (91–99), stored |
| `siunitx` | 102 (102–105), stored | 100 (100–106), stored |
| `tikz-cd` | 149 (149–153), stored | 147 (147–152), stored |
| `forest` | 234 (234–237), stored | 237 (237–239), stored |
| `circuitikz` | 438 (438–439), compiled | 217 (217–221), stored |
| `pgfplots-axis` | 414 (414–416), compiled | 252 (252–253), stored |
| `pgfplotstable` | 354 (354–356), compiled | 155 (155–166), stored |

On this desktop's WebKit, then, the first build's runs reached storage, many of them in the drain
after the last diagram, which took 1 s at most here. Where each was handed over, taken after the
review with a copy of the harness that logs it, the six heavy fixtures one after the other and the
background at once, four rounds of the first build: circuitikz's run, the first diagram's, three
diagrams after its own in three rounds and after the last in one, and 4 to 6 of the 6 runs after the
last diagram; the engine was gone 107 to 268 ms after the background. On a phone each of those steps
is slower, the drain with them.

**Measured after the review**, on 2026-10-15, this release's build (`main.js` 12,226,842 bytes)
against 0.2.1-beta.4 as published and, where named, the first build of beta.5, by the same harness,
which now logs after how many of the note's diagrams each run was handed over, the builds
interleaved, two rounds of two sessions each; WebKit 26.6 at a phone's budgets unless said. The
desktop was faster than for the tables above, so only figures of one table are compared. The SVGs
as before. Medians (ranges) in ms:

| | stored after the first visit | handed over after the last diagram | second visit: from storage, preamble compiled | second visit, the note | first visit, the note |
| --- | --- | --- | --- | ---: | ---: |
| 6 heavy fixtures one after the other, background at once, beta.4 | none | | 0, 6 | 1,468 (1,468–1,490) | 1,459 (1,459–1,516) |
| the same, beta.5's first build | 6 runs, 9.65 MiB | 4 of 6 | 6, 0 | 660 (660–689) | 1,470 (1,470–1,475) |
| the same, this release | 6 runs, 9.65 MiB | 2 of 6 | 6, 0 | 686 (686–695) | 1,472 (1,472–1,492) |
| 44 fixtures, background at once, beta.4 | none | | 0, 23 | 5,809 (5,809–5,876) | 5,836 (5,836–5,905) |
| the same, beta.5's first build | 19 runs, 15.92–15.93 MiB | 1 of 23 | 17, 3–4 | 4,528 (4,528–4,587) | 5,748 (5,748–5,752) |
| the same, this release | 19 runs, 15.92 MiB | 1 of 23 | 18–19, 2 | 4,572 (4,572–4,646) | 5,734 (5,734–5,796) |
| 44 fixtures, background 1 s after, beta.4 | 10 runs, 6.00 MiB | 10 of 10 | 11, 11 | 5,200 (5,200–5,270) | 5,867 (5,867–5,867) |
| the same, this release | 19 runs, 15.92–15.93 MiB | 1 of 23 | 17–18, 3 | 4,595 (4,595–4,636) | 5,718 (5,718–5,746) |
| 44 fixtures, idle stop, beta.4 | 10 runs, 6.00 MiB | 10 of 10 | 11, 11 | 5,244 (5,244–5,267) | 5,865 (5,865–5,884) |
| the same, this release | 19 runs, 15.90–15.92 MiB | 1 of 23 | 17, 3 | 4,683 (4,683–4,696) | 5,919 (5,919–5,932) |
| 74 diagrams, background 1 s after, beta.4 | 7 runs, 4.34 MiB | 7 of 7 | 8, 10 | 4,555 (4,555–4,658) | 5,020 (5,020–5,038) |
| the same, this release | 19 runs, 15.77 MiB | 1 of 19 | 21, 0 | 3,505 (3,505–3,517) | 5,196 (5,196–5,224) |
| 44 fixtures, background at once, Chromium 153 at a phone's budgets (Android), beta.4 | none | | 0, 23 | 4,091 (4,091–4,133) | 4,117 (4,117–4,146) |
| the same, this release | 22 runs, 14.75 MiB | 1 of 22 | 19–20, 3–4 | 2,994 (2,994–3,032) | 4,103 (4,103–4,107) |
| 74 diagrams, idle stop, Chromium 153 at a computer's budgets, one engine, beta.4 | 20 runs, 15.86 MiB | 20 of 20 | 18, 0 | 1,892 (1,892–1,986) | 2,884 (2,884–2,893) |
| the same, beta.5's first build | 20 runs, 15.86 MiB | 1–2 of 20 | 18, 0 | 1,908 (1,908–1,949) | 2,929 (2,929–2,941) |
| the same, this release | 20 runs, 15.86 MiB | 1 of 20 | 18, 0 | 1,887 (1,887–1,910) | 2,930 (2,930–2,978) |

With the six heavy fixtures, each run was handed over one diagram after its own, the helper's answer
waiting for the worker's thread through the next diagram's TeX, and the last two after the note: the
engine was gone 53 (53–57) ms after the background at once, against the first build's 107 (107–133);
in the 44, where light diagrams come between heavy ones, both builds had one left at the end, and
the engine was gone 6 to 7 ms after the background, where the first build's took 23 to 24, asking
first. After a background 1 s after the last diagram, nothing was left: the engine was gone 5 to 15
ms after it, stopped at once. The first visit took 2.5 % less to 3.5 % more than beta.4's at a
phone's budgets; at a computer's in Chromium, as Obsidian's desktop app runs it, 1.6 % more, as with
the first build, which in Chromium already handed runs over as the note went, and where beta.4
stored every run too, at the end. The same at a computer's budgets in WebKit, which no device runs,
took 2.3 % and 4.8 % more over the 44 and the 74. The first diagram after a fresh start of the
browser, the background 200 ms after it, in the second session: `basic` 88 (88–91) ms against
beta.4's 84 (84–95), both stored; circuitikz 223 (223–225), stored, against 426 (426–431), compiled;
pgfplots-axis 244 (244–256) against 416 (416–420); pgfplotstable 153 (153–159) against 358
(358–362).

**What it costs.** `main.js` grows by 3,601 bytes for this, and 511 more for the review's changes to
it. A second thread while runs are handed over, whose memory was not measured; the engine kept up to
1 s after Obsidian went to the background, up to 2 s after its idle stop, where it has runs waiting;
more for the store to write: 23 runs handed to it in a first visit of the 44, where beta.4 handed it
10, and as the note goes rather than at its end.

**Not measured on a phone.** That the heavy diagrams of the maintainer's note now start from storage
after a force-quit, and what reading and putting them back take there. `TODO.md` §9 has it.

### A block that joined a compile already running

**What the phone said.** "#7 cb3a6fbf: … TeX 68 ms … seen to drawn 10 ms", and "#18 f2198e3d: … TeX
599 … seen to drawn 265": a block that asked for a diagram whose compile was already under way, for
a block a re-render had replaced or the same diagram in another pane, joined it (the queue's dedup),
and the view showed that compile's TeX, reset, save and DVI to SVG as its own, beside a "seen to
drawn" timed from its own first sighting, which the compile had begun before.

Now the queue tells a caller, when it joins a job that has already started, that it did
(`SubmitOptions.onStart(joined)`), the block's timings say so (`CompileTimings.joined`), and the view
shows "joined a compile already running, whose TeX took N ms", without the compile's other steps;
its waited, SVG pipeline, drawing and seen to drawn are its own. A block that joined a job before
it started waited for it as the first one did, and shows its steps as before.

"Resumed from a saved preamble" said so of a diagram that started from a run its engine had put back
from storage for an earlier diagram and kept, which the engine had not saved. The worker now marks a
run read back from storage (`SavedRun.fromStore`), and a diagram that resumes from it, put back for
an earlier diagram, says "resumed from a stored preamble put back for an earlier diagram"
(`RenderTimings.fromStore`); one put back for itself says what reading it and putting it back took,
as before. `main.js` grows by 445 bytes for these two, to 12,225,559 bytes in all, 4,803 more than
beta.4's. With the review's changes, 12,226,842, 6,086 more than beta.4's.

### The notice a wrong probe showed

The notice that TeX seems to run without the JIT is shown once, and data.json remembers it
(`jitNoticeShown`), so a vault that beta.3 or beta.4 showed it to wrongly, as the maintainer's, would
never be told when it is true. `settingsVersion` goes to 2, and a data.json from before it has the
flag cleared once (`migrateSettings`); the notice then shows again only where the second probe finds
the JIT off at two starts of a session.

Tests: `test/jit.test.ts` (the attempts, the pause, the weighing at its thresholds, the phone's two
readings and the not-compiled-yet model, which the second probe settles, the recorded starts above),
`test/worker-boot.test.ts` (the shipped worker says on in Node, with the inflate it weighed against,
and none without the platform's gzip; takes the probe again a second later where its loop was held to
45 ns a step at the start, and not where it found the JIT on), `test/worker-handover.test.ts` (the
shipped worker hands runs over while the next diagram is under way and before it says flushed, also
unasked, says in each reply how many are waiting, hands a run to its gzip helper in the reply's own
task with its messages to itself held back as WebKit's were, gzips on its own thread where the helper
fails or never says it is up, and stops one that does not, and says where a run it resumed from came
from), `test/worker-host.test.ts` (the drain at the idle stop and in the background, its limits, the
shorter one when both come, a job and a diagram that keep the engine, the stops that do not wait,
also where nothing is left to hand over, the uses the store is told of, and when the plugin is told
what a start says of the JIT), `test/runs.test.ts` (what goes first, a run that would itself go
first, a use from memory), `test/queue.test.ts` and `test/render-child.test.ts` (a joined compile),
`test/report.test.ts` and `test/debug-view.test.ts` (what the view and Copy say, "checking again"
among it), `test/settings.test.ts` (the notice's flag cleared once).

---

## D39 — What 0.2.1-beta.5 did on the maintainer's devices: a preamble the worker had no room to save, and the desktop's first diagrams waiting after a start

**Amends D32 (which runs are saved), D36 (which reach storage), D22 (when a block debounces) and D21
(what the diagnostics say), and DESIGN.md §3.3, §4.7, §5.4 and §7.6. Found by the maintainer testing
0.2.1-beta.5 on the iPhone 16 Pro of D38, iOS 27.0.1, with the JIT on and the phone in its normal
power state, and on the Windows desktop the engine is maintained on, Obsidian 1.14.4 with two engines.
Date of record: 2026-10-15; corrected the same day after the review of its first build (f4366b7),
whose findings are given where they change what is said.**

The maintainer's readings, from the diagnostics view's Copy, are the only device figures here; every
other figure is from the desktop of D27 on 2026-10-15, with Playwright 1.63's WebKit 26.6, each named
with how it was taken.

### A preamble the worker had no room to save

**What the phone said.** "#38 ad18c71e (circuitikz): TeX 212 ms · preamble saved in 3 ms, not kept:
no room", and "#37 dd914518 (pgfplots): TeX 73 ms · resumed from a stored preamble (read 3 ms, put
back 9 ms)", where the same diagram compiled took 187 to 211 ms; "Stored preambles: 5, 9.4 MB";
engine 1 "3 saved preambles, 7.6 MB, stopped after it had nothing to do", engine 2 "1 saved
preamble, 0.6 MB". circuitikz's run is 8.88 MiB as an engine holds it, the largest of the fixtures,
and a phone's engine holds 12 MiB of runs, of which the ones resumed from within the last 16 renders
may not go to make room (D32): beside pgfplots' 6.50, put back from storage and resumed from, it does
not fit.

**What beta.5 did with such a run**, which is not all the readings suggested. A run saved and not
kept was handed over all the same: the worker queues for the host every run its render saved, kept
or not, the ones it no longer keeps first (D38). In WebKit at a phone's budgets, through the harness
of D38 (`phone.mjs`), basic, siunitx twice, pgfplots-axis twice, circuitikz and basic: circuitikz's
run was saved, not kept, handed over and stored, and its diagram in the next session started from
it. What never reached storage was a run the worker did not save at all. A run is not saved where the
room there would be, once everything that may go had gone, is less than the last run saved under the
same name took, or, for a name with none, the smallest run saved yet (`SnapshotCache.wants`, D32),
which spares a phone without the JIT a save of a tenth of a second it would throw away. With basic,
pgfplots-axis, siunitx and feynhand twice each and then circuitikz twice, the runs resumed from held
11.76 of the 12 MiB, and both circuitikz diagrams compiled their preamble and saved nothing; beta.5
stored the run only in a later session, whose worker, holding the runs it had put back from storage,
happened to have room to save it.

**What the phone's reading leaves open.** It says saved and not kept, and by the code beta.5 handed
such a run over where the host asked for it: while storage could take a run and none was stored under
its name. So the change below is not for what the phone reported, and whether circuitikz's run reaches
the phone's store is as open after it as before. The phone's own symptom is unexplained; this change
is for another case, a run the worker did not save at all, which the harness found. Read in beta.5's
code, each of these ends in the same line, and nothing in the diagnostics told them apart:

- A run stored under the diagram's name and not sent with it, so that the host asked for none
  (`persist` is false wherever one is stored and none was sent) and the diagram saved a run nobody
  asked for: storage not answering, a read outlasting its 250 ms or an earlier one not settled
  (`overdueReads`); a run that could not be put back earlier that session for want of memory
  (`unsendable`); putting it back estimated dearer than its preamble (`worth`); its read failing; an
  engine holding it when the diagram came, which then went to the other engine or let the run go; or
  the run stored only after the diagram's read had found none, as when the diagram before it, of the
  same preamble, had just handed it over.
- A hand-over lost: the gzip helper taking the bytes and failing (`gzipElsewhere` null), the cap on
  the runs waiting dropping it (D38), or the writing out or the post failing.
- A run handed over and not kept: not worth putting back by the figures a session starts from,
  larger than the store's budget, one that would itself go first (`keptUntil`), storage refusing it
  for room, which stops the writes for the session, or the store cleared since its render was posted
  (the epoch, D36).

None was reproduced on the desktop. The phone's "Stored preambles: 5, 9.4 MB" may hold circuitikz's
run, 2.83 MiB gzipped, and its diagram would then have been of the first kind. What the diagnostics
now say of each is below.

**What it does now** (`engine-src/worker.ts` render). A render the host asks to hand its run over
(`persist`) saves it where `wants` says no as well, unless the worker has already saved one of that
name for this in its life (`savedForStore`). The run is not kept: it is handed over like any other,
written out in its reply's own task, gzipped on the helper's thread, held to the cap on runs waiting
and drained before the idle and background stops (D38), and let go once handed over. The store's own
budget, cost and order of eviction (D36, D38) decide whether it is kept. Once a name in a worker's
life, because the host goes on asking while none is stored under the name, which none is where the
store did not keep it, and each such save costs its diagram the save's time: 4 to 6 ms in WebKit here,
3 ms on the maintainer's iPhone, a tenth of a second without the JIT (D32). A hand-over the cap on the
runs waiting drops takes the name out again, so that the next diagram of that preamble saves it once
more; so does a clear of the store, which moves its epoch without stopping an engine, and saved
preambles turned off, after which the store holds none. A hand-over that fails does not, since the
review: what fails one is memory, the run written out on a phone short of it, or a helper that took
its bytes and died, and the first build saved the run again at every later diagram of its preamble,
allocating it and its writing out each time under that pressure (the review's reproduction, in Node at
a budget of 1 MiB with the worker full and its hand-overs refused: four siunitx diagrams each saved,
where beta.5 saved none). Nor is a run saved for the store by a render whose stored run could not be
put back for want of memory, which the store keeps and the host sends no more that session: the first
build allocated it again right after that failure. Where the host does not ask, nothing changes.

**Measured** with the persistence harness of D36 (`persist.mjs`: each build's own WorkerHost and
RunStore driving the worker its `main.js` ships, on a persistent profile, two sessions a round, each a
fresh browser, the second on what the first left), WebKit 26.6 at a phone's budgets, 12 MiB in the
worker and 16 stored, one engine, the diagrams handed over one at a time as the queue does on a phone;
this change's first build (aadfd24) against 0.2.1-beta.5 as published, three rounds, the builds
interleaved. The review's changes to it act only where a hand-over fails, a stored run cannot be put
back for want of memory or the store is cleared, none of which these notes do, nor did the round of
the reviewed build below. Every SVG
was as the golden corpus has it, but for the four fixtures of D38 this harness does not reproduce,
which both builds drew alike. Medians (ranges), in ms; the peaks are the content process's working
set and private commit over the session, in MiB:

| | beta.5, 1st session | this, 1st session | beta.5, 2nd session | this, 2nd session |
| --- | ---: | ---: | ---: | ---: |
| basic, pgfplots-axis, siunitx and feynhand twice each, circuitikz twice, basic: the note | 2,046 (2,038–2,054) | 2,024 (2,008–2,033) | 1,676 (1,674–1,689) | 1,273 (1,259–1,286) |
| its first diagram, basic | 63 (51–64) | 55 (51–64) | 46 (46–47) | 37 (37–48) |
| circuitikz's first diagram | 326 (326–326), compiled, nothing saved | 328 (328–333), saved for storage in 4 to 6 | 340 (333–341), saved, not kept | 136 (129–137), from storage, read 7 to 14, put back 13 to 17 |
| stored at the end | 4 runs, 3.86 MiB | 5 runs, 6.69 MiB | 5 runs, 6.69 MiB | 5 runs, 6.69 MiB |
| peak working set, commit | 378, 749 | 377, 803 | 359, 779 | 370, 771 |
| basic, siunitx twice, pgfplots-axis twice, circuitikz, basic: the note | 1,034 (1,019–1,042) | 1,053 (1,053–1,056) | 603 (601–605) | 582 (581–592) |
| its first diagram, basic | 52 (51–53) | 62 (51–63) | 55 (43–57) | 44 (37–45) |
| peak working set, commit | 385, 805 | 383, 783 | 365, 749 | 367, 779 |
| the 44 fixtures once each: the note | 5,817 (5,759–5,959) | 5,721 (5,716–5,924) | 4,659 (4,566–4,771) | 4,623 (4,559–4,752) |
| its first diagram, arrows-meta | 83 (77–200) | 81 (76–84) | 56 (43–57) | 49 (48–57) |
| diagrams started from storage; stored at the end | 2; 19 runs, 15.92 MiB | 2; 19 runs, 15.90–15.93 MiB | 18; 19 runs, 15.92–15.93 MiB | 17; 19 runs, 15.92 MiB |
| peak working set, commit | 548, 1,641 | 546, 1,641 | 599, 1,680 | 598, 1,679 |

In the first note circuitikz's run reaches storage in the first session, where beta.5's reached it in
the second, and its first diagram of the second session starts from it in 129 to 137 ms against 333
to 341 compiled; its second diagram in a session starts from it too, read and put back again, as a
run the worker cannot keep is at every diagram of its preamble that finds it stored (D36). In the
second note both builds store circuitikz's run saved and not kept, and take the same.

Over the 44 the first sessions were alike, diagram by diagram, in both builds: in a first visit
nothing is stored under any name, the host asks for every run, and no run was saved for the store
alone. The second sessions started 17 diagrams from storage in each of this build's rounds against 18
in each of beta.5's, and resumed 31, 31 and 31 diagrams in all, from storage or from memory, against
34, 34 and 32. The first version of this record put that down to the extra hand-overs making the
store let go of others; read diagram by diagram, the review found otherwise. missing-package's run,
which beta.5's first two rounds found stored, was missing from the store when each of this build's
second sessions, and beta.5's third, reached it: its diagram compiled 1,087 to 1,150 ms into the
session, before the session's first hand-over, at 1,395 ms or later. That is the first session's end
state: which runs a full store keeps depends on the preamble times each round measured
(`keptUntil`). In every round that found it gone, the worker later had no room for ts1-currency's run:
beta.5's third saved none there, this build saved it for the store and did not keep it, and
ts1-small-caps and ts1-symbols, which beta.5's first two rounds started from that run in memory,
compiled their preamble in all four. The extra saves were documentclass's or expl3's, and
ts1-currency's, small runs the full store had not kept. In the third rounds, the one pair whose
second sessions both found missing-package's run gone, this build's started unicode-wrap's diagram
compiled where beta.5's started it from storage, which the extra hand-overs may account for; three
rounds cannot say. The note took as long within this desktop's noise.

One more round of this build alone, after the review, with the diagnostics below: the second session
started 16 diagrams from storage; documentclass, expl3 and ts1-currency each saved their run for the
store, in 5 to 8 ms, and handed it over, and the store, full, kept 4 of the 8 runs handed to it in
that session and refused 4, each as one that would have gone first. A run saved for a full store, of
a preamble cheaper than every run it holds, is refused, and its diagram has paid the save for
nothing. Not changed: the host cannot know before the render what the run will have cost, and a store
that is not full keeps it.

The peaks are beta.5's within their ranges, but for the private commit of the first note's first
session, 803 (779–832) MiB against 749 (748–809): a run saved and handed over is memory until the
collector frees it (D32).

**What the diagnostics now say**, at the review's request, so that the next reading on the phone tells
these paths apart (`src/engine/worker-host.ts`, `src/cache/runs.ts`, `engine-src/worker.ts`, D21):

- Per diagram, where a run is stored under its name and the engine it went to did not hold it,
  "stored preamble not sent:" and why: "storage was slow to answer", "it could not be put back earlier
  for want of memory", "putting it back looked dearer than its preamble", "reading it failed", "an
  engine held it when the diagram came", "it was stored after the diagram came". And a run saved to be
  handed over says so: "preamble saved in 3 ms, not kept: no room, sent to be stored".
- Per engine, "4 handed over to be stored", and how many of its runs were dropped for room and how
  many failed on the way, as each reply and each `flushed` says (`HandOverCounts`).
- The store, what it kept this session and what it refused, and why: "this session 4 kept, 4 refused:
  4 would have gone first", or not worth putting back, larger than the budget, storage full, cleared
  meanwhile, not written, storage unavailable.

**What it costs.** `main.js` grows by 220 bytes for the change, 96 for the review's changes to it and
2,245 for the diagnostics. The worker's ENGINE_ID moves, and `test/fixtures/golden/REVISION.json` and
`src/source/native-unicode.ts` are recorded again under it; what TeX draws does not change
(`verify:golden`, `verify:snapshot`, `verify:reset`, and the scan finds the same characters native).
Tests: `test/worker-handover.test.ts` (a run larger than the budget, handed over, let go, and put back
by another worker; one saved for the host where the worker is too full to save it for itself, handed
over, and not saved again in that worker's life, but for once its hand-over was dropped for room, or
the store cleared, or saved preambles turned off and on; not again after a hand-over that failed, nor
where the stored run sent could not be put back for want of memory; the counts and the flag),
`test/worker-host.test.ts` (each reason a stored run is not sent, none for a diagram that started from
the run its engine held, the counts in the report), `test/runs.test.ts` (each refusal, a read that
failed), `test/report.test.ts` (the lines).

**Not measured on a phone.** Which of the paths above the phone's line came from, which the next
reading with this build will say; whether circuitikz's run is then in the maintainer's store after a
visit of the note, and starts its first diagram after a force-quit.

### The desktop's first diagrams waiting after a start

**What the desktop said.** Right after Obsidian started, the first three diagrams of the note open
in it said "waited 300 ms", the desktop's debounce, and the day before the first four said 302 to 323;
later ones said 0. The iPhone's first diagrams waited 0 to 1 ms.

**Why.** Under D22 a block debounced when its note's text had changed within a second of its cache
miss: an `editor-change` in any pane, a `modify` of its file, or an `editor-change` that names no
note, which counts for every note. So at each start something reported an edit of the open note
within a second before its first blocks missed the cache. Read in Obsidian 1.14.4's bundle
(`app.js`, bounded searches of the minified code), it is not Obsidian loading the note:

- `editor-change` is triggered only from an editor's update listener, and only when the update
  changed the document (`t.docChanged && this.app.workspace.trigger("editor-change", …)`).
- A view that loads a note sets its editor with the clear flag (`onLoadFile` → `loadFileInternal(file,
  true)` → `setViewData(text, true)` → each mode's `set(text, true)`), which replaces the editor's
  state (`EditorView.setState`), and CodeMirror calls no update listener for that.
- A view whose file changes re-reads it (`onModify` → `loadFileInternal(file, false)`) and returns
  without touching the view when the text is what it last loaded or saved; where it is not, an editor
  applies the difference as a change (`userEvent: "set"`), which does trigger `editor-change`.
- `modify` is triggered whenever a file's modification time or size moved, whoever wrote it and
  whether or not its text changed (the desktop adapter's `reconcileFileCreation` compares the two),
  and `Vault.modify` writes what it is given.
- Obsidian Sync writes a note it brings from another device with `Vault.modify`, where the other
  device's text differs from this one's, and after a merge (`e2(base, local, remote)`) also where the
  merge comes out as the local text.

So the edit came from something acting on the note as Obsidian started: Sync bringing a change from
another device, such as the phone beta.5 was tested on, or a community plugin acting at startup.
(**Amended by D40**: it was neither, but Obsidian's own reset of its syntax highlighting, which
replaces the note's first character with itself once a session.)
Which, the maintainer's vault and its plugins would say; neither was read for this. Sync acts once it
has reached its server, and a plugin most often once the workspace is ready or a note is opened, both
after Obsidian has shown the note; and D22 measured the second back from the cache miss, which comes
after an IndexedDB read, slow while Obsidian starts, so that an edit reported after the note's view
had made its blocks, and before their reads answered, counted for blocks it had not made.

**What it does now** (`src/block/edits.ts` `RecentEdits.making`, `src/block/processor.ts`). The
second is measured from the block's making. A block is taken for one made by typing when its note's
text changed within the second before it was made, or in the same run of code as its making, after
it: Live Preview builds a code block's widget (`toDOM` → `initDOM`, which calls the processor) in the
keystroke's own update, and its update listener then triggers `editor-change`, all before the
page's queued microtasks run, which is how the run is told (`queueMicrotask`). The processor asks as
Obsidian hands it the block, before anything yields, also on the path that resolves a preamble
first, and the block's miss reads the answer. An edit reported after a block was made, in another
run, does not count for it, nor does an `editor-change` that names no note then. `editWindowMs` keeps
its second, which now runs from the keystroke to the block's making: 10 ms, and up to 200 ms while a
Reading view is still parsing (D22). An edit in the run of a block's making counts only where it is a
later edit of its note, or one that names none: in the first build, a note's entry dropped once it had
left the window, as another note's edit drops it, read as a change of the block's note, and a block
waited for another note's edit in that run (the review's).

What it keeps, each held by a test that reproduces Obsidian's order of things with the plugin's own
`RecentEdits` (`test/processor.test.ts`): typing in Live Preview waits, the block made in the
keystroke's update and the edit reported after it; a second pane, a Reading view beside the editor
and an embed wait, remade after the keystroke; and a note shown while a sync or another program
changes it waits, redrawn after the `modify`, as does a block made between two changes. The two
orders of a start, a `modify` and an `editor-change` that names no note, each reported after the
block was made and before its miss, wait the debounce with D22's rule, tried by putting it back, and
not with this one. `test/edits.test.ts` holds the window, the runs, the page's own `queueMicrotask`
and the notes kept apart.

**What it does not cover.** An edit reported within the second before the note's view made its
blocks still makes them wait: something that writes the note just before Obsidian shows it. And an
`editor-change` that names no note, in the same run as a block's making, counts for it, as it did.

**What the diagnostics now say.** The rule rests on what the bundle shows and on what the startup edit
was assumed to be, which nobody knows: an edit after the note's view made its blocks. One within the
second before still makes them wait, as above; and Sync bringing a real change to a block's code, as
when the same note was edited on the phone, has Live Preview remake that block in the update that
reports the edit, and the block waits by design. Each said "waited 300 ms", as a start that did not
wait would have said "waited 0 ms" whether or not any edit came. So, at the review's request, the miss
is told which edit made the block, an `editor-change` naming its note, one naming none, or the note's
`modify`, and how long before the block was made, or that it came in the run that made it; and of a
block no edit made, the last edit of its note reported after it was made, which did not count
(`MadeBy`, `CompileTimings.edit`). The waited step says it: "waited 300 ms: the note's file changed
120 ms before the block was made", "waited 300 ms: the note was edited as the block was made", "waited
0 ms; the note's file changed 85 ms after the block was made, which did not count". One start of the
desktop then says what wrote the note and whether this rule held. Tests: `test/edits.test.ts` (the
edit told, each kind, and another note's edit with a stale entry for the block's),
`test/render-child.test.ts` (carried to the timings, and none after a Retry), `test/report.test.ts`.

**What it costs.** `main.js` grows by 345 bytes for it, and 676 for the review's diagnostics. No
Obsidian was started for this: whether the desktop's first diagrams now say "waited 0 ms" after a
start, and what the waited step says of the edit then, is for the maintainer's next one.

---

## D40 — What 0.2.1-beta.6 did on the maintainer's devices: Obsidian's own edit at a start, and a phone that drew the diagram at the top last

**Amends D22 and D39 (when a block debounces), D25 (the window in which a job is dropped now also
gives up its slot), D24's one slot on a phone (which job holds it) and D21 (what the diagnostics say),
and DESIGN.md §3.3, §5.1 and §7.6. Found by the maintainer testing 0.2.1-beta.6 on the Windows
desktop of D39, Obsidian 1.14.4 with two engines, and on the iPhone 16 Pro of D38, iOS 27.0.1,
Obsidian 1.14.5, the JIT on. Date of record: 2026-10-15.**

The maintainer's readings, from the diagnostics view's Copy, are the only device figures here. What
Obsidian does is read in its 1.14.4 desktop bundle (`app.js`, bounded searches of the minified code),
and the phone's order is simulated, each said where it comes.

### The desktop's first diagrams still waiting after a start

**What the desktop said.** Obsidian started again with a note of eleven diagrams open in Live
Preview. Blocks #1 to #9, nine diagrams, were made and then all "cancelled"; the same nine were made
again as #10 to #18, and those not cached said "waited 300 ms: the note was edited 103 ms before the
block was made", or 104. Diagrams shown two seconds later did not wait. The note's file had not
changed on disk since the day before. The engine had started twice, and #10 and #11 each said
"memory reset" on an engine that had already run TeX, with no wait in the host: the first nine had
missed the cache and gone to both engines without waiting, before they went away. So they were made
before the edit, and D39's rule held for them; the nine made again within the second after it waited.

**What the edit is**, read in the bundle: Obsidian's own, not Sync's nor a plugin's, as D39 supposed.
The first time in a session that the editor asks for a CodeMirror 5 mode that is not there — Live
Preview's markdown mode asks for one for each fenced block's language, and `tikz` has none, nor has
maths until the modes have loaded — Obsidian loads its modes' script (`/lib/codemirror/modes.min.js`),
and once it has, resets the syntax highlighting of every open Markdown view. The reset dispatches a
change that replaces the note's first character with itself (`changes: [{from: 0, to: 1, insert:
doc.sliceString(0, 1)}]`, `userEvent: "set"`). It changes the document, so the editor's update
listener triggers `editor-change` naming the note; and it saves nothing, since the text is what was
last saved. Every user who shows a `tikz` block, or maths, in an editor has it once a session, a
moment after the note's blocks are made. The iPhone's "the note was edited 23 ms after the block was
made, which did not count" (below) is the same reset, after the blocks, as D39 meant it to be
counted. Read in the `main.js` of each plugin in the maintainer's vault, none changes a note's text
on opening it or once the workspace is ready, but for one that rewrites, through `Vault.modify`, only
notes holding blocks of its own, which would have moved the file's date.

**Why the blocks were made again**, read in the bundle; which of the two it was, the readings cannot
say:

- Live Preview makes every code block's widget again when a plugin registers a code-block or
  Markdown post-processor: the registration triggers `post-processor-change`, and 10 ms later Live
  Preview rebuilds every code-block widget, unloading the old blocks in the update that makes the new
  ones. Plugins finish loading before the workspace's layout does, so only a registration made later
  does this, as a plugin's that registers its processor once the layout is ready. Another plugin in
  the maintainer's vault does, which makes one such remake at every start, after the open note's
  blocks exist.
- Or the reset's own update finds the syntax tree not yet parsed past the blocks lower in the note,
  lets those blocks go, and the parse that follows, about 100 ms later, makes them again.

One start with that other plugin turned off would tell them apart. The rule below holds for both.

**What it does now** (`src/block/edits.ts`, `src/block/processor.ts`, `src/block/render-child.ts`).
An edit does not count for a block whose text its note had on screen as the edits began:

- **The edits.** A note's edits, `editor-change` naming it, its file's `modify` and an
  `editor-change` that names no note, each within the window (1 s) of the one before, are one burst,
  which begins with the first edit after a pause longer than the window. Where a burst of the note's
  own edits and one of edits naming no note both go on, the earlier start is taken, erring towards
  the debounce.
- **On screen.** A text is on screen in a note from the run of code a block of it was made in, once
  the block is loaded, to the run in which the last block of it is unloaded, whichever view the
  blocks are in; and it is remembered for the window after that. The block's load and unload say so
  (`Making.shown`), and its making's run is the one asked about as the processor is handed the block
  (D39), so a block whose preamble is read before it is loaded is on screen from its making.
- **The rule.** A block D39 finds made by an edit still waits for the debounce, unless its note had
  its text on screen as that edit's burst began: a block of it made in an earlier run than the burst's
  first edit, and loaded still or unloaded no earlier than that edit's run. A block made in the run of
  the first edit came with it, as Live Preview makes a keystroke's widget and then reports the edit;
  one unloaded in that run was on screen as it came, as the reset's own update lets blocks go.
- **Not a diagram the cache does not hold.** A text whose last block came to rest without leaving
  its diagram in the cache — on an error card, as a degraded diagram, as a `nocache` one, on a
  button — is not taken for one the note showed, until a block of it comes to rest with its diagram
  cached (`Making.rested`). Made again, such a block joins no compile and finds nothing cached. A
  section of Reading view is a whole top-level block, a list, a callout or a blockquote, and
  `parseFinish` keeps a section only while its whole text is unchanged (read in the bundle), so
  typing anywhere in a list makes every diagram in it again; Live Preview makes again a callout it
  draws as one widget whenever its text changes. Exempt, a diagram on an error card there was
  compiled at once at every keystroke beside it, one compile a keystroke on the only slot a phone
  has, where beta.6 had it wait and the next keystroke let it go (found in review, with the real
  processor, block and `RecentEdits`: five keystrokes, five compiles; now none, as in beta.6). The
  blocks a start makes again had not come to rest: their compiles were under way.
- **When it is asked.** The texts the note had on screen as the burst began are noted when the run
  that made the block is over, and the miss asks whether its key is one of them: at the miss, which
  comes after an IndexedDB read, a text unloaded in that run might no longer be remembered. A
  `nocache` block reads no cache, and now waits for that run to be over before it asks: with no
  preamble to look for, the processor makes and loads a block in the run it is handed it in, and such
  a block asked before Live Preview reported the keystroke that made it, and before what the note
  showed was noted, so D39's edit "as the block was made" did not make it wait, nor did this rule
  find it shown at a start (found in review).
- **Memory.** One entry per text a note has on screen, or had within the window, and per note; the
  entries of texts no longer loaded go a window after the last unload. A text shown again by a block
  made before the last one was unloaded keeps the run its first block was made in. One shown again
  after a gap keeps the time it was on screen before apart, the last such time only, so that a burst
  begun in the gap does not find it: the first build took the two times for one, and a text a Reading
  view let go before a pause, then shown again after an undo, was said to be on screen as the undo
  came (found in review).

How each place a diagram is drawn comes out, a block that misses the cache:

| | beta.6 (D39) | now |
| --- | --- | --- |
| A start: the reset, then every block made again 103 ms later | waits 300 ms | no wait: a block made again joins the compile under way for the block it replaced, or finds it cached |
| The iPhone: a note opened, the reset 23 ms after its blocks | no wait | no wait |
| A note switched away from and back within the second after an edit of it | waits | no wait for a text it showed |
| Live Preview, one pane: the widget drawn as the cursor leaves the fence | waits | waits: a text the note did not have |
| A second pane, a Reading view beside the editor, an embed: made again after each keystroke | waits | waits: each text first shown once the burst began |
| A sync, or another program, changing a block of a note on screen | waits | waits |
| Undo, or typing back to a text the burst made | waits | waits |
| Undo, or a sync, back to the text shown before the burst | waits | no wait; normally cached |
| Another plugin making the widgets again within the second after a real edit | waits | no wait for the texts that did not change |
| Typing beside a diagram on an error card, or never cached, in the same list, callout or blockquote of a Reading view or embed, or callout of a second pane | waits, and the next keystroke lets it go | waits, as in beta.6 |
| A start where a diagram had already come to rest on an error card before it was made again | waits 300 ms | waits 300 ms |
| A block first shown within the second after the reset, as by scrolling right after opening | waits | waits (not covered) |
| An export, `lazy=off`, "Render all diagrams in this note", a button | unchanged | unchanged |

A block made again whose text is not cached is one whose compile is under way, which it joins
(queue dedup), or one whose last block came to rest without its diagram in the cache, which waits as
in D39. Reading view and an embed keep a section whose text did not change (`parseFinish` reuses
sections by their text, read in the bundle), so typing in another section of the note does not make
a block again; typing in its own section does, and a section is a whole list, callout or blockquote.

**What the diagnostics now say.** The waited step of a block an edit did not make wait, as its note
already showed it: "waited 0 ms; the note was edited 103 ms before the block was made, which did not
count: the note already showed this diagram", or "… as the block was made, which did not count: …"
(`BlockEdit.shown`).

**What it does not cover.** An edit that changes nothing is still an edit: a block first shown within
the second after the reset, as by scrolling right after a note opens, waits the debounce. Telling
such an edit apart needs the editor's own update, comparing the documents before and after it,
through an editor extension and Obsidian's `editorInfoField`, which `editor-change` does not carry;
not done. A diagram that came to rest on an error card before a start made it again waits too, as
it did in beta.6. Nor is it measured on the desktop: whether the first diagrams after a start now
say "waited 0 ms … which did not count" is for the maintainer's next start.

Tests: `test/edits.test.ts` (made again with the old block unloaded in the run that makes the new
one, in the edit's own run, or after the new one; made before the edit and loaded after it; a text
first shown once the burst began, through four keystrokes beside the editor, back to a text they made
and back to the one before them; a block made in the run of the burst's first edit; the burst from
its first edit, and a new one after a pause; an edit that named no note; any view of the note; the
note alone; forgotten a window after the last unload; an unload said twice; not a text let go of as
the edits began and shown again after; not a text whose last block came to rest without its diagram
cached, until one comes to rest with it), `test/processor.test.ts`
(both remakes at a start, through the processor, the block and the plugin's own `RecentEdits`, in
the order of things read in the bundle, and typing still waiting beside the editor or in an embed, in
a second pane in Live Preview and for a sync; a `nocache` block with no preamble to look for, made
again at a start and made by a keystroke; a diagram on an error card or never cached, in the
section typed in, not asked for while typing, in each of those three; the block's load, unload and
rest told, and whether the cache holds its diagram: drawn, on a card, `nocache`, a button, a cache
hit), `test/report.test.ts`.

### The iPhone drawing the small diagram at the top last

**What the phone said.** After a restart, a note opened with four diagrams in this order: a small
plain tikzpicture (#1), circuitikz (#2), pgfplots (#3) and pgfplotstable (#4), the three heavier with
runs stored from the session before. All four waited 0 ms, the note "edited 23 ms after the block was
made, which did not count" (24 for #1): D39's rule held. #2 was queued 0 ms and waited 36 of the
engine's 38 ms start; #3 was queued 150 ms, #4 257 ms, and #1, made first, 270 ms: seen to drawn 296
ms, against 170 for #2.

**Why.** The figures add up exactly. #2, #3 and #4 were submitted together, and #2 took the one slot
a phone has (D24) and waited in the host for the engine to start. #1 was submitted 39 ms later, 3 ms
after the engine had taken #2, and the queue ranked a band by order of submission alone, so #1 waited
behind #3 and #4 as well. A block is submitted after its cache read and the viewport gate (D22, D23),
and each cache read takes its own time. #1's was most likely the slowest because it alone may be read
in the old plugin's store, as a block that loads no package: the first such read of a session lists
IndexedDB's databases and opens that store (`cache/index.ts`). That is not measured. Of #1's 270 ms,
about 30 were the engine idle while #3's and #4's stored runs were read, which starts only once the
queue has started their jobs.

**What it does now** (`src/queue/queue.ts`, `src/block/processor.ts`, `src/block/render-child.ts`,
`src/block/machine.ts`):

- **Inside a band, by place in the note.** The processor numbers the blocks it makes, before anything
  yields, and the block gives its number to the queue (`SubmitOptions.place`). Obsidian makes a view's
  blocks from the top down, Live Preview's widgets and Reading view's sections alike, so the block
  made first is the highest. Inside a band the queue starts the lowest number first, then the one
  submitted first; a job two blocks want takes the lower of their numbers; a job the engine was
  stopped under still goes ahead of its band; a caller that gives none comes after those that do. The
  depth cap turns away, in the least urgent band, the lowest in the note, then the newest, where it
  turned away the newest.
- **A started job the engine does not have yet gives its slot to a more urgent one.** This is D25's
  window: started, the runner not having said that the engine has the job, nothing paid for. When a
  more urgent job waits and no slot is free, the least urgent job in that window goes back in line
  with its band, place and turn, and counts against the depth cap again. The more urgent job is
  started first and the other's signal aborted after, with `cancelled`, so that the host, still
  starting an engine for the one, finds the other waiting for it; otherwise a WebView without
  `AbortSignal.reason`, which cannot tell a cancel from a stall, would stop the start (D25). A runner
  that says the engine has a job after it gave its slot up is ignored. The job's block stays in
  COMPILING, the queue tells it again when the job starts again, and its queue time runs to the last
  start; a block that had joined the job while it held its slot no longer says that it joined a
  compile under way, as the compile it waits for began after it asked (found in review). Turned away afterwards, by the depth cap or the plugin unloading, the block rests on its
  "Render diagram" button, as from SCHEDULING (`machine.ts`); before, a rejection could reach a block
  in COMPILING only once it was unloaded.

**Simulated**, not measured on a phone: the real `RenderQueue` and `WorkerHost`, with a worker, stored
runs and one clock that take the iPhone's own figures (`test/support/order-sim.ts`). Queue time / seen
to drawn, in ms:

| | | #1 | #2 | #3 | #4 |
| --- | --- | ---: | ---: | ---: | ---: |
| As observed: #1 39 ms after the others, the engine's start 38 ms | beta.6 | 267 / 290 | 0 / 166 | 147 / 256 | 254 / 308 |
| | now | 108 / 131 | 0 / 166 | 169 / 278 | 276 / 330 |
| #1 20 ms after the others, while the engine starts | beta.6 | 286 / 309 | 0 / 166 | 147 / 256 | 254 / 308 |
| | now | 0 / 39 | 58 / 204 | 185 / 294 | 292 / 346 |
| An engine that starts in 900 ms, as without the JIT | beta.6 | 1,129 / 1,152 | 0 / 1,028 | 1,009 / 1,118 | 1,116 / 1,170 |
| | now | 0 / 882 | 920 / 1,066 | 1,047 / 1,156 | 1,154 / 1,208 |
| A computer with two engines, as observed | beta.6 | 108 / 131 | 0 / 166 | 0 / 124 | 122 / 176 |
| | now | 83 / 106 | 0 / 166 | 0 / 124 | 144 / 198 |

The simulation gives the phone's queue times within 3 ms, and its seen to drawn within 6. As observed, #2 was in the engine
before #1 asked, and the order in the note is what helps; giving up the slot helps whenever the top
diagram asks while the engine is still starting. A job that gave its slot up has its stored run read
again when it starts again, with the engine idle: #2's 16 ms in the second case. The note's last
diagram is drawn 22 to 38 ms later; the work is the same.

**What else it touches.**

- **The bands are as they were**: an export ahead, a fast diagram one band up, a job the engine was
  stopped under ahead of its band. An export can now take the slot of a block in view whose job is
  still waiting for the engine.
- **In view and near are not told apart.** The viewport gate counts a block within its margin, 400 px
  on a phone and 200 on a computer, as in view, the machine gives it band 1, and `priority()` reads
  the same flag; band 2 goes only to a `lazy=off` block and to one scrolled away during its debounce.
  A block in the margin above the view is made first, and goes first. Telling them apart, band 1 only
  for a block truly in view, is left for later.
- **Stored runs** are still read only once the queue has started a job, so with one engine every read
  is made with the engine idle; reading ahead for the next job is left for later.
- **A block made by scrolling up, or by typing,** is made later and goes later, as it did.

**Not measured on a phone.** Whether #1's cache read was slow for the old plugin's store: a step in
the diagnostics timing the cache read would say.

Tests: `test/queue.test.ts` (a band by place, then by submission; a job's highest place; a resumed job
ahead of every place; the depth cap turning away the lowest in the note; the slot going to a more
urgent job, the one that had it starting after it, in a band or across bands, from the least urgent of
two; never from a job the engine has, nor to one no more urgent; the depth cap counting the job put
back, also once the queue resumes; a waiting job promoted by a second caller; a late `running`
ignored; a job put back released, started again at once, or dropped as the queue closes; not while
paused; the randomised interleavings unchanged), `test/order.test.ts` (the phone's note, as beta.6
had it and now, early and late, on a slow engine, where `AbortSignal` has no reason, with two
engines), `test/processor.test.ts` (the note through the processor, the block and its machine and the
real queue), `test/machine.test.ts` (COMPILING turned away), `test/render-child.test.ts` (the queue
time to the last start, also for a block that joined the job before it gave its slot up, and the
place handed to the queue).

**What it costs.** `main.js` grows by 1,814 bytes for the first half, and 233 for the order in the
note and 727 for the slot: 2,774 in all, from 0.2.1-beta.6's 12,230,424. The worker does not change,
nor does anything `test/fixtures/golden/REVISION.json` records: diagrams draw as before, and stay
cached.

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
