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
( cd web2js && { [ -d node_modules ] || npm ci --no-audit --no-fund; } )

# ---------------------------------------------------------------------------------------------
# THE FLAKY DUMP, and why this patch exists.
#
# initex.js runs TeX twice in one process. The first turns latex.ltx into latex.fmt; the second
# loads that format with `&latex` and freezes the whole WebAssembly.Memory into core.dump. The
# format is accumulated in memory by `put()` and written out by `close()` — with `fs.write`, the
# ASYNCHRONOUS one, whose callback is ignored. 21 MB then go to the libuv threadpool while the
# script continues synchronously into the second TeX, which reads the file back with readFileSync.
#
# It is a race, and the writer usually wins on a quiet machine: five out of five here. On a GitHub
# runner it loses about half the time, and TeX reads a half-written format and dies with
# "(Fatal format file error; I'm stymied)" — which is what this build did on two runs out of four,
# with byte-identical tex.wasm and tex.pool each time.
#
# Synchronous write, synchronous close. Both assert, because a silent no-op here would put the race
# back without saying so. Runtime is unaffected either way: the plugin uses engine-src/library.ts,
# whose filesystem is a Map in memory and whose `close` touches no disk at all.
grep -q "fs.write(file.descriptor, Buffer.concat(file.output), () => {});" web2js/library.js \
    || die "web2js library.js no longer closes with an async write — re-read close() before removing this patch"
sed -i 's/fs\.write(file\.descriptor, Buffer\.concat(file\.output), () => {});/fs.writeSync(file.descriptor, Buffer.concat(file.output));/' web2js/library.js
sed -i 's/fs\.close(file\.descriptor, () => {});/fs.closeSync(file.descriptor);/' web2js/library.js
grep -q "fs.writeSync(file.descriptor, Buffer.concat(file.output));" web2js/library.js \
    || die "the library.js close() write patch did not apply"
grep -q "fs.closeSync(file.descriptor);" web2js/library.js \
    || die "the library.js close() close patch did not apply"
if grep -q "fs.write(file.descriptor" web2js/library.js; then
    die "an async write survived the library.js close() patch"
fi
ok "library.js close() writes the format synchronously"

# ---------------------------------------------------------------------------------------------
# THE CLOCK, and why the dump is otherwise different every time.
#
# TeX reads the date at startup and freezes \year \month \day \time into the format, so core.dump
# — a snapshot of the entire WebAssembly.Memory — differs on every build even when every input is
# identical. That is the difference between an artifact you can commit and check, and 156 MB of
# "trust me": with the clock pinned, two builds of the same sources produce the same bytes, and CI
# can rebuild and diff instead of taking the committed engine on faith.
#
# Appended rather than sed-substituted over the four function bodies: an append cannot half-apply.
# The four names are asserted first, so a rename upstream fails here instead of silently leaving
# the real clock in place.
#
# The date itself is arbitrary and never reaches a user. \today inside a diagram would print it,
# which is why it is a plausible date rather than the epoch: a diagram that prints the build date
# is odd, one that prints 1 January 1970 looks broken.
for fn in getCurrentYear getCurrentMonth getCurrentDay getCurrentMinutes; do
    grep -q "    $fn()" web2js/library.js || die "web2js library.js has no $fn — the clock patch needs re-reading"
done
grep -q "^module.exports = {" web2js/library.js || die "web2js library.js is no longer a CommonJS object literal"
cat >> web2js/library.js <<'CLOCK'

// Appended by engine-build/build-engine.sh. TeX freezes the date into the format, so an unpinned
// clock makes core.dump differ on every build and the committed engine unverifiable.
module.exports.getCurrentYear = () => 2026;
module.exports.getCurrentMonth = () => 1;
module.exports.getCurrentDay = () => 1;
module.exports.getCurrentMinutes = () => 0;
CLOCK
node --input-type=commonjs -e "
const lib = require(process.cwd() + '/web2js/library.js');
const got = [lib.getCurrentYear(), lib.getCurrentMonth(), lib.getCurrentDay(), lib.getCurrentMinutes()].join('-');
if (got !== '2026-1-1-0') { console.error('clock patch did not take: ' + got); process.exit(1); }
" || die "the library.js clock patch did not apply"
ok "library.js clock pinned to 2026-01-01, so core.dump is reproducible"

# Upstream's `npm run build` is four steps and the last one is the flaky one, so run them
# separately: a failure then names the step it happened in instead of "the build".
for step in build:parser build:wasm build:asyncify-wasm build:initex; do
    node -e "process.exit(require('./web2js/package.json').scripts['$step'] ? 0 : 1)" \
        || die "web2js has no '$step' script — its build was restructured; re-read package.json"
done

( cd web2js && npm run build:parser && npm run build:wasm && npm run build:asyncify-wasm )

