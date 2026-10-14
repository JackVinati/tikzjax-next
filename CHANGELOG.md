# Changelog

What changed in each release, newest first. The release workflow puts a version's section at the
top of its notes on GitHub, and will not publish a version that has none.

## 0.2.1 — unreleased

- Updating recompiles nothing: every diagram cached by 0.2.0 is shown from the cache, as before.
  From this release on, the cache is tied to what the engine draws rather than to the exact build of
  it, so a release that only makes the engine faster no longer compiles every cached diagram once
  more. A release that changes what diagrams look like still does, and says so here.
- The diagnostics view shows the rest of a diagram's wait: how long it waited between coming into
  view and being handed to the engine, how long it took to be drawn in the note once its SVG was
  ready, and the whole time from coming into view to drawn. It also says how many times the engine
  started this session, how long each start took, and why it stopped. A Copy button copies the
  whole view as text, for a bug report: the plugin and Obsidian versions, the kind of device, what
  its WebView supports, the engine, and every step's time, and none of your diagrams' code, error
  messages or note names. Where the device does not let the plugin copy, the text appears
  selected, to copy by hand.
- A diagram that is not cached goes to the engine as soon as it comes into view. Until now each
  one waited first, half a second on a phone and 300 ms on a desktop, also when you had just
  opened the note. Only a diagram in a note you are typing in still waits for you to pause, so that
  typing in it, in a second pane or beside a Reading view, compiles it once per pause and not at
  every keystroke.
- The TeX engine starts as soon as a diagram turns out not to be in the cache, while the diagram is
  still on its way into view, instead of when it is about to be compiled. It still never starts
  when every diagram shown is cached, and an engine started for a diagram you never scroll to stops
  again once it has had nothing to do for a while, as before.
- On a computer, two diagrams compile at once when several new ones are waiting, each in a TeX
  engine of its own. Handed a note of 37 new diagrams at once, two engines drew them all in 45–46%
  less time than one, in WebKit and in Chromium, measured on a Windows desktop with this release's
  engine; a note you scroll through one diagram at a time gains less. The second engine starts only
  while diagrams wait, takes about 100 MB more while it runs, and stops with the first. Phones and
  tablets keep one engine, and so does a computer with less than 8 GB of memory; Settings → Second
  engine turns it off.

## 0.2.0 — 2026-10-13

- After updating, every cached diagram is compiled once more, the next time it is shown: the
  engine's id is part of the cache key, and it changed. Diagrams that rendered before come out the
  same, byte for byte, apart from the changes below.
- TeX runs in a little over half the time: over the 26 diagrams 0.1.5 was tested with, its time went
  from 4.6 s to 2.5 s, measured in Node, which runs JavaScript and WebAssembly with the same
  engine as Obsidian on the desktop. The engine no longer carries asyncify, machinery in every
  function that 0.1.5 no longer used and still paid for, and TeX looks up its macros in a table
  spread wider, with shorter searches.
- The TeX engine starts about three times as fast and needs far less memory. Most of its 156 MiB
  starting image is zeros, and now only the rest ships, is unpacked when the engine starts, and is
  copied into each compile. Measured on a Windows desktop in Node 22, whose JavaScript engine (V8)
  is the one Obsidian's desktop app runs: starting 529 → 161 ms, buffers held once started 157.5 →
  23.5 MiB, the most memory the process took over five compiles 703 → 168 MiB, and each compile
  about 20 ms quicker to set up. With both changes, a small diagram compiles in 27 ms where it took
  61, once the engine is running. Nothing has been measured on an iPhone or iPad yet.
- A diagram on which TeX gives up, with "TeX capacity exceeded" from a macro that never stops
  expanding, an emergency stop, or a hundred errors, now fails at once with TeX's message, instead of
  waiting out its time budget and being reported as too slow. That includes a `\usepgfplotslibrary`
  the engine does not have. A diagram that switches TeX to `\batchmode`, which keeps TeX's messages
  off the terminal, gets its error from TeX's transcript file instead of "TeX produced no output",
  and a page TeX shipped before giving up is still drawn. Something nested a few thousand deep can
  run out of the engine's own stack before TeX reaches a limit of its own; that is now reported as
  TeX running out of room instead of "TeX produced no output", though TeX says nothing about it and
  a page it shipped before is lost.
- `~` is a non-breaking space, as in LaTeX. Until now every `~` in a diagram gave three TeX errors
  and drew a stray tilde before its space, because the engine lacked the `\ifincsname` primitive
  LaTeX's `~` asks for. A node with `Fig.~1` now comes out as TeX Live's own `latex` sets it.
- Accented letters work where LaTeX makes a name of them: in a node or coordinate name, a style
  name, a `\label` key and its `\ref`, and an `\edef`. With `\ifincsname` LaTeX loads its current
  UTF-8 support instead of the one from before 2019, under which each of these gave "Missing
  \endcsname inserted" or a run of other errors. Most such diagrams failed; one with an accented
  `\label` was drawn with the errors, and now comes out without them, and so differently.
