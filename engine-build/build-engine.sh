#!/usr/bin/env bash
# Builds the TeX/WebAssembly engine and drops the artifacts in /out.
#
# Runs inside the image from engine-build/Dockerfile. Every step that can silently produce a
# wrong-but-plausible result asserts instead: a missing package resolves to an empty kpsewhich
# result and genTexFiles.js only prints a warning, which is exactly how you end up shipping an
# engine that is quietly missing pgfplots.

set -Eeuo pipefail
shopt -s nullglob

SRC=/opt/engine-build
OUT=${OUT:-/out}
WORK=${WORK:-/tmp/build}

# shellcheck disable=SC1091
. "$SRC/pins.env"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$OUT" "$WORK"
cd "$WORK"

# ---------------------------------------------------------------------------------------------
log "TeX distribution (flavour: ${TEXLIVE_FLAVOUR:-unknown})"

command -v kpsewhich >/dev/null || die "kpsewhich not on PATH"
command -v tangle    >/dev/null || die "tangle not on PATH (need texlive-binaries / scheme-full)"
command -v tie       >/dev/null || die "tie not on PATH"

tex --version | head -1
kpsewhich --var-value TEXMFDIST

# These are the inputs the whole build depends on. An empty resolution here becomes a missing
# file in tex_files at the very end, so fail now instead.
#
# Note tex.web is deliberately NOT in this list: the TeX WEB source is vendored in web2js at
# texk/tex.web (asserted after the clone below), not indexed by kpathsea. Asking kpsewhich for it
# fails even on a perfectly good installation.
for f in pgf.sty pgfplots.sty tikz.sty standalone.cls xcolor.sty expl3.sty xparse.sty; do
    p=$(kpsewhich "$f" || true)
    [ -n "$p" ] || die "kpsewhich cannot find $f — the TeX installation is incomplete"
    ok "$f -> $p"
done

# ---------------------------------------------------------------------------------------------
log "Recording package versions (this is what the engine will actually ship)"

