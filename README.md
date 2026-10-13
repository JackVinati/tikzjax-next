# TikZJax Next

Draw TikZ and LaTeX diagrams in Obsidian notes: write the code in a `tikz` block and the note shows
the picture. pgfplots, circuitikz, chemfig, tikz-cd, forest and a hundred TikZ and pgfplots
libraries are built in. TeX runs inside the plugin, compiled to WebAssembly, so there is nothing
else to install, nothing is uploaded and nothing is fetched — it works offline, on desktop and on
mobile.

````markdown
```tikz
\begin{tikzpicture}
  \draw (0,0) circle (1cm);
  \node at (0,-1.6) {hello};
\end{tikzpicture}
```
````

This is a fork of [artisticat1/obsidian-tikzjax](https://github.com/artisticat1/obsidian-tikzjax),
which had not been updated since 2022. It is not a drop-in replacement: the plugin id is different,
so the two can be installed side by side, though not enabled at the same time.

**It works on iPhone and iPad.** Not "should work" — a TeX engine compiles and diagrams render on
the device. It is slower there than on a desktop, and the first diagram is the slow one: it pays for
starting the engine, and everything after it is faster. A diagram you have already seen is a hash
lookup, so re-opening a note costs nothing at all on any device. Making the first render quicker on
mobile is the next thing worth working on.

## Installing

In Obsidian: Settings → Community plugins → Browse, search for **TikZJax Next**, install, enable.
It works the same on desktop, iPhone and iPad, and needs Obsidian 1.7.2 or later.

To install by hand instead, download `main.js`, `manifest.json` and `styles.css` from a
[release](../../releases) into `<vault>/.obsidian/plugins/tikzjax-next/` and enable it in Settings.

Disable the original TikZJax plugin first if you have it. Both register the `tikz` code block, so
both would render every diagram twice. The plugin checks for this and refuses to start rather than
doing it quietly.

If you had the original installed, its rendered diagrams are reused instead of being recompiled.
Its cache is only read, never modified, so it keeps working if you go back to it.

## Writing diagrams

A `tikz` block holds what a LaTeX file would, minus the `\documentclass` line: the engine starts
from the `standalone` class with TikZ and `xcolor` already loaded, and a second class is an error. A
block that is only a `tikzpicture` is wrapped in `\begin{document}` … `\end{document}` for you.

To load packages or libraries, write them the way a LaTeX file would, ahead of an explicit
`\begin{document}`:

````markdown
```tikz
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usepgfplotslibrary{fillbetween}
\begin{document}
\begin{tikzpicture}
  \begin{axis}[width=8cm, height=5cm]
    \addplot[name path=a, domain=0:3] {x};
    \addplot[name path=b, domain=0:3] {0.5*x^2};
    \addplot[gray!40] fill between[of=a and b];
  \end{axis}
\end{tikzpicture}
\end{document}
```
````

…or name them in a `%!tikz` line (below) and keep the block to the picture. A diagram renders when
it scrolls into view; one you have seen before appears instantly, from the cache, in the same frame
as the text around it. When TeX reports an error, the block shows it with its line — or, for an
error in a preamble file, that file and its line — and, where it can, what to change; a mistyped
macro usually still renders the rest of the diagram.

Accented letters work as typed, dieresis included (Grüße, naïve, `\"u`), and so do `°` `×` `±`
`µ` `→`, list bullets and siunitx's units; see the limitations below for the characters that do
not.
[`test/vault/TikZ-smoke-test.md`](test/vault/TikZ-smoke-test.md) is a note full of examples to copy
from.

## Per-block options

Options go in the block body, as `%!tikz` lines. They are stripped before the source reaches TeX.

````markdown
```tikz
%!tikz width=420 align=left colors=paper alt="RC low-pass filter"
%!tikz packages=circuitikz libraries=arrows.meta
\begin{circuitikz}
  \draw (0,0) to[R=$R$] (2,0) to[C=$C$] (2,-2) -- (0,-2) -- (0,0);
\end{circuitikz}
```
````

| Key | Values |
| --- | --- |
| `width`, `max-width`, `scale` | CSS length, or a number for `scale` |
| `align` | `left`, `center`, `right` |
| `alt` | quoted text, used as the accessible name. `alt=""` marks a diagram decorative |
| `colors` | `adapt` (default), `preserve`, `paper`, `invert` |
| `lazy` | `on`, `off`, `manual` |
| `timeout` | seconds, or a duration such as `500ms` |
| `packages` | comma list, `name[options]` accepted |
| `libraries` | comma list, passed to `\usetikzlibrary` |
| `border` | a TeX length, adds a margin around the diagram |
| `preamble` | a `.tex` file in the vault, put in front of the block. See below |
| `twopass` | runs TeX a second time when the first run left something to re-read, so `\label` and `\ref` resolve. Off by default: it can double the compile time |
| `wrap` | `auto` (default) wraps the block in `\begin{document}` … `\end{document}` unless it has one; `always` and `never` decide for it |
| `fast` | skips SVG optimisation and the pre-flight check, and renders ahead of other diagrams |
| `svgo` | `off` leaves the engine's SVG as it is; `targeted` and the default `preset` simplify how text is placed and drop an attribute browsers disagree on |
| `raw` | runs only the mandatory pipeline stages |
| `nocache` | skips the cache in both directions |

They are not written in the code fence line (` ```tikz width=420 `). Obsidian cannot read the fence
tail during PDF export, in embeds or in hover previews, so the same block would hash to two
different cache keys and the PDF would get a differently compiled diagram.

The plugin's settings cover colours, lazy rendering, fast mode, the time limit, how the source is
cleaned up, the pre-flight checks, the preamble files, the TeX log and the cache. A change applies
to the open notes straight away, also when it arrives from another device through Sync. Where an
option shares its name with a setting — `colors`, `lazy`, `timeout`, `fast` — the option wins for
its block.

## Shared preambles

Macros, styles and packages that many diagrams use can live in a `.tex` file in the vault instead
of being repeated in every block. A preamble goes where a LaTeX preamble goes, before
`\begin{document}`, so it holds `\usepackage`, `\usetikzlibrary`, `\newcommand`, `\tikzset` and
`\pgfplotsset`.

`latex/diagrams.tex`:

```tex
\usetikzlibrary{arrows.meta, positioning}
\tikzset{box/.style={draw, rounded corners, inner sep=6pt}}
\newcommand{\vect}[1]{\mathbf{#1}}
```

A note:

````markdown
```tikz
%:input latex/diagrams.tex
\begin{tikzpicture}
  \node[box] (f) {$f(\vect{x}) = A\vect{x}$};
  \node[box, right=of f] (g) {$g$};
  \draw[-Stealth] (f) -- (g);
\end{tikzpicture}
```
````

Four things can name a preamble file. Every one that applies is used, in this order, so a later
file can use what an earlier one defines:

1. **The vault-wide preamble**: Settings → Preamble → Preamble file, a path in the vault. The field
   suggests the vault's `.tex`, `.sty`, `.ltx`, `.def` and `.txt` files as you type; the path takes
   effect when you pick one, press Enter or leave the field.
2. **A folder preamble**: a file named `tikz-preamble.tex` in the note's folder, or failing that the
   nearest folder above it, up to the root of the vault. Only the nearest one is used. The name is
   Settings → Preamble → Folder preamble file name, which takes effect the same way; empty turns
   the search off.
3. **`%!tikz preamble=path/to/file.tex`** in the block.
4. **`%:input path/to/file.tex`** lines in the block, in the order they are written. A preamble file
   can `%:input` other files as well.

Paths resolve the way a `[[link]]` does: relative to the file that wrote them — the note, or the
preamble file for a nested `%:input` — and otherwise by name anywhere in the vault. A file named
twice is included once. A file that cannot be found, or a loop of `%:input`s, shows a note under the
diagram saying which file and who asked for it; nothing is silently left out. Inside a preamble file
only `%:input` lines are read as directives: a `%!tikz` line there is a TeX comment and changes
nothing.

The contents of every preamble file are part of the cache key of each diagram that uses it. Edit
the file and those diagrams — and only those — are compiled again the next time they render; a stale
one is never served from the cache. Open notes re-render straight away, in Reading view and in Live
Preview. When TeX stops on a line of a preamble file, the error card names the file and the line.

## Commands

| Command | What it does |
| --- | --- |
| Copy the diagram at the cursor as SVG | Puts the rendered SVG on the clipboard, theme-neutral, so it opens correctly outside Obsidian. |
| Save the diagram at the cursor as an SVG file | Writes it to your attachment folder. |
| Finalize the diagrams in this note | Saves each diagram as an attachment and rewrites the note as `![[diagram.svg]]` with the original fence preserved verbatim inside an Obsidian `%%` comment. The point is that the note now renders without this plugin — in Publish, in another editor, on GitHub. |
| Un-finalize the diagrams in this note | The exact inverse. The source was never thrown away. |
| Render all diagrams in this note | Ignores lazy rendering and compiles everything now, with a Stop button, and says how many rendered. |
| Open the diagram at the cursor in a zoom view | A scrollable, zoomable view of one diagram. |
| Open TikZ diagnostics | The TeX log, the cache key and the compile timings for recent renders. Start here when a diagram does something inexplicable. |
| Clear the diagram cache | Forgets every diagram this plugin has rendered; each compiles again when it is next shown. |
| Restart the TeX engine | Stops the engine, which starts again with the next diagram, and lets diagrams that failed in this session try again. |

The commands about the diagram at the cursor, and Finalize and Un-finalize, need the note open in
the editor, in Live Preview or Source mode; they are not offered in Reading view.

## What is bundled

The engine is e-TeX with a LaTeX format, built from Ubuntu 24.04's TeX Live 2023: pgf/TikZ 3.1.10,
pgfplots 1.18.1, circuitikz 1.6.6, chemfig 1.66, siunitx 3.3.10, tikz-cd 1.0, amsmath 2.17o and the
expl3 layer. Settings → Bundled TeX engine shows what the installed build reports. These lists are
taken from the build itself, and a test keeps them in step with it.

Loaded before your block starts: the `standalone` class, `tikz` (with `pgf`) and `xcolor`.

**Packages**, for `\usepackage` or `%!tikz packages=`, including the ones the others load:
<!-- bundled:packages -->
`amsbsy` `amsfonts` `amsgen` `amsmath` `amsopn` `amssymb` `amstext` `array` `atveryend`
`atveryend-ltx` `calc` `chemfig` `circuitikz` `color` `elocalloc` `environ` `etoolbox` `eufrak`
`expl3` `forest` `hf-tikz` `ifthen` `infwarerr` `inlinedef` `keyval` `ltxcmds` `mathrsfs`
`mathtools` `mhsetup` `pdftexcmds` `pgfcalendar` `pgfopts` `pgfplots` `pgfplotstable` `preview`
`siunitx` `tikz-3dplot` `tikz-cd` `tikz-feynhand` `translations` `trimspaces` `xparse`
<!-- /bundled:packages -->

**TikZ libraries**, for `\usetikzlibrary` or `%!tikz libraries=`:
<!-- bundled:tikz-libraries -->
`3d` `angles` `animations` `arrows` `arrows.meta` `automata` `babel` `backgrounds` `bbox` `bending`
`calc` `calendar` `cd` `chains` `circuits` `circuits.ee` `circuits.ee.IEC` `circuits.logic`
`circuits.logic.CDH` `circuits.logic.IEC` `circuits.logic.US` `curvilinear` `datavisualization`
`datavisualization.3d` `datavisualization.barcharts` `datavisualization.formats.functions`
`datavisualization.polar` `datavisualization.sparklines` `decorations` `decorations.footprints`
`decorations.fractals` `decorations.markings` `decorations.pathmorphing`
`decorations.pathreplacing` `decorations.shapes` `decorations.softclip` `decorations.text` `er`
`external` `fadings` `feynhand` `fillbetween` `fit` `fixedpointarithmetic` `folding` `fpu`
`graphs` `graphs.standard` `intersections` `lindenmayersystems` `math` `matrix` `mindmap`
`patterns` `patterns.meta` `perspective` `petri` `plothandlers` `plotmarks` `positioning` `quotes`
`rdf` `scopes` `shadings` `shadows` `shapes` `shapes.arrows` `shapes.callouts` `shapes.gates.ee`
`shapes.gates.ee.IEC` `shapes.gates.logic` `shapes.gates.logic.IEC` `shapes.gates.logic.US`
`shapes.geometric` `shapes.misc` `shapes.multipart` `shapes.symbols` `snakes` `spy` `svg.path`
`through` `trees` `turtle` `views`
<!-- /bundled:tikz-libraries -->

**pgfplots libraries**, for `\usepgfplotslibrary`:
<!-- bundled:pgfplots-libraries -->
`clickable` `colorbrewer` `colormaps` `colortol` `contourlua` `dateplot` `decorations.softclip`
`fillbetween` `groupplots` `patchplots` `polar` `smithchart` `statistics` `surfshading` `ternary`
`units`
<!-- /bundled:pgfplots-libraries -->

Being in the list means the file is there, not that everything in it can work: `contourlua` needs
LuaTeX and `external` needs to run programs, and this engine has neither. What a fixture in
`test/fixtures/tex` renders end to end through the shipped worker, on every CI run: plain TikZ,
`pgfplots` including its libraries, `circuitikz`, `chemfig`, `tikz-cd`, `forest`, `mathtools`,
`xparse`, `siunitx`, `tikz-feynhand`, `arrows.meta`, shadings, letters with a dieresis, and `°` `×`
`→` `±` `µ` with their text commands. The `patterns` library loads too, but see the limitations
below.

## Known limitations

| | |
| --- | --- |
| `\mathfrak`, `\mathscr` | TeX compiles them, and then the diagram fails: the DVI-to-SVG converter has a fixed font table, and it has neither the Euler fonts nor rsfs. For `\mathfrak` the Euler face and its metrics both ship, so the fix is in `@drgrice1/dvi2html`. `\mathscr` (rsfs) has only its metrics bundled and no face at all, so it would need a face built as well as a converter change. |
| `patterns` draws nothing | The driver emits the pattern reference but not the pattern definition. |
| `chemfig`'s `\schemestart` loses bonds | The bonds are already missing in the DVI, before any JavaScript runs. |
| `tikz-feynman` | LuaTeX only. `tikz-feynhand` is bundled and works. |
| Greek, Cyrillic, CJK, IPA, emoji | Not set up in this engine's LaTeX format: TeX leaves them out with an error. Most accented Latin letters work as typed (Dvořák, Erdős, İstanbul, café, Grüße, naïve), as do curly quotes, dashes and `…` — the exact set is measured from the engine and listed in `src/source/native-unicode.ts`. `Ł` and `ł` are the exception: TeX sets them, and the SVG converter then fails on them. |
| `€` `£` `©` `®` typed directly, `\pounds`, `\textcopyright` | They come from the TS1 text companion font, which the SVG converter cannot draw, and the diagram fails. Pre-flight warns about the typed ones. `°` `×` `±` `µ` `·` `÷` `¬` `§` `¶` `†` `‡` `•` `™` `℃` `←` `↑` `→` `↓` `Ω` and `²` `³` `¹`, their `\text…` commands, siunitx's units (`\degree`, `\micro`, `\ohm` and the rest), `\S`, `\dag` and list bullets do render: they are drawn from the math fonts instead, so `µ` comes out as the italic math `μ`. |
| Obsidian Sync Standard does not sync `main.js` | It is 11.7 MB, and that plan caps a file at 5 MB. The plugin still installs from the community browser or a release on every device; only syncing the plugin folder itself is affected. The size is the TeX engine — a 156 MiB core dump, gzipped and base64'd — and shrinking it means a smaller engine, not tighter code. |
| Obsidian Publish | Publish runs no community plugins. Save the diagram as an SVG attachment, or finalize the note, and the result publishes as ordinary content. |

Confirmed working on iOS: the engine compiles and diagrams render on an iPhone, which is what
`isDesktopOnly: false` is claiming. What has not been measured there yet is behaviour under load — a
note with twenty uncached diagrams, backgrounding the app mid-compile, PDF export — so if something
gives out on a phone, that is where to look first, and an issue with the device and iOS version is
worth more than a guess. Android has not been tried at all yet; a report either way is welcome.

## Questions

**Do I need LaTeX installed?** No. The whole engine is inside the plugin and runs offline.

**Why does the first diagram take a while?** It starts the engine. Later diagrams in the session
are faster, and a diagram you have already seen comes from the cache without running TeX at all.

**Can I put TikZ in a `$$ … $$` math block?** No. Obsidian hands math blocks to MathJax before any
plugin sees them, and MathJax does not run TikZ. Use a `tikz` block; for an inline-looking result,
`%!tikz align=left` and a small `width`.

**My block starts with `\documentclass` and fails.** Remove the line. The engine already has its
document class loaded, and `\usepackage` lines followed by `\begin{document}` work as they would in
a LaTeX file.

**A plot of `tan`, `1/x` or `exp` fails with "Dimension too large".** pgfmath works in fixed point
and overflows near an asymptote or a large value, the same way it does in a real LaTeX
installation. Restrict the `domain`, or skip the region around the asymptote.

**Can I use `tikz-feynman`?** It needs LuaTeX, which this engine is not. `tikz-feynhand` is bundled:
it is derived from `tikz-feynman`, with the vertices placed by hand. `%!tikz packages=tikz-feynhand`.

**Is package X available?** See [What is bundled](#what-is-bundled). If it is not there, open an
issue with the package request form and a diagram that needs it.

**Can I use the diagrams outside Obsidian?** Copy or save one as SVG with the commands above, or
finalize the note: each diagram becomes an SVG attachment and the source stays in the note, so it
shows up in Publish, on GitHub and in any Markdown editor.

**Something fails on my iPhone. How do I report it?** There are no devtools on the device, but
Safari on a Mac can reach its console: on the device, Settings → Apps → Safari → Advanced → Web
Inspector; connect it to a Mac by cable; then in Safari on the Mac, Develop → the device → the
Obsidian window. Every mobile bug report on the original repository is untriageable for want of
this paragraph, so if you are filing one, this is how to get something worth attaching.

## Coming from the original TikZJax

The original plugin created a `<script type="text/tikz">` element and let a bundled script scan the
document for it. That meant it held no handle on anything it started, so per-diagram timeouts,
cancellation, caching, error reporting and PDF export were not so much unimplemented as
unreachable. This fork owns the whole path from the code fence to the SVG.

**Cached diagrams appear instantly.** A diagram you have seen before is a hash lookup and one string
replacement, done before the code block processor returns, so it paints in the same frame as the
surrounding text with no spinner and no layout shift. Diagrams are cached by a hash of their source,
so nothing recompiles unless you change it. Switching theme, resizing a diagram or changing its
alignment costs no recompilation at all, because none of those are part of the cache key.

**Errors say what went wrong.** The old plugin's only failure path was a broken-image icon (and an
HTTP request to a third-party domain on every failure, in a plugin whose selling point was working
offline). This one reports the TeX error and the line, and where possible what to do about it. A
mistyped macro usually renders the rest of the diagram and tells you what it dropped.

**A bad diagram cannot take the rest with it.** TeX is fed `\nonstopmode`, so an error is logged
instead of stopping at an interactive prompt. If a diagram exceeds its time budget the worker is
terminated and restarted, and only that diagram fails. In the original, one bad diagram blocked
every later one until Obsidian was restarted.

**Diagrams render when they scroll into view**, one at a time, so a note with thirty of them does
not lock up the editor.

**PDF export waits for the diagrams.** The processor returns a promise, which is what Obsidian
actually awaits before taking the print snapshot — for at most a minute in all, after which a
diagram not yet compiled is printed as a short note saying so; "Render all diagrams in this note"
beforehand makes sure there is none. Colours are pinned to black on white for print regardless of
your theme.

**Dark mode is handled in CSS, not by rewriting the SVG.** The old plugin string-replaced `black`
and `white` inside the markup, which could not tell TeX's default ink from a colour you chose, and
baked CSS variables into presentation attributes so a copied SVG rendered wrong outside Obsidian.
Here the stored diagram is theme-neutral and CSS does the work.

**The TeX engine is built from source**, in a container, from pinned upstream commits, rather than
vendored as an opaque 7 MB file. That is what made it possible to find out what is actually inside
it, and to fix things that were previously assumed to be immovable.

Everything it is built with is current, and that is the point of the fork rather than a detail of
it: **TypeScript 7**, esbuild 0.28, ESLint 10 with oxlint for the fast loop, Vitest 5, and the
Obsidian 1.14 typings — while running on Obsidian 1.7.2 and up, because the floor is set by the API
the plugin actually calls rather than by the version it was written against. The TeX side is a real
TeX Live: pgf/TikZ 3.1.10, pgfplots 1.18.1 with its libraries, circuitikz, chemfig and the expl3
layer.

For contrast, the state of the plugin this forks from: its lockfile no longer installed at all, and
its build config listed twenty-one `@codemirror` packages of which thirteen had been folded into
others years earlier.

## Contributing

```sh
npm ci
npm run build          # main.js and styles.css, in seconds, with no Docker
```

The compressed TeX engine is committed, so that is the whole build.
[CONTRIBUTING.md](CONTRIBUTING.md) has the checks CI runs, the rules a change has to keep, how to
rebuild the engine, and how releases are cut. Security problems go to [SECURITY.md](SECURITY.md)
rather than to a public issue. What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Licence

GPL-3.0-or-later. The plugin embeds a TeX engine derived from
[drgrice1/tikzjax](https://github.com/drgrice1/tikzjax) and
[drgrice1/web2js](https://github.com/drgrice1/web2js), both GPL-3, so the combined work is too.

`NOTICE` lists every embedded component with its own terms: TeX itself, PGF/TikZ, pgfplots,
circuitikz, chemfig and every other bundled package, and the fonts, which are Basil K. Malyshev's
BaKoMa Type 1 conversions of Computer Modern and the AMS fonts, under the BaKoMa licence. Full
licence texts are in `vendor/LICENSES/`.

## Credits

Jim Fowler wrote [TikZJax](https://github.com/kisonecat/tikzjax) and
[web2js](https://github.com/kisonecat/web2js), which is the hard part and the reason any of this is
possible. Glenn Rice maintains the forks this engine is built from. artisticat1 wrote the original
Obsidian plugin. Basil K. Malyshev made the BaKoMa fonts every diagram is drawn in.