- A diagram that loads a package the engine does not have is drawn without it, as LaTeX goes on
  when you press Return at its prompt, and LaTeX's "File `x.sty' not found" is shown on the
  diagram. Until now the engine told LaTeX that every file existed and read a missing one as empty,
  so nothing said which package was missing, and anything it defines failed further down as an
  undefined control sequence. A diagram that loads a package it never uses, such as `inputenc` or
  `amsthm`, is drawn as before, with that message on it. An `\input` of a file the engine does not
  have now stops the diagram at once, with LaTeX's message, where it used to be read as an empty
  file.
- `pgfplotstable` loads, as the README has said it does. Only its `.sty` was bundled, and that
  reads two files that were not, so a diagram that loaded it never finished.
- The diagnostics view shows, under each diagram compiled, where its time went: waiting for other
  diagrams, waiting for the engine to start, setting up TeX's memory, TeX itself, turning TeX's
  output into SVG, and preparing that SVG for the note.

## 0.1.5 — 2026-10-13

- After updating, every cached diagram is compiled once more, the next time it is shown: both the
  engine's id and the SVG pipeline's revision are part of the cache key, and both changed. Diagrams
  that rendered before come out the same. The original TikZJax plugin's cache is still read where
  there is one.
- Letters with a dieresis (ä, ö, ü, also written as `\"u`), `Ł` and `ł`, and symbols such as
  `\spadesuit` no longer make the whole diagram fail. Nor do `°` `×` `±` `µ`, arrows, `™`, `§`,
  daggers, bulleted lists and siunitx's units such as `\degree`, `\micro` and `\ohm`; they are
  drawn from the math fonts, so `µ` comes out as the italic math `μ`. Nor do `£` `€` `©` `®` `ª`
  `º`, `\pounds`, `\copyright` and `\$` in a label, built from the Computer Modern text fonts; `€`
  is a C with a small `=` across it, LaTeX's own stand-in for a font without a euro.
- Exporting a note to PDF finishes within about a minute however many diagrams are uncached, with
  a short note in place of any that was not ready, and never a "Render diagram" button in the PDF.
  The same diagram shown twice, in two panes, a hover preview or an export while it compiles, no
  longer leaves one copy spinning forever.
- On iPhone and iPad, switching away while a diagram compiles no longer turns it into a "took
  longer than its time budget" error: it finishes when you come back. Diagrams no longer all
  recompile after the app returns, and the engine needs about half the memory while starting.
- Timeouts are fairer: starting the engine no longer counts against the first diagram, a slow
  diagram can no longer make the one next to it time out or fail, Retry on a timed-out diagram
  really runs it again, and any settings change gives timed-out diagrams another chance.
- Error cards say what happened — timed out earlier, an empty block, the undefined macro by name —
  and point at the right line when a preamble file has several lines, or at the preamble file and
  its line when that is where TeX stopped. After Retry or "Render diagram", the old card or button
  no longer stays under the diagram.
- Settings take effect at once, also when another device changes them through Sync. A new Preamble
  section sets the vault-wide preamble file, with file suggestions, and the folder preamble's name.
  Editing a preamble file updates Live Preview as well as Reading view.
- `scale=` and `width=` enlarge a diagram as well as shrink it, `scale=` applies the first time a
  diagram renders, and a reopened note keeps every diagram correctly framed.
- Colour modes: `colors=invert` or `preserve` on one diagram, or a change of the setting, no longer
  gives other copies of that diagram the wrong colours; invert no longer turns ink dark in a dark
  theme; and the zoom view shows a diagram in its own mode, without white shapes turning solid.
- Copy SVG, Save SVG, Finalize and the zoom view find the diagram at the cursor, even after a
  restart and in a list item in Live Preview, and Finalize puts each picture above its own diagram.
  Copy SVG, Save SVG and the zoom view also work in a blockquote or a callout. A diagram in a list
  item is compiled once for Live Preview and Reading view, not once for each. "Render all diagrams
  in this note" finishes, can be stopped, and says truthfully how many rendered; the diagnostics
  view shows each diagram's real outcome.
- Fast mode renders ahead of other diagrams; `%!tikz svgo=off` and the svgo setting really turn
  SVG optimisation off.
- Safer: diagrams can no longer carry stylesheets, external images or other active markup into a
  note, output that cannot be made safe is never shown or cached, and a diagram the sanitizer took
  something out of says what. Ordinary TikZ output is unchanged.
- The diagram cache keeps an exact count of its size instead of filling with phantom bytes and
  then emptying itself, and a cache hit does less storage work. "Reuse the previous plugin's
  cache" applies as soon as it is switched on.
- Pop-out windows no longer render every diagram at once as though they were a PDF export. Long
  sessions no longer hold on to closed tabs, hover previews and finished export windows, and
  disabling or updating the plugin no longer leaves the engine running.