# Resolve a package version to a COMPARABLE number wherever possible.
#
# The naive approach — echo the \ProvidesPackage bracket — fails for the whole PGF family, because
# they write \ProvidesPackage{pgfplots}[\pgfplotsversiondate\space v\pgfplotsversion ...]: the
# bracket contains macros, not digits. Emitting that string put `\pgfplotsversiondate\space v...`
# into the shipped inventory, which made the #110 compat lint dead code — it compared a version
# number against a macro name and never fired. So: look in the package's revision file first,
# where the version is \def'd literally.
version_of() {
    local file="$1" base path rev macro
    base="${file%.*}"
    path=$(kpsewhich "$file" 2>/dev/null || true)
    [ -n "$path" ] || { echo "absent"; return; }

    # Four ways a TeX package states its version, in decreasing order of how much it means what it
    # says. Every one of them is here because a package in the reported set uses it and nothing
    # else, and a version reported as "unknown" is a question the release notes leave open.

    # 1. A revision file, as a macro definition. Both the assignment form and the file name vary:
    #      pgf.revision.tex       \def\pgfversion{3.1.10}
    #      pgfplots.revision.tex  \gdef\pgfplotsversion{1.18.1}   <- \gdef, inside a \begingroup
    #    tikz ships with pgf and pgfplotstable with pgfplots; neither carries a version of its own.
    local family="$base"
    case "$base" in
        tikz) family="pgf" ;;
        pgfplotstable) family="pgfplots" ;;
    esac

    for rev in "${family}.revision.tex" "${family}revision.tex"; do
        macro=$(kpsewhich "$rev" 2>/dev/null || true)
        [ -n "$macro" ] || continue
        local v
        v=$(grep -ohE '\\(g|x|e)?def\\'"${family}"'version\{[^}]*\}' "$macro" 2>/dev/null \
            | head -1 | sed -E 's/.*\{([^}]*)\}.*/\1/')
        [ -n "$v" ] && { echo "$v"; return; }
    done

    # 2. expl3 packages announce themselves positionally rather than in a bracket:
    #      \ProvidesExplPackage{siunitx}{2024-01-25}{3.3.10}{...}
    #    Take the version, or the date when a package leaves the version empty (xparse does).
    local flat expl
    flat=$(tr '\n' ' ' < "$path")
    expl=$(printf '%s' "$flat" \
        | grep -ohE '\\ProvidesExpl(Package|File|Class) *\{[^}]*\} *\{[^}]*\} *\{[^}]*\}' \
        | head -1 || true)
    if [ -n "$expl" ]; then
        local when ver
        when=$(printf '%s' "$expl" | sed -E 's/.*\{[^}]*\} *\{([^}]*)\} *\{[^}]*\}$/\1/')
        ver=$(printf '%s' "$expl" | sed -E 's/.*\{([^}]*)\}$/\1/')
        [ -n "$ver" ] && { echo "$ver"; return; }
        [ -n "$when" ] && { echo "$when"; return; }
    fi

    # 3. The \ProvidesPackage bracket. Matched against the file with its newlines flattened, because
    #    standalone.cls opens the bracket with a comment and puts the date on the next line, and a
    #    line-by-line grep silently reports it as unknown. Accepted only if what is left starts with
    #    a digit: anything else is a macro (pgfplotstable's bracket is `\pgfplotsversiondate`) and
    #    printing a macro name as a version is worse than admitting to not knowing.
    local bracket
    bracket=$(printf '%s' "$flat" \
        | grep -ohE '\\Provides(Package|File|Class)\{[^}]*\} *\[[^]]*\]' \
        | head -1 | sed -E 's/.*\[([^]]*)\].*/\1/' | sed -E 's/^%+ *//' | tr -s ' \t' ' ')
    case "$bracket" in
        [0-9]*) echo "$bracket"; return ;;
    esac

    # 4. The package's own version or date macro, in the .sty or in the file it loads its code
    #    from. This is how circuitikz (\def\pgfcircversion{1.6.6} in circuitikz.sty), chemfig
    #    (\def\CFver{1.66} in chemfig.tex) and expl3 (\def\ExplFileDate{2024-01-22} in
    #    expl3-code.tex) state theirs. The value has to start with a digit, or any macro with
    #    "ver" in its name would be reported as a version.
    local companions v2
    companions=""
    for c in "${base}.tex" "${base}-code.tex"; do
        local found
        found=$(kpsewhich "$c" 2>/dev/null || true)
        [ -n "$found" ] && companions="$companions $found"
    done
    v2=$(grep -ohE '\\(g|x|e)?def\\[A-Za-z@]*([Vv]er(sion)?|Date) *\{[0-9][^}]*\}' \
            "$path" $companions 2>/dev/null \
        | head -1 | sed -E 's/.*\{([^}]*)\}.*/\1/')
    [ -n "$v2" ] && { echo "$v2"; return; }

    echo "unknown"
}

: > "$OUT/tex-versions.txt"
for f in pgf.sty pgfplots.sty pgfplotstable.sty tikz.sty circuitikz.sty chemfig.sty \
         siunitx.sty expl3.sty xparse.sty amsmath.sty standalone.cls tikz-cd.sty; do
    printf '%-22s %s\n' "$f" "$(version_of "$f")" | tee -a "$OUT/tex-versions.txt"
done

# ---------------------------------------------------------------------------------------------
log "web2js @ ${WEB2JS_REF:0:12} — TeX WEB source to WebAssembly"

# Sources come from the image (see Dockerfile). Copied rather than built in place so a run never
# mutates the image's pristine checkout and two runs cannot interfere.
cp -a /opt/src/web2js web2js
HAVE=$(git -C web2js rev-parse HEAD)
[ "$HAVE" = "$WEB2JS_REF" ] \
    || die "image has web2js $HAVE but pins.env says $WEB2JS_REF — rebuild the image (npm run engine:image)"

