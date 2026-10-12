# Security

## Reporting a vulnerability

Please report it privately, through GitHub: the repository's **Security** tab → **Report a
vulnerability**, or directly at
[github.com/JackVinati/tikzjax-next/security/advisories/new](https://github.com/JackVinati/tikzjax-next/security/advisories/new).
Not as a public issue: a note is something people share, so a diagram that can do harm travels.

Say what a note has to contain for the problem to happen, what happens, and the plugin, Obsidian and
platform versions. A minimal ` ```tikz ` block is worth more than a description of one. You will get
an answer on the advisory, and a fix goes out as a normal release; please give it time to reach the
community store before publishing the details.

## Supported versions

The latest release. Obsidian updates plugins from the community store, so a fix is not backported
to older versions.

## What counts

The plugin turns text from a note into TeX, runs it, and puts the result into the page. Where that
can go wrong is worth hearing about:

- **Markup in the rendered SVG.** TeX can emit raw SVG through `\special`, and the SVG is mounted in
  the note. The sanitizer (`src/svg/sanitize.ts`) is what stands between that and a script, an event
  handler or an external reference running inside Obsidian.
- **Anything that makes the plugin use the network.** It makes no network request, by design; one
  that a note can trigger is a vulnerability, not a feature request.
- **Reading files a note should not reach.** Preambles (`preamble=`, `%:input`) read files from the
  vault by path. Reading outside the vault, or writing anywhere a command did not ask to, is in scope.
- **Option values reaching TeX or CSS unchecked.** `%!tikz` options are spliced into TeX
  (`packages=`, `libraries=`) and into inline styles (`width=`); each is whitelisted.

What TeX itself can do inside the engine — loop forever, exhaust its memory, fail to compile — is
contained by a time budget and a worker that is terminated and restarted. A diagram that defeats
that and takes Obsidian down with it is a bug worth reporting too, as an ordinary issue unless it
can be done to someone else by sharing a note.
