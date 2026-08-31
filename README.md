# TikZJax Next

Renders TikZ and LaTeX diagrams inside Obsidian notes. TeX runs locally, compiled to WebAssembly.
Nothing is uploaded and nothing is fetched at runtime.

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

## What is different

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

**Diagrams render when they scroll into view**, one or two at a time, so a note with thirty of them
does not lock up the editor.

**PDF export waits for the diagrams.** The processor returns a promise, which is what Obsidian
actually awaits before taking the print snapshot. Colours are pinned to black on white for print
regardless of your theme.

**Dark mode is handled in CSS, not by rewriting the SVG.** The old plugin string-replaced `black`
and `white` inside the markup, which could not tell TeX's default ink from a colour you chose, and
baked CSS variables into presentation attributes so a copied SVG rendered wrong outside Obsidian.
Here the stored diagram is theme-neutral and CSS does the work.

**The TeX engine is built from source**, in a container, from pinned upstream commits, rather than
vendored as an opaque 7 MB file. That is what made it possible to find out what is actually inside
it, and to fix things that were previously assumed to be immovable.

## Installing

Not yet in the community plugin browser. Until then, download `main.js`, `manifest.json` and
`styles.css` from a [release](../../releases) and put them in
`<vault>/.obsidian/plugins/tikzjax-next/`, then enable the plugin in Settings.

Disable the original TikZJax plugin first if you have it. Both register the `tikz` code block, so
both would render every diagram twice. The plugin checks for this and refuses to start rather than
doing it quietly.

If you had the original installed, its rendered diagrams are reused instead of being recompiled.
Its cache is only read, never modified, so it keeps working if you go back to it.

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
| `timeout` | seconds |
| `packages` | comma list, `name[options]` accepted |
| `libraries` | comma list, passed to `\usetikzlibrary` |
| `border` | a TeX length, adds a margin around the diagram |
| `fast` | skips SVG optimisation and the ink measurement |
| `raw` | runs only the mandatory pipeline stages |
| `nocache` | skips the cache in both directions |

They are not written in the code fence line (` ```tikz width=420 `). Obsidian cannot read the fence
tail during PDF export, in embeds or in hover previews, so the same block would hash to two
different cache keys and the PDF would get a differently compiled diagram.

## What is included

Reported by the plugin itself, under Settings → Bundled TeX engine, because it is generated from the
build rather than written by hand. At the time of writing that is e-TeX 3.141592653, 245 TeX files,
pgf/TikZ 3.1.10, pgfplots 1.18.1, and the expl3 layer.

Verified by fixtures in `test/fixtures/tex`, each rendered end to end through the shipped worker:
plain TikZ, `pgfplots` including its libraries, `circuitikz`, `chemfig`, `tikz-cd`, `forest`,
`mathtools`, `xparse`, `tikz-feynhand`, `arrows.meta`, shadings and patterns.

## Known limitations

| | |
| --- | --- |
| `\mathfrak`, `\mathscr`, siunitx's unit symbols | The fonts and their metrics ship, but the DVI-to-SVG converter has a fixed font table covering only Computer Modern, and it is not extensible from outside. Fixing this means changes to `@drgrice1/dvi2html`. |
| `patterns` draws nothing | The driver emits the pattern reference but not the pattern definition. |
| `chemfig`'s `\schemestart` loses bonds | The bonds are already missing in the DVI, before any JavaScript runs. |
| `tikz-feynman` | LuaTeX only. `tikz-feynhand` is bundled and works. |
| CJK, Cyrillic, IPA | The engine is 8-bit. |
| Obsidian Publish | Publish runs no community plugins. Exporting a diagram as an attachment is the answer, and is not built yet. |
| Preambles from a vault file | Parsed but not yet resolved. Per-block `packages` and `libraries` work. |

Untested on iOS and iPadOS at the time of writing. `isDesktopOnly` is `false` because it is expected
to work, not because it has been confirmed.

## Building

The plugin and the TeX engine are built separately. The engine needs Docker and takes about ten
minutes; you only need to build it again if you change something under `engine-build/`.

```sh
npm install
npm run engine:image   # container with a pinned TeX Live and the web2js toolchain
npm run engine:build   # tex.wasm, core.dump, tex_files, fonts -> engine-build/out/
npm run build          # main.js and styles.css
```

Everything the engine build depends on is pinned in `engine-build/pins.env` and baked into the
image, so a build makes no network requests and is reproducible.

Useful while working on it:

```sh
npm test               # unit tests
npm run smoke          # every fixture through the engine, headless
npm run verify:fork    # our engine fork against the upstream it forked from, byte for byte
npm run verify:worker  # the exact worker string that goes into main.js
npm run typecheck
```

To develop against a real vault, point the build at it and it will copy the files on every rebuild:

```sh
OBSIDIAN_PLUGIN_DIR="$HOME/vaults/dev/.obsidian/plugins/tikzjax-next" npm run dev
```

`docs/DESIGN.md` describes the architecture, `docs/DECISIONS.md` records the decisions that override
it and why, and `docs/BACKLOG.md` is a triage of every issue on the original repository.

## Licence

GPL-3.0-or-later. The plugin embeds a TeX engine derived from
[drgrice1/tikzjax](https://github.com/drgrice1/tikzjax) and
[drgrice1/web2js](https://github.com/drgrice1/web2js), both GPL-3, so the combined work is too.

`NOTICE` lists every embedded component with its own terms: TeX itself, PGF/TikZ, pgfplots,
circuitikz, chemfig and the rest, plus the Computer Modern and AMS fonts. Full licence texts are in
`vendor/LICENSES/`.

## Credits

Jim Fowler wrote [TikZJax](https://github.com/kisonecat/tikzjax) and
[web2js](https://github.com/kisonecat/web2js), which is the hard part and the reason any of this is
possible. Glenn Rice maintains the forks this engine is built from. artisticat1 wrote the original
Obsidian plugin.