# The TeX WEB source and the e-TeX change file are vendored in the repo, not fetched by kpathsea.
# `npm run build:tie` reads texk/tex.web, so a missing one fails deep inside tangle with an
# unhelpful message.
[ -s web2js/texk/tex.web   ] || die "web2js/texk/tex.web is missing"
[ -s web2js/etexdir/etex.ch ] || die "web2js/etexdir/etex.ch is missing"
ok "texk/tex.web $(stat -c%s web2js/texk/tex.web) bytes — $(grep -m1 -o "This is TeX, Version [0-9.]*" web2js/texk/tex.web || echo 'version unknown')"

# The reason this engine can run expl3 at all. If these ever disappear upstream, siunitx v3,
# forest, tcolorbox and modern chemfig go back to being impossible — so assert, don't assume.
for ch in changes/expanded.ch changes/strcmp.ch changes/memory.ch; do
    [ -f "web2js/$ch" ] || die "web2js is missing $ch — see docs/DECISIONS.md D8"
    ok "$ch present"
done
ok "TeX memory pages: $(node -p "require('./web2js/commonMemory.js').pages")"

# node_modules comes from the image; only install if it somehow is not there.
( cd web2js && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build )

[ -s web2js/tex.wasm   ] || die "tex.wasm was not produced"
[ -s web2js/core.dump  ] || die "core.dump was not produced"
ok "tex.wasm   $(stat -c%s web2js/tex.wasm) bytes"
ok "core.dump  $(stat -c%s web2js/core.dump) bytes"

# core.dump must be an exact multiple of the 64 KiB wasm page size and match `pages`, because the
# runtime .set()s it over the whole non-growable Memory. A short dump would leave live TeX state
# uninitialised on a reused instance.
PAGES=$(node -p "require('./web2js/commonMemory.js').pages")
DUMP=$(stat -c%s web2js/core.dump)
[ "$DUMP" -eq "$((PAGES * 65536))" ] \
    || die "core.dump is $DUMP bytes, expected $((PAGES * 65536)) (= $PAGES x 65536)"
ok "core.dump covers the entire WebAssembly.Memory ($PAGES pages)"

# ---------------------------------------------------------------------------------------------
log "tikzjax @ ${TIKZJAX_REF:0:12} — tex_files, fonts, loader"

cp -a /opt/src/tikzjax tikzjax
HAVE=$(git -C tikzjax rev-parse HEAD)
[ "$HAVE" = "$TIKZJAX_REF" ] \
    || die "image has tikzjax $HAVE but pins.env says $TIKZJAX_REF — rebuild the image (npm run engine:image)"

log "Merging supplemental tex_files"
# tex_files = upstream base
#           u hand-listed extras
#           u (what real LaTeX opened for the fixtures  -  what is already inside the core dump)
#
# That last subtraction is the point. The collector records the full closure a document needs,
# but everything loaded before \dump — all of pgfcore, pgfmath, tikz.sty, xcolor, standalone — is
# already frozen into core.dump and bundling it again is pure weight. initex-files.json is
# library.getUsedFiles() from the dump run, so it is the exact list to subtract.
node -e '
const fs = require("fs");
const read = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d);

const base = read("tikzjax/tex_files.json", []);
const extra = read("/opt/engine-build/tex-files.extra.json", [])
    .filter((n) => typeof n === "string" && !n.startsWith("//"));
const collected = read("/opt/engine-build/tex-files.collected.json", []);

const dumpedRaw = read("web2js/initex-files.json", {});
const dumped = new Set(Array.isArray(dumpedRaw) ? dumpedRaw : Object.keys(dumpedRaw));

// kpathsea configuration, not a TeX input the virtual filesystem ever serves.
const never = new Set(["texmf.cnf"]);

const runtime = collected.filter((n) => !dumped.has(n) && !never.has(n));
const merged = [...new Set([...base, ...extra, ...runtime])].sort();

fs.writeFileSync("tikzjax/tex_files.json", JSON.stringify(merged, null, 4) + "\n");
console.log(
    `    base ${base.length} + extra ${extra.length} + collected ${collected.length}` +
        ` (${collected.length - runtime.length} already in the dump) -> ${merged.length} unique`
);
'

