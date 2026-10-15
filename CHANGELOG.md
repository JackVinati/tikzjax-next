# Changelog

What changed in each release, newest first. The release workflow puts a version's section at the
top of its notes on GitHub, and will not publish a version that has none.

## 0.2.1-beta.4 — 2026-10-15

- Updating from 0.2.0 recompiles only the diagrams that contain a character the engine has no font
  for, such as Chinese, Greek or Cyrillic, so that their labels show it (see the next point); every
  other diagram 0.2.0 cached is shown from the cache, as before. Updating from 0.1.x compiles every
  cached diagram once more, the next time it is shown, as 0.2.0 did. From this release on, the cache
  is tied to what the engine draws rather than to the exact build of it, so a release that only
  makes the engine faster no longer compiles every cached diagram once more. A release that changes
  what diagrams look like still does, and says so here.
- Labels in Chinese, Greek, Cyrillic, Arabic, Hebrew, Thai, Devanagari, IPA and emoji are drawn.
  The engine has no fonts for them, so TeX sets each character as a box one em wide, and the
  plugin writes the character over it in your system's sans-serif font; nodes and arrows are
  placed around it as around any other text. Until now TeX left each one out with "Unicode
  character … not set up for use with LaTeX". `¥` `¢` `‰` `½` `№` typed in a label, which made the
  whole diagram fail, are drawn the same way. In a `text width` node or a `\parbox` the text
  wraps: Chinese and Japanese between characters, though never before closing punctuation, and
  other scripts where a space is typed. Names in these scripts, of nodes, coordinates, styles,
  colours and `\label`s, work as they did in 0.2.0. The README lists what the text drawn this way
  cannot do. From pull request #2.
- Pre-flight no longer warns about characters the engine cannot typeset, in a label or in a name:
  the engine, its stand-ins for `°` `×` `£` `€` and the rest, or the sans-serif text above now draw
  every one of them, and names in any script work since 0.2.0. In maths, TeX's own `$\alpha$`
  still gives Computer Modern's α, where a typed `α` is drawn upright in sans-serif.
- The diagnostics view shows the rest of a diagram's wait: how long it waited between coming into
  view and being handed to the queue, how long it took to be drawn in the note once its SVG was
  ready, and the whole time from coming into view to drawn. It also says how many times the engine
  started this session, how long each start took, and why it stopped. A Copy button copies it as
  text for a bug report: the plugin and Obsidian versions, the kind of device, what its WebView
  supports, the engine, and every step's time, without your diagrams' code, their error messages or
  the names of your notes. Where the device does not let the plugin copy, the text is shown, to copy
  by hand.
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
  engine of its own. Handed a note of 37 new diagrams at once, two engines drew them all in 46–47%
  less time than one, in WebKit and in Chromium, measured on a Windows desktop with this release's
  engine; a note you scroll through one diagram at a time gains less. The second engine starts only
  while diagrams wait, and stops with the first; in that note it took about 100 MiB more at the
  peak in Chromium, the browser engine of Obsidian's desktop app, measured on the same desktop. If
  it cannot start, the first carries on alone. Phones and tablets keep one engine, and so does a
  computer that reports less than 8 GB of memory; Settings → Second engine turns it off.
- TeX takes about a third less time. Over 37 of the diagrams the plugin is tested with, measured on
  a Windows desktop against 0.2.1-beta.1, TeX's time went from 4.2 s to 2.8 s in WebKit, the
  browser engine of the iPhone and iPad, and from 2.8 s to 1.8 s in Chromium, the one Obsidian's
  desktop app is built on. Each of the 37 took at least 28% less in both, comparing each one's
  fastest of seven runs, but the first diagram after the engine starts only 11 to 16% less. Most of
  it is the engine, now compiled so that TeX keeps the values it works on where the processor
  reaches them directly, rather than in its memory, and optimised with a newer binaryen. The
  engine's calls into the plugin, for every line and every character TeX reads or prints, no longer
  make new arrays each time, which on its own took about 4% off. Every diagram draws as before, byte
  for byte, so none is compiled again for this. `main.js` is 60 KB smaller than 0.2.0's, and 72 KB
  smaller than 0.2.1-beta.1's. Nothing has been measured on a phone yet.
