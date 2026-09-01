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

## Commands

| Command | What it does |
| --- | --- |
| Copy the diagram at the cursor as SVG | Puts the rendered SVG on the clipboard, theme-neutral, so it opens correctly outside Obsidian. |
| Save the diagram at the cursor as an SVG file | Writes it to your attachment folder. |
| Finalize the diagrams in this note | Saves each diagram as an attachment and rewrites the note as `![[diagram.svg]]` with the original fence preserved verbatim inside an Obsidian `%%` comment. The point is that the note now renders without this plugin — in Publish, in another editor, on GitHub. |
| Un-finalize the diagrams in this note | The exact inverse. The source was never thrown away. |
| Render all diagrams in this note | Ignores lazy rendering and compiles everything now. |
| Open the diagram at the cursor in a zoom view | A scrollable, zoomable view of one diagram. |
| Open TikZ diagnostics | The TeX log, the cache key and the compile timings for recent renders. Start here when a diagram does something inexplicable. |

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
| Obsidian Sync Standard does not sync `main.js` | It is 11.7 MB, and that plan caps a file at 5 MB. The plugin still installs from the community browser or a release on every device; only syncing the plugin folder itself is affected. The size is the TeX engine — a 156 MiB core dump, gzipped and base64'd — and shrinking it means a smaller engine, not tighter code. |
| Obsidian Publish | Publish runs no community plugins. Save the diagram as an SVG attachment, or finalize the note, and the result publishes as ordinary content. |

Confirmed working on iOS: the engine compiles and diagrams render on an iPhone, which is what
`isDesktopOnly: false` is claiming. What has not been measured there yet is behaviour under load — a
note with twenty uncached diagrams, backgrounding the app mid-compile, PDF export — so if something
gives out on a phone, that is where to look first, and an issue with the device and iOS version is
worth more than a guess.

## Building

```sh
npm install
npm run build          # main.js and styles.css
```

That is the whole thing. The compressed TeX engine — 8.5 MB of WebAssembly, a gzipped core dump,
245 TeX files and 152 fonts — is committed under `engine-build/out/`, so a fresh clone builds in
seconds with no Docker.

Rebuilding the engine itself needs Docker and about fifteen minutes, and you only need it if you
change something under `engine-build/` or `engine-src/`:

```sh
npm run engine:image   # container with a pinned TeX Live and the web2js toolchain
npm run engine:build   # tex.wasm, core.dump, tex_files, fonts -> engine-build/out/
```

Building the image is the only step that touches the network: it pins the upstream sources by
commit (`engine-build/pins.env`) and the Computer Modern font archive by SHA-256, then bakes them
in, so `engine:build` runs entirely offline. It is also reproducible — the TeX clock is pinned and
gzip is called with `-n` — so two builds of the same sources produce the same bytes, and CI rebuilds
the engine and diffs it against what is committed rather than taking it on trust. If you rebuild it,
commit the result.

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

It also drops a `.hotreload` marker in that folder, so with
[pjeby/hot-reload](https://github.com/pjeby/hot-reload) installed in the vault the plugin reloads
about a second after a rebuild, without touching Obsidian.

To debug on an iPhone or iPad, where there are no devtools: on the device, Settings → Apps → Safari
→ Advanced → Web Inspector; connect it to a Mac by cable; then in Safari on the Mac, Develop → the
device → the Obsidian window. That gives you the console and the debugger against the running
plugin. Every mobile bug report on the original repository is untriageable for want of this
paragraph, so if you are filing one, this is how to get something worth attaching.

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