gzip -9 -c web2js/tex.wasm  > tikzjax/tex.wasm.gz
gzip -9 -c web2js/core.dump > tikzjax/core.dump.gz
cp web2js/initex-files.json tikzjax/ 2>/dev/null || true

log "Patching genTexFiles.js to read files as bytes"
# Upstream does `pako.gzip(fs.readFileSync(sysFile, 'utf8'))` — every bundled file read as UTF-8
# TEXT. That is harmless for .sty and .code.tex and silently destroys anything binary: every byte
# >= 0x80 becomes U+FFFD. It never mattered upstream because upstream bundles no binaries, and it
# surfaces the moment you bundle a .tfm — TeX reports `Bad metric (TFM file)` for a file that is
# demonstrably present, which is a considerably worse symptom than a missing one.
#
# Asserted rather than assumed, like the worker patches: a silent no-op here would ship corrupt
# font metrics.
grep -q "readFileSync(sysFile, 'utf8')" tikzjax/genTexFiles.js \
    || die "genTexFiles.js no longer reads with 'utf8'; re-check the patch before removing it"
sed -i "s/readFileSync(sysFile, 'utf8')/readFileSync(sysFile)/" tikzjax/genTexFiles.js
grep -q "readFileSync(sysFile)" tikzjax/genTexFiles.js || die "the genTexFiles.js patch did not apply"
ok "binary-safe"

log "Computer Modern Type1 fonts"
# Baked into the image so a run needs no network at all.
cp /opt/src/bakoma.zip tikzjax/bakoma.zip
ok "bakoma.zip $(stat -c%s tikzjax/bakoma.zip) bytes"

( cd tikzjax && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build )

[ -d tikzjax/dist ] || die "tikzjax/dist was not produced"

# genTexFiles.js only *warns* when kpsewhich cannot resolve a name. Turn that into a failure:
# a silently absent pgfplots file is the exact bug class this whole build exists to remove.
WANT=$(node -p "JSON.parse(require('fs').readFileSync('tikzjax/tex_files.json','utf8')).length")
GOT=$(ls tikzjax/dist/tex_files/*.gz 2>/dev/null | wc -l)
ok "tex_files: $GOT resolved of $WANT requested"
[ "$GOT" -eq "$WANT" ] || die "$((WANT - GOT)) TeX file(s) could not be resolved — check the log above for 'Unable to locate'"

# ---------------------------------------------------------------------------------------------
log "Collecting artifacts into $OUT"

cp web2js/tex.wasm web2js/core.dump "$OUT/"
cp tikzjax/tex.wasm.gz tikzjax/core.dump.gz "$OUT/"
# `cp -r src dst` NESTS when dst already exists (dst/src), so a second run into a non-empty /out
# silently leaves the first run's stale dist in place while writing the new one underneath it.
# That cost three rebuilds of chasing a phantom asyncify bug — the file was bundled, just not
# where anything read it.
rm -rf "$OUT/dist"
cp -r tikzjax/dist "$OUT/dist"
cp tikzjax/tex_files.json "$OUT/"
cp tikzjax/initex-files.json "$OUT/" 2>/dev/null || true   # `[ -f ] && cp` would trip `set -e`

cat > "$OUT/BUILD-MANIFEST.txt" <<MANIFEST
tikzjax engine build
built            $(date -u +%Y-%m-%dT%H:%M:%SZ)
texlive flavour  ${TEXLIVE_FLAVOUR:-unknown}
tex banner       $(tex --version | head -1)
TEXMFDIST        $(kpsewhich --var-value TEXMFDIST)
web2js           ${WEB2JS_REF}
tikzjax          ${TIKZJAX_REF}
memory pages     ${PAGES} ($(( PAGES * 65536 / 1048576 )) MiB)
tex_files        ${GOT}
node             $(node --version)
MANIFEST

( cd "$OUT" && sha256sum tex.wasm core.dump tex.wasm.gz core.dump.gz tex_files.json > CHECKSUMS )

cat "$OUT/BUILD-MANIFEST.txt"
echo
log "Package versions shipped"
cat "$OUT/tex-versions.txt"
echo
log "Done. Artifacts in $OUT"
ls -la "$OUT"