[ -s web2js/tex.wasm ] || die "tex.wasm was not produced"
[ -s web2js/tex.pool ] || die "tex.pool was not produced"
ok "tex.wasm   $(stat -c%s web2js/tex.wasm) bytes  sha256 $(sha256sum web2js/tex.wasm | cut -c1-16)"
ok "tex.pool   $(stat -c%s web2js/tex.pool) bytes  sha256 $(sha256sum web2js/tex.pool | cut -c1-16)"

# The dump. The close() patch above fixes the race that made this fail half the time on CI, so an
# "attempt 2" line below means either that the patch stopped covering the failure or that something
# else is wrong — it is a signal, not routine. It prints latex.fmt's size for that reason: a short
# format is the signature of a lost write, and the good one here is 21427400 bytes.
#
# Retrying at all is safe because nothing downstream trusts the dump on faith: it must be exactly
# pages x 65536 bytes, then 21 fixtures render through it, then verify-fork asserts the output is
# byte-identical to upstream's engine. A dump that passes all three is a dump, whichever attempt
# produced it.
DUMPED=
for attempt in 1 2 3; do
    if ( cd web2js && npm run build:initex ) && [ -s web2js/core.dump ]; then
        DUMPED=$attempt
        break
    fi
    printf '    \033[33m!\033[0m attempt %s produced no core.dump (latex.fmt: %s bytes)\n' \
        "$attempt" "$(stat -c%s web2js/latex.fmt 2>/dev/null || echo 'missing')"
    rm -f web2js/core.dump web2js/latex.fmt
done
[ -n "$DUMPED" ] || die "core.dump was not produced in 3 attempts"
[ "$DUMPED" = 1 ] || ok "core.dump produced on attempt $DUMPED"
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

# `-n`: no original name, no modification time in the header. Without it the two files differ on
# every build even when their contents are identical to the byte — gzip stamps the clock into the
# archive — and these are the two artifacts the plugin build reads and the repository commits.
gzip -9 -n -c web2js/tex.wasm  > tikzjax/tex.wasm.gz
gzip -9 -n -c web2js/core.dump > tikzjax/core.dump.gz
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

# The files the FORMAT was built from, hashed as one.
#
# core.dump is a snapshot of TeX's memory after reading latex.ltx and the LaTeX kernel — 146 files,
# listed by name and resolved path in initex-files.json. Almost none of them are bundled, so none of
# them appear in tex_files or in tex-versions.txt: they are invisible inputs that decide the whole
# 156 MiB artifact. When a rebuild produced a different dump with every visible input identical,
# there was no way to tell whether the kernel had moved or the build had become nondeterministic.
# Now there is: this hash covers their contents, so a dump that differs while this matches is a
# nondeterministic build, and a dump that differs because this differs is Ubuntu shipping a LaTeX
# update. Two very different problems that looked the same.
FORMAT_INPUTS=$(node -e '
const fs = require("fs"), crypto = require("crypto");
const used = JSON.parse(fs.readFileSync("web2js/initex-files.json", "utf8"));
const hash = crypto.createHash("sha256");
for (const name of Object.keys(used).sort()) {
    const path = used[name];
    hash.update(name);
    try { hash.update(fs.readFileSync(path)); } catch { hash.update("<unreadable>"); }
}
process.stdout.write(hash.digest("hex").slice(0, 32));
')
[ -n "$FORMAT_INPUTS" ] || die "could not hash the format inputs — is web2js/initex-files.json there?"

# No build date. This file is committed with the engine it describes, and a timestamp would make
# every rebuild a diff — which would turn the reproducibility check in the Engine workflow into a
# clock comparison. When it was built is what `git log` is for; what it was built FROM is here.
cat > "$OUT/BUILD-MANIFEST.txt" <<MANIFEST
tikzjax engine build
texlive flavour  ${TEXLIVE_FLAVOUR:-unknown}
format inputs    ${FORMAT_INPUTS} (sha256 over the 146 files latex.ltx pulled in)
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
# On Linux the container runs as root and writes into a bind mount, so everything in out/ comes out
# owned by root and the next step — smoke, which writes out/smoke — dies with EACCES. Docker Desktop
# virtualises ownership, so this only ever bites on CI and on a Linux workstation. scripts/engine-run.mjs
# passes the host's uid/gid when it has them; without them this is a no-op.
if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ]; then
    # Not fatal. Everything is already written by this point, and a mount that will not take a
    # chown should cost a warning rather than the whole ten-minute build.
    if chown -R "$HOST_UID:$HOST_GID" "$OUT" 2>/dev/null; then
        ok "out/ handed back to ${HOST_UID}:${HOST_GID}"
    else
        printf '    \033[33m!\033[0m could not chown %s to %s:%s — later steps may hit EACCES\n' \
            "$OUT" "$HOST_UID" "$HOST_GID"
    fi
fi

log "Done. Artifacts in $OUT"
ls -la "$OUT"