- This release's engine leaves TeX less room to nest. Measured on the same desktop, 1,621 `\number`
  nested inside each other still draw in Chromium, where 0.2.1-beta.1 drew 2,344, and 19,950 in
  WebKit, where it drew between 20,049 and 21,281, depending on what it had compiled before.
  Android runs the same JavaScript engine as the desktop app, and neither Android nor an iPhone has
  been measured. Something nested deeper fails with "TeX nested deeper than the engine's stack
  allows.", as it did past the old limit. The deepest real diagrams tried draw as before, a `forest`
  tree 80 levels deep, 4,000 groups inside each other and a plot of 2,000 coordinates among them,
  and those three are now among the diagrams every release is tested with.
- A line longer than TeX's buffer of 300,000 bytes, such as thousands of definitions written on one
  line, fails with "TeX cannot read a line longer than its buffer of 300,000 bytes." Since 0.2.0 it
  failed with "TeX nested deeper than the engine's stack allows.", which pointed at the wrong thing.
  Written a line each, the same definitions draw.
- The TeX engine starts in well under half the time. Measured on a Windows desktop, from 145 to
  57 ms in WebKit and from 160 to 51 ms in Chromium. The plugin now hands the engine its files when
  it starts it, instead of carrying them inside the engine's own code, which every start had to read
  through first, and the engine unpacks them with the system's own decompression where there is
  one, from iOS 16.4 on. With that and the system's base64 decoding hidden from it, as on iOS 14.5
  to 16.3, the start went from 155 to 114 ms in WebKit on the same desktop. The diagnostics view
  shows, beside each engine start, how long unpacking and compiling took inside the engine, and
  whether the system's decompression and base64 decoding were used. Nothing has been measured on a
  phone yet.
- The engine keeps one block of memory for TeX and, before each diagram, puts back only what the
  diagram before it changed. It used to take a new 156 MiB block for every diagram and leave the
  old ones for WebKit or Chromium to free when they got round to it. With this release's other
  changes to the engine, over a run of 85 diagrams on the same desktop against 0.2.1-beta.1, the
  most memory the page had in use at once went from 645 to 423 MiB in WebKit and from 318 to 235 MiB
  in Chromium, and the most it had committed from 2,954 to 1,754 MiB and from 939 to 582 MiB.
  Measured change by change, the one block alone took WebKit from 451 to 423 MiB and from 2,174 to
  1,755 MiB committed, most of the rest coming with the calls that no longer make new arrays; in
  Chromium it did most of it. What the page still held right after the last diagram, with the
  engine waiting for the next, went down in Chromium, from 272 to 195 MiB, but up in WebKit, from
  226 to 378 MiB, and from 575 to 1,423 MiB committed: the engine keeps its block while it waits,
  and the new blocks it takes after a diagram TeX gave up on still wait for the collector. On a
  phone the engine stops after 30 seconds without a diagram, and that gives it all back. After a
  diagram TeX gave up on, with an emergency stop or "TeX capacity exceeded", the next one starts
  from a new block; the diagnostics view says "new memory" for it, and "memory reset" for the
  others. Every release now checks, after each diagram of the test set in five different orders,
  that the block TeX is handed is the same as a new one, byte for byte.
- Neither the faster start nor the one block of memory changes what a diagram looks like, so nothing
  cached is compiled again for them.
