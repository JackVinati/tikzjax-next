# Changelog

What changed in each release, newest first. The release workflow puts a version's section at the
top of its notes on GitHub, and will not publish a version that has none.

## 0.2.1-beta.5 — 2026-10-15

The figures below were measured on my Windows desktop, in headless Chromium, the browser engine of
Obsidian's desktop app, and WebKit, the browser engine of the iPhone and iPad, through Playwright
rather than in Obsidian; where they compare with 0.2.0, it is 0.2.0 as released. None of them is
from a phone.

- Updating from 0.2.0 compiles again only the diagrams that contain a character the engine has no
  font for, such as Chinese, Greek or Cyrillic, so that their labels show it, and the diagrams under
  a preamble file that ends with a comment and no newline (below). Every other diagram 0.2.0 cached
  is shown from the cache. Updating from 0.1.x compiles every cached diagram once more, the next
  time it is shown, as 0.2.0 did. From this release on the cache is tied to what the engine draws
  rather than to the exact build of it, so a release that only makes the engine faster no longer
  compiles every cached diagram again; one that changes what diagrams look like still does, and says
  so here.
- A diagram that is not cached goes to the engine as soon as it comes into view. 0.2.0 made each one
  wait first, 300 ms on a computer and half a second on a phone, also when you had just opened the
  note. Only a diagram in a note you are typing in still waits for you to pause, so that it compiles
  once per pause and not at every keystroke. The TeX engine also starts as soon as a diagram turns
  out not to be cached, while the diagram is still on its way into view; it still never starts when
  every diagram shown is cached.
- TeX takes about a third less time. Over the 37 test diagrams 0.2.0 was released with, the fastest
  of seven runs each, TeX's time went from 2,827 to 1,850 ms in Chromium and from 4,210 to 2,772 ms
  in WebKit, and each diagram took 29% to 63% less in Chromium and 25% to 54% less in WebKit. The
  engine is compiled so that TeX keeps the values it works on where the processor reaches them
  directly, rather than in its memory; it is optimised with a newer binaryen; and its calls into the
  plugin, for every line and character TeX reads or prints, no longer make new arrays each time.
  Every test diagram 0.2.0 had draws as it did then, byte for byte; what draws differently is labels
  in other scripts and the two fixes below.
- The engine starts in a third of the time: 54 ms instead of 162 in Chromium and 57 instead of 152
  in WebKit, medians of seven starts. The plugin hands the engine its files when it starts it,
  instead of carrying them inside the engine's own code, and the engine unpacks them with the
  system's own decompression where there is one, from iOS 16.4 on.
- Saved preambles. A diagram whose preamble an earlier diagram has already compiled, with the same
  packages, libraries and preamble text, starts where that one stood once its `\begin{document}` was
  done, and TeX compiles only its body. That is every diagram after the first with the same
  preamble, the blocks of a note that are only a `tikzpicture` among them, and a diagram you are
  typing in, each time it compiles again. Drawn a second time in a row, circuitikz took 64 ms of TeX
  in Chromium, siunitx 10 and plain TikZ 4, where 0.2.0 took 314, 133 and 18, and the 37 test
  diagrams 752 ms where 0.2.0 took 2,827. The first diagram of each preamble pays for saving it, 11
  to 13 ms in Chromium, and about a tenth of a second without the JIT. A diagram drawn this way is
  the same, byte for byte, as one drawn from the start, and every release checks that for every test
  diagram and for 33 cases written to break it. An engine keeps up to 32 MB of saved preambles on a
  computer, and 12 MB on a phone or tablet or on a computer that reports less than 8 GB of memory.
