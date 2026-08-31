#!/usr/bin/env bash
# Derives the tex_files list by compiling the fixtures with the REAL LaTeX in this image and
# recording every file it opens.
#
#   docker run --rm -v "$PWD/test/fixtures/tex:/fixtures:ro" \
#              -v "$PWD/engine-build:/emit" tikzjax-engine:apt /opt/engine-build/collect-tex-files.sh
#
# Why this exists. Hand-maintaining the list does not work: `\usepgfplotslibrary{fillbetween}`
# pulls tikzlibrarypgfplots.fillbetween -> tikzlibraryfillbetween -> pgflibraryfillbetween, and
# bundling only the first (which is the only one whose name contains "pgfplots") fails with
# `I can't find file ...` at the second. Every package family has a closure like that, and
# guessing it is how upstream ended up shipping pgfplots without any of its libraries (#28, #79).
#
# `latex -recorder` writes a .fls listing every INPUT, exactly, with no 79-column log wrapping.
# The result is committed as tex-files.collected.json so the engine build stays deterministic:
# this script is run when the fixture set changes, not on every build.

set -Eeuo pipefail
shopt -s nullglob

FIXTURES=${FIXTURES:-/fixtures}
EMIT=${EMIT:-/emit}
WORK=$(mktemp -d)

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m✓\033[0m %s\n' "$*"; }

[ -d "$FIXTURES" ] || { echo "no fixtures at $FIXTURES" >&2; exit 2; }

cd "$WORK"
: > all-inputs.txt
failed=()

# The SVG pgfsys driver lives in the web2js repo, not in TeX Live. Without it here every fixture
# errors on \pgfsysdriver and the recorded closure is the dvips one, which is not what runs.
cp /opt/src/web2js/pgfsys-ximera.def .
ok "pgfsys-ximera.def staged"

for tex in "$FIXTURES"/*.tex; do
    name=$(basename "$tex" .tex)
    meta="$FIXTURES/$name.json"

    # Skip fixtures that are meant to fail — their whole point is that TeX errors out, and the
    # files a failed run opens are not the files a working one needs.
    if [ -f "$meta" ] && node -e "process.exit(JSON.parse(require('fs').readFileSync('$meta','utf8')).expect==='failure'?0:1)" 2>/dev/null; then
        printf '    skip %s (expects failure)\n' "$name"
        continue
    fi

    # Reproduce exactly the document the engine builds: the format dump already provides
    # \documentclass[margin=0pt]{standalone}, the ximera pgfsys driver, xcolor and tikz, so the
    # preamble here must mirror initex.js or the recorded closure will not match what runs.
    node -e "
      const fs = require('fs');
      const meta = fs.existsSync('$meta') ? JSON.parse(fs.readFileSync('$meta','utf8')) : {};
      const d = meta.dataset || {};
      const pkgs = Object.entries(d.texPackages || {})
        .map(([n,o]) => '\\\\usepackage' + (o ? '['+o+']' : '') + '{'+n+'}').join('');
      const libs = d.tikzLibraries ? '\\\\usetikzlibrary{'+d.tikzLibraries+'}' : '';
      const body = fs.readFileSync('$tex','utf8');
      fs.writeFileSync('$name.tex',
        '\\\\documentclass[margin=0pt]{standalone}\n' +
        '\\\\def\\\\pgfsysdriver{pgfsys-ximera.def}\n' +
        '\\\\usepackage[svgnames]{xcolor}\n\\\\usepackage{tikz}\n' +
        pkgs + libs + (d.addToPreamble || '') + '\n' +
        '\\\\begin{document}\n' + body + '\n\\\\end{document}\n');
    "

    # Judge on the artifact, not the exit code: latex exits non-zero for any error in the log
    # while still writing a perfectly good DVI, so `latex && [ -f dvi ]` reports false failures.
    latex -recorder -interaction=nonstopmode "$name.tex" >/dev/null 2>&1 || true

    # A DVI is not proof of health: under nonstopmode TeX recovers from most errors and writes one
    # anyway. Report the transcript's first `!` separately — that is what distinguishes "the engine
    # is missing something" from "the fixture is wrong", and it is exactly how a mistyped `\\` row
    # separator in the tikz-cd fixture masqueraded for hours as an engine defect.
    first_error=$(grep -m1 '^!' "$name.log" 2>/dev/null || true)
    if [ -f "$name.dvi" ] && [ -z "$first_error" ]; then
        ok "$name -> $(stat -c%s "$name.dvi") B dvi"
    elif [ -f "$name.dvi" ]; then
        failed+=("$name")
        printf '    \033[33m! %s produced a dvi but real LaTeX reported: %s\033[0m\n' "$name" "$first_error"
    else
        failed+=("$name")
        printf '    \033[31m! %s produced no dvi: %s\033[0m\n' "$name" "${first_error:-unknown}"
    fi

    [ -f "$name.fls" ] && grep '^INPUT ' "$name.fls" | cut -d' ' -f2- >> all-inputs.txt
done

log "Reducing recorded inputs"

node -e '
const fs = require("fs");
const lines = fs.readFileSync("all-inputs.txt", "utf8").split("\n").filter(Boolean);

const names = new Set();
for (const p of lines) {
    // Only files from the distribution. Job-local files (input.tex, .aux, .dvi) are not packages.
    if (!p.includes("texmf")) continue;
    const base = p.split("/").pop();

    // .tfm metrics are supplied by dvi2html'"'"'s built-in tfmData(), not by the virtual filesystem
    // (see library.js openSync), so bundling them would be dead weight.
    if (base.endsWith(".tfm")) continue;
    // Font maps/encodings are a dvips concern; this engine emits SVG.
    if (/\.(map|enc|pfb|vf|fd_)$/.test(base)) continue;
    // The format itself is in the core dump.
    if (base === "latex.ltx" || base.endsWith(".fmt") || base === "texsys.cfg") continue;

    names.add(base);
}

const out = [...names].sort();
fs.writeFileSync(process.env.EMIT + "/tex-files.collected.json", JSON.stringify(out, null, 4) + "\n");
console.log(`    ${lines.length} recorded inputs -> ${out.length} distinct distribution files`);
'

if [ ${#failed[@]} -gt 0 ]; then
    printf '\n\033[33mFixtures that did not compile with real LaTeX: %s\033[0m\n' "${failed[*]}"
    printf 'Their inputs were still recorded, but a fixture that real LaTeX cannot build is a bug\nin the fixture, not in the engine — fix it before trusting the collected list.\n'
fi

log "Wrote $EMIT/tex-files.collected.json"