- A diagram whose preamble an earlier diagram has already compiled starts where that one stood once
  its `\begin{document}` was done, and TeX compiles only its body. That is every diagram after the
  first with the same packages, libraries and preamble text, the blocks of a note that are only a
  `tikzpicture` among them, and a diagram you are typing in, each time it is compiled again. The
  first diagram of each preamble takes a few milliseconds more, to save where TeX stands, and about
  a tenth of a second without the JIT. Measured on a Windows desktop in headless WebKit and Chromium
  against 0.2.1-beta.2, with the 32 MB a computer keeps, rendering each of the 44 test diagrams
  twice in a row, the second took 35% less TeX time in WebKit, the browser engine of the iPhone and
  iPad, and 34% less in Chromium, the one of Obsidian's desktop app: a plain TikZ diagram 6 ms
  instead of 17 in WebKit and 4 instead of 11 in Chromium, circuitikz 101 instead of 298 and 61
  instead of 194. With the 12 MB a phone keeps, in WebKit, it took 21% less, as three of those
  preambles did not fit beside the others. The first diagram after the engine started took 49 ms
  instead of 40 in WebKit and 45 instead of 34 in Chromium, of which saving its preamble was 9 and
  12 ms. A note of 74 diagrams, 37 test diagrams twice each, one after the other, on one engine,
  took 27% less time in WebKit and 25% less in Chromium with 32 MB, and 18% less in WebKit with 12
  MB; spread out, every diagram and then every one again, it took about as long as before, 3% less
  in WebKit and 1.5% more in Chromium, because one engine's budget does not hold all of its
  preambles. The most memory the page had in use at once grew by more than the budget, by 25 to 42
  MB in WebKit with 12 MB: what a save copies and what is let go wait for the collector. Without the
  JIT, as with Lockdown Mode on an iPhone, with 12 MB, a save took about a tenth of a second on the
  same desktop, and the second render of pgfplots 3.0 s of TeX instead of 7.2; circuitikz's preamble
  did not fit there beside two others. A diagram drawn this way is the same, byte for byte, as one
  drawn from the start: every release now checks that for every test diagram and for 33 cases
  written to break it, with TeX's log kept and without, and a preamble that reads the diagram's own
  file is never saved. An engine keeps up to 32 MB of saved preambles on a computer and 12 MB on a
  phone or tablet, or on a computer that reports less than 8 GB of memory, and lets them go when it
  stops. A preamble that does not fit beside the ones being used is not kept, and pushes none of
  them out. Nothing has been measured on a phone yet.
- With two engines on a computer, a diagram goes to the engine that holds its preamble when that one
  is free. In the notes above that made no measurable difference: two diagrams of one preamble next
  to each other start together, one on each engine, so neither has a saved preamble to start from.
  Two engines with saved preambles took from 2% more to 2% less time than beta.2's two with the
  diagrams in pairs, and 8 to 12% less spread out.
- Settings → Saved preambles turns saved preambles off, on a phone or tablet as on a computer,
  should a diagram ever draw differently from one: the README says more. Please report the diagram
  if one does.
- The diagnostics view says of each diagram whether it started from a saved preamble, or saved its
  own and in how long, or saved it and did not keep it for want of room, and of each engine how many
  preambles it holds, in how many MB, and how many saves failed; Copy includes it.
- The TeX engine is rebuilt with the point where a diagram is saved. Nothing draws differently, so
  nothing cached is compiled again.
- The diagnostics view says whether TeX seems to run with the JIT compiler on your device: "on
  (probably)" or "off (probably)". The engine times a short loop when it starts, which took a
  millisecond or less with the JIT on an idle Windows desktop, and in WebKit 36 ms at most with
  every core busy, and stops after about 13 ms without it. Without the JIT, as with Lockdown Mode on
  an iPhone or iPad, TeX is about twenty times slower; there the view says that Lockdown Mode, if it
  is on, is the likely cause and how to exclude Obsidian from it, with a link to the README, and a
  notice says so once, when two engine starts of a session have found the JIT off. On that desktop,
  in WebKit, Chromium and Node, idle and with every core busy, 425 starts with the JIT all said on
  and 53 without it all said off. Nothing has been measured on a phone yet.
- Where Lockdown Mode turns WebAssembly off altogether, as it does on some versions of iOS, the
  engine cannot start, and the diagram's card now says that the device runs no WebAssembly, what
  Lockdown Mode has to do with it and how to exclude Obsidian, where it said to close other apps;
  the diagnostics view says "no WebAssembly".
- When the `main.js` a device runs is not the version its `manifest.json` says, the plugin says so
  once, with how to put it right, and the diagnostics view shows both versions. Obsidian Sync
  Standard can leave a plugin like this when it carries installed plugins: it copies the new
  `manifest.json` and not `main.js`, which is over its 5 MB limit, so the device shows the new
  version and runs the old one. Where `manifest.json` is the older of the two, the plugin says that
  something brought an old one back instead. Only a `main.js` from 0.2.1-beta.3 on can tell; on a
  device whose `main.js` is older, the README says what to do.
