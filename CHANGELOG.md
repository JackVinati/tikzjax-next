# Changelog

What changed in each release, newest first. The release workflow puts a version's section at the
top of its notes on GitHub, and will not publish a version that has none.

## 0.1.5 — unreleased

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