- Saved preambles are also kept in this device's own storage, in Obsidian's IndexedDB beside the
  diagram cache, never in the vault, so they are not synced with it. After the engine has stopped,
  after Obsidian restarts, or on a phone after the app was in the background, a diagram whose
  preamble is stored starts from it instead of loading its packages again. In WebKit with a phone's
  budgets, the first diagram after a fresh start of the browser, the engine's start included, took
  223 ms for circuitikz from its stored preamble where compiling the preamble took 426, and 153 for
  pgfplotstable where it took 358. Up to 64 MB are kept for each vault on a computer, and 16 MB on a
  phone or tablet or on a computer that reports less than 8 GB of memory, the preamble used least
  recently going first. Clearing the diagram cache deletes them too, which is the way to remove them
  from a device before uninstalling the plugin, since Obsidian does not tell a plugin it is being
  removed. [The README](https://github.com/JackVinati/tikzjax-next#stored-preambles) says what a
  stored preamble holds.
- Labels in Chinese, Japanese, Korean, Greek, Cyrillic, Arabic, Hebrew, Thai, Devanagari, IPA and
  emoji are drawn. The engine has no fonts for them, so TeX sets each character as a box one em wide
  and the plugin writes the character over it in your system's sans-serif font; nodes and arrows are
  placed around it as around any other text. 0.2.0 left each one out with "Unicode character … not
  set up for use with LaTeX". `¥` `¢` `‰` `½` `№` typed in a label, which made the whole diagram
  fail, are drawn the same way. In a `text width` node or a `\parbox` the text wraps: Chinese and
  Japanese between characters, though never before closing punctuation, and other scripts where a
  space is typed. Names in these scripts, of nodes, coordinates, styles, colours and `\label`s, work
  as they did in 0.2.0, and the pre-flight check no longer warns about any of these characters.
  [The README](https://github.com/JackVinati/tikzjax-next#known-limitations) lists what text drawn
  this way cannot do. Contributed by RepentStar in
  [pull request #2](https://github.com/JackVinati/tikzjax-next/pull/2).
- The diagnostics view times each diagram from coming into view to drawn in the note, with every
  wait on the way; says how many times the engine started, how long each start took and why it
  stopped; says of each diagram whether it started from a saved or stored preamble; and says whether
  TeX seems to run with the JIT compiler. Its Copy button copies all of it as text for a bug report:
  the plugin and Obsidian versions, the kind of device, what its WebView supports, the engine and
  every step's time, without your diagrams' code, their error messages or the names of your notes.
  Where the device does not let the plugin copy, the text is shown, to copy by hand.
- On a computer, two diagrams compile at once when several new ones are waiting, each in an engine
  of its own. Handed a note of 37 new diagrams at once, two engines drew them in 46 to 47% less time
  than one, in Chromium and in WebKit; a note you scroll through one diagram at a time gains less.
  The second engine starts only while diagrams wait, stops with the first, and took about 100 MiB
  more at the peak in Chromium. If it cannot start, the first carries on alone. Phones and tablets
  keep one engine, and so does a computer that reports less than 8 GB of memory.
- Two new settings: Second engine, on a computer, turns the second engine off; Saved preambles turns
  saved preambles off, on any device, and deletes the stored ones, should a diagram ever draw
  differently from one. Please report the diagram if one does.
- Without the JIT compiler, as with Lockdown Mode on an iPhone or iPad, TeX runs twenty to thirty
  times slower. The diagnostics view says whether TeX seems to run with the JIT: "on (probably)",
  "off (probably)" or "unclear". On an iPhone or iPad where two engine starts of a session have
  found it off, a notice says once that Lockdown Mode, if it is on, is the likely cause and how to
  exclude Obsidian from it. So that a phone that is only slow, in Low Power Mode or hot, is not
  taken for one without the JIT, the engine weighs its test against the rest of its own start, and
  takes it again a second later. Where Lockdown Mode turns WebAssembly off altogether, as it does on
  some versions of iOS, the diagram's card says so, where it said to close other apps.
- When the `main.js` a device runs is not the version its `manifest.json` says, the plugin says so
  once, with how to put it right, and the diagnostics view shows both versions. Obsidian Sync
  Standard can leave a plugin like this when it carries installed plugins: it copies the new
  `manifest.json` and not `main.js`, which is over its 5 MB limit. A `main.js` older than this
  release cannot tell, so the first update this catches is the one after 0.2.1;
  [the README](https://github.com/JackVinati/tikzjax-next#out-of-step) says what to do until then.
- The engine keeps one block of memory and, before each diagram, puts back only what the diagram
  before it changed, where 0.2.0 took a new 156 MiB block for every diagram and left the old ones
  for the browser to free when it got round to it. Over a run of 85 diagrams, the most memory the
  page had in use at once went from 318 to 278 MiB in Chromium and from 643 to 453 MiB in WebKit,
  medians of five runs. Right after the last diagram, with the engine waiting for the next, WebKit
  held more than with 0.2.0, 405 MiB against 226, because the engine keeps its memory and its saved
  preambles until it stops. On a phone it now stops after 15 seconds without a diagram, where 0.2.0
  waited 30.
- A preamble file that ends with a comment and no newline after it, as some editors save one, no
  longer swallows the `\begin{document}` the plugin writes after it, which made every diagram under
  it draw "Missing \begin{document}" instead of itself.
- A diagram that writes a file named like the metrics of a font the engine bundles, such as
  `eufm10.tfm`, no longer writes into that font for every diagram after it until the engine stops.
- A line longer than TeX's buffer of 300,000 bytes, such as thousands of definitions written on one
  line, fails with "TeX cannot read a line longer than its buffer of 300,000 bytes.", where 0.2.0
  said "TeX nested deeper than the engine's stack allows.". Written a line each, the same
  definitions draw.
- This release's engine leaves TeX less room to nest in Chromium: 1,621 `\number` nested inside each
  other still draw where 0.2.0's engine drew 2,344, and 19,950 in WebKit, where it drew 20,049 to
  21,281. Something nested deeper fails with "TeX nested deeper than the engine's stack allows.", as
  it did past the old limit. The deepest real diagrams tried draw as before: a `forest` tree 80
  levels deep, 4,000 groups inside each other and a plot of 2,000 coordinates, which are now among
  the diagrams every release is tested with. Neither an iPhone nor an Android device has been
  measured.

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