- A diagram that writes a file named like the metrics of a font the engine bundles, such as
  `eufm10.tfm`, no longer writes into that font for every diagram after it until the engine stops.
- A preamble file that ends with a comment and no newline after it, as some editors save one, no
  longer swallows the `\begin{document}` the plugin writes after it, which made every diagram under
  it draw "Missing \begin{document}" instead of itself. Those diagrams are compiled once more, and
  no other.
- Saved preambles outlast the engine. Each preamble an engine saves is also kept in this device's
  own storage, in Obsidian's IndexedDB beside the diagram cache, never in the vault, so it is not
  synced with the vault, by Obsidian Sync or iCloud Drive. When the engine starts again, after
  Obsidian restarts, after the engine stopped for having nothing to do, or on a phone after the app
  was in the background, a diagram whose preamble is stored starts from it instead of loading its
  packages again. Measured on a Windows desktop in headless WebKit and Chromium against
  0.2.1-beta.3, the first diagram after a fresh start of the browser, the engine's start included,
  took 97 ms instead of 104 for a plain TikZ diagram in WebKit, the browser engine of the iPhone and
  iPad, and 72 instead of 92 in Chromium, the one of Obsidian's desktop app; siunitx 103 instead of
  225 and 88 instead of 187; circuitikz 223 instead of 434 and 170 instead of 336. Without the JIT,
  as with Lockdown Mode on, in WebKit, the plain diagram took 233 ms instead of 600 and circuitikz
  2.8 s instead of 8.2. A note of 74 diagrams that were not cached, opened in a fresh browser after
  a first visit had stored most of their preambles, took 24% less time in WebKit and 35% less in
  Chromium with one engine, 48% less in Chromium with two, as Obsidian's desktop app runs by
  default, and 10% less in WebKit at a phone's budgets. In WebKit on that desktop the engine's start
  took 3 to 4 ms longer with the storage in use and nothing stored, and 2 to 14 ms longer while a
  stored preamble was read, the engine's own start inside its thread taking the same; where the rest
  goes was not tracked down. The engine writes a preamble out only once it has had nothing to do for
  a tenth of a second, and then a little at a time, so that a diagram that comes meanwhile waits at
  most a few milliseconds: on that desktop the longest step took 3 ms, also without the JIT. Up to
  64 MB are kept for each vault on a computer, and 16 MB on a phone or tablet and on a computer that
  reports less than 8 GB of memory, compressed from iOS 16.4 on, the preamble used least recently
  going first; where storage runs out of room, the preambles already stored are still used. A stored
  preamble belongs to one build of the engine, and the first start of a vault's engine after an
  update that changes the engine deletes the old ones, without the first diagram waiting for it.
  Settings → Saved preambles covers these too, and turning it off deletes them; clearing the diagram
  cache deletes them too, which is the way to remove them from a device before uninstalling the
  plugin, since Obsidian does not tell a plugin it is being removed. The README says what a stored
  preamble holds. Every release now checks every test diagram started from a stored preamble against
  the same diagram drawn from the start, byte for byte. On my iPhone 16 Pro the engine of
  0.2.1-beta.2 started in 48 ms, read off the diagnostics view; nothing of this release has been
  measured on a phone yet.
- On a phone or tablet the engine now stops after 15 seconds without a diagram, where it waited 30.
  Until it stops, an idle engine holds on to what its diagrams left: on the Windows desktop, in
  WebKit, the page held 290 to 500 MB while an idle engine waited and about 120 MB once it had
  stopped, and letting the engine give back its memory without stopping it freed nothing. Since the
  first diagram after a stop now starts from its stored preamble, the stop costs it mainly the
  engine's start.
- The diagnostics view says of a diagram that started from a stored preamble "resumed from a stored
  preamble", with how long reading it and putting it back took, and how many preambles are stored,
  in how many MB, and how many times storage refused, or that they are off; Copy includes it. The
  settings say that clearing the diagram cache deletes the stored preambles too.

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