- `main.js` and `styles.css` carry the licences of the libraries and fonts they embed, and say
  where the source is.
- The licence notices are corrected. The fonts are Basil K. Malyshev's BaKoMa Type 1 conversions of
  the Computer Modern, AMS, Euler and LaTeX designs, and `NOTICE` now says so, with the BaKoMa
  licence in `vendor/LICENSES/` and the CTAN location it requires. `NOTICE` also lists every TeX
  package the engine bundles, and the two npm packages `buffer` brings in, `base64-js` and
  `ieee754`; their licence texts are in `vendor/LICENSES/npm/`.
- The README starts from what someone new needs: what the plugin does, installing, writing a
  diagram, the `%!tikz` options (now including `preamble`, `twopass` and `wrap`), shared preambles
  and how they are cached, a list of questions that come up, and every bundled package and TikZ and
  pgfplots library, checked against the engine by a test.
- New: `CONTRIBUTING.md`, `SECURITY.md` (private vulnerability reporting), issue forms for bugs and
  package requests, and a pull request checklist.
- Releases run CI's whole gate on the tagged commit before publishing, and publish from a separate
  job that is the only one allowed to write. Their notes start with the section from this file.
- CI renders every test fixture through the engine and reports test coverage. Dependabot proposes
  dependency updates weekly, and the Engine workflow warns when an engine pin falls behind upstream
  or its Node line nears end of life.
- Development: typescript-eslint 8.71.2; `svgo`, which nothing used, is removed; `buffer` is pinned
  exactly; Node `^22.13.0 || ^24.0.0 || >=26.0.0`, which is what ESLint 10 and Vitest 5 accept.

## 0.1.4 — 2026-10-12

- Fewer false warnings. The bundled-library check reported `arrows.meta`,
  `decorations.pathreplacing`, `shapes.geometric` and others as missing under diagrams that rendered,
  because its file list stayed empty until the engine started, and a note served from the cache
  never starts it. The list now ships with the plugin.
- The character check uses a set measured from the engine itself (`npm run scan:native`, checked in
  CI), so it only warns about characters that really fail: Greek, Cyrillic and CJK outside math,
  `°` `×` `€` `™` `→` in text, and letters with a dieresis. The warning suggests the math form.
- A diagram with a dieresis, typed or written as `\"u`, still fails, but the error now says why and
  what to change, instead of an unexplained font metric error.
- Every cached diagram is compiled once more after updating, because the cache key now covers every
  engine source file. The output is the same.
- The engine image builds byte for byte the same on any machine (the cause was Perl's hash order in
  `language.dat`), on Node 22.23.3 from nodejs.org, checked by SHA-256. Dependencies updated, Vitest
  5 among them; GitHub Actions moved to current versions, pinned by commit; a typing fix for the
  store review, which lints with TypeScript 5.

## 0.1.3 — 2026-09-02

- Installs on mobile. `minAppVersion` was 1.13.0, for an API the plugin never called, and Obsidian
  for iOS was still on 1.12.7. It is now 1.7.2, derived from the APIs the plugin uses and checked by
  a lint rule that compares every call against it.
- Reproducible: building this tag on any machine produces the same `main.js` and `styles.css` as
  the published assets.

## 0.1.2 — 2026-09-02

- Builds from a clean checkout. The compressed TeX engine is committed, so `npm run build` needs
  neither Docker nor fifteen minutes; the community store's build verification failed on exactly
  that.
- The engine build is reproducible (the TeX clock is pinned, gzip is called with `-n`), so CI
  rebuilds it and diffs it against what is committed. The engine id no longer depends on the line
  endings of the checkout.
- From the store review: `buffer/` rather than `buffer`, and `createSvg` for the accessible-name
  `<title>`, which has to be in the SVG namespace to name anything.

## 0.1.1 — 2026-09-01

- Fixes the plugin failing to load on iOS. A regular expression used a lookbehind, which
  JavaScriptCore rejects before Safari 16.4, so the whole bundle failed to parse; two Safari 15.4
  methods would have thrown later. The production build now refuses to emit a bundle containing
  anything iOS cannot run.
- From the store's automated review: `setCssStyles` for real CSS properties, `createEl` for a
  `<style>` element, `setDestructive` for the cache-clearing button, `buffer` as a direct
  dependency, and build provenance attestations on the release assets.

## 0.1.0 — 2026-09-01

- First release: a rebuild of the Obsidian TikZJax plugin around a TeX engine built from source
  rather than vendored as an opaque blob.
- Cached diagrams paint in the same frame as the text, with no recompilation on a theme change.
- TeX errors are reported with the offending line instead of a broken-image icon, and one bad
  diagram no longer blocks every later one.
- PDF export waits for the diagrams and pins black on white.
- 245 TeX files, including pgfplots 1.18.1 with its libraries, circuitikz, chemfig, forest,
  mathtools, xparse and the expl3 layer.
