# Reproducible build environment for the TikZ/TeX WebAssembly engine.
#
# Produces tex.wasm + core.dump (from drgrice1/web2js) and the gzipped tex_files + font set
# (from drgrice1/tikzjax), which together are the engine this plugin ships. See
# internal/DECISIONS.md D8 for why this is in scope rather than a black box.
#
# Build:  docker build -t tikzjax-engine --build-arg TEXLIVE=apt engine-build
# Run:    docker run --rm -v "$PWD/engine-build/out:/out" tikzjax-engine
#
# TEXLIVE selects where the TeX *packages* come from, and is therefore the package-version pin:
#   apt  Ubuntu 24.04's texlive  -> TeX Live 2023. What upstream builds and tests against.
#   net  TUG net installer       -> whatever TeX Live is current on the day of the build. Not pinned,
#                                   so no versions are written here; TODO.md E1 keeps a dated list.
# Build apt first. It is the known-good path, and it tells you whether a later failure on `net`
# is the version bump or the pipeline.

FROM ubuntu:24.04

ARG TEXLIVE=apt

# Node runs the engine BUILD only — web2js's tangle/compile/asyncify/initex and tikzjax's font and
# tex_files pipeline — and none of it ships. It is pinned to an exact release, taken from
# nodejs.org's own archive and checked against its published SHA-256, the way bakoma.zip is below:
# that archive keeps every release forever, where a distribution repository drops old packages and
# would one day leave this image unbuildable. Exact, not a major, because BUILD-MANIFEST.txt records
# `node --version` and is committed — a floating major would surface every Node patch release as a
# change to the committed engine.
#
# 22, not 24 or 26: web2js's lockfile pins nan 2.22.0 for node-kpathsea, and nan 2.22.0's
# ScriptOrigin shim does not compile against the V8 in Node 24 and later (nodejs/nan#978). Node 20,
# used until 2026-10, has been end-of-life since April.
#
# MOVE OFF 22 BEFORE 2027-04-30, when it reaches end of life. Waiting for web2js to bump nan is not a
# plan: it has had no commit since 2025-01 and its one pull request was closed unmerged. The fix is
# local. node-kpathsea asks for nan ^2.19.0, and nan 2.27 supports Node 26, so in the web2js step
# below: `npm ci --ignore-scripts`, then `npm install --no-save --no-package-lock nan@<current>`, then
# `npm rebuild node-kpathsea` — in that order, because a plain `npm ci` compiles node-kpathsea against
# 2.22.0 and fails before anything can replace it, and an `overrides` entry makes `npm ci` refuse the
# lockfile. BUILD-MANIFEST.txt records `node --version`, so the bump must ship in one commit with a
# rebuilt engine-build/out, or the Engine check reports an engine that changed while its inputs did not.
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NONINTERACTIVE_SEEN=true \
    DEBCONF_NOWARNINGS=yes

# Common toolchain. libkpathsea-dev is required in both paths: web2js depends on node-kpathsea,
# a native binding, and TeX Live's net installer ships no development headers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --no-install-suggests \
        ca-certificates curl git gnupg g++ make perl unzip xz-utils \
        libkpathsea-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

RUN set -eu; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
        -o /tmp/node.tar.xz; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    [ "$(node --version)" = "v${NODE_VERSION}" ]

# --- TeX distribution -------------------------------------------------------------------------
# apt path: Ubuntu's texlive. Mirrors upstream's Dockerfile exactly.
RUN if [ "$TEXLIVE" = "apt" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends --no-install-suggests \
            texlive texlive-latex-extra texlive-latex-recommended texlive-plain-generic \
            texlive-science texlive-pictures texlive-fonts-extra \
        && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* ; \
    fi

# Regenerate the hyphenation config in a FIXED order. Debian's update-language writes
# language.dat (and language.def, language.dat.lua) by walking a Perl hash, and Perl randomises
# hash order per process — so every image build got a differently ordered language.dat. latex.ltx
# reads it while building the format, which made core.dump differ on every image with identical
# packages. That was misread for a month as "Ubuntu's TeX Live moved" (internal/DECISIONS.md D12):
# the packages never changed; this file did. Measured in the image: three plain runs, three
# different sha256; three runs with the seed pinned, one. The printed hash goes into the build
# log, so the next time two images disagree the cause is one line away.
RUN if [ "$TEXLIVE" = "apt" ]; then \
        PERL_HASH_SEED=0 PERL_PERTURB_KEYS=0 update-language \
        && echo "language.dat $(sha256sum "$(kpsewhich language.dat)" | cut -d' ' -f1)" ; \
    fi

# net path: current TeX Live. `tie` and `tangle` come from scheme-full, so no apt texlive is
# installed alongside — two distributions on one PATH is how you get a build that silently
# tangles one TeX against another's texmf tree.
COPY texlive.profile /tmp/texlive.profile
RUN if [ "$TEXLIVE" = "net" ]; then \
        mkdir -p /tmp/install-tl \
        && curl -fsSL https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz \
             | tar -xz -C /tmp/install-tl --strip-components=1 \
        && /tmp/install-tl/install-tl --profile=/tmp/texlive.profile \
        && rm -rf /tmp/install-tl ; \
    fi

# Both `tie`/`tangle` and node-kpathsea must resolve against the SAME texmf tree. On the net path
# libkpathsea comes from apt but the tree is TeX Live's, so kpathsea is pointed at TL's config
# explicitly. Verified by the `kpsewhich pgfplots.sty` assertion in build-engine.sh.
ENV PATH="/usr/local/texlive/tl/bin/x86_64-linux:${PATH}"
ENV TEXLIVE_FLAVOUR=${TEXLIVE}
RUN if [ "$TEXLIVE" = "net" ]; then \
        echo 'export TEXMFCNF=/usr/local/texlive/tl/texmf-dist/web2c' >> /etc/profile.d/texlive.sh ; \
    fi

# Upstream sources are cloned into the IMAGE, not on every run. Two reasons: a pinned ref that is
# re-fetched each build is not really pinned, and an anonymous clone is rate-limited — which is
# exactly how this build failed the first time it was run twice in one session. `docker run` is
# now fully offline. build-engine.sh asserts these SHAs against pins.env, so the two cannot drift.
ARG WEB2JS_REF=0114ef5905dc387b70e72c654bcedd3b52b29fad
ARG TIKZJAX_REF=461ac15f1c63351392115c4262d8179bc9922404

RUN git clone --quiet https://github.com/drgrice1/web2js.git /opt/src/web2js \
    && git -C /opt/src/web2js checkout --quiet "$WEB2JS_REF" \
    && git clone --quiet https://github.com/drgrice1/tikzjax.git /opt/src/tikzjax \
    && git -C /opt/src/tikzjax checkout --quiet "$TIKZJAX_REF"

# npm dependencies and the font archive are baked in too, so a build needs no registry, no CTAN
# mirror and no GitHub — `docker run` is entirely offline and therefore actually reproducible.
RUN cd /opt/src/web2js  && npm ci --no-audit --no-fund \
    && cd /opt/src/tikzjax && npm ci --no-audit --no-fund

# bakoma.zip is the Computer Modern Type 1 set the font pipeline converts to WOFF2. It is pinned
# by CONTENT, not by URL: mirrors.ctan.org is a redirector, so the mirror you get depends on where
# the build runs — one of them serves a certificate chain the container cannot verify, which is how
# this failed on a GitHub runner while succeeding locally. Try mirrors in order, take the first
# whose bytes match the pin, fail if none do. A truncated or tampered mirror cannot get in either.
ARG BAKOMA_SHA256=6fb67f2fdaf5846fe81734d04d69096b847d2b41ca6da7923a9a73437e588734
RUN set -eu; \
    for url in \
        https://mirrors.ctan.org/fonts/cm/ps-type1/bakoma.zip \
        https://ctan.math.illinois.edu/fonts/cm/ps-type1/bakoma.zip \
        https://mirrors.mit.edu/CTAN/fonts/cm/ps-type1/bakoma.zip \
        https://ftp.fau.de/ctan/fonts/cm/ps-type1/bakoma.zip \
        https://mirror.las.iastate.edu/tex-archive/fonts/cm/ps-type1/bakoma.zip ; do \
        echo "bakoma: $url"; \
        curl -fsSL --retry 3 --retry-delay 2 --max-time 600 "$url" -o /opt/src/bakoma.zip || continue; \
        if echo "$BAKOMA_SHA256  /opt/src/bakoma.zip" | sha256sum -c - >/dev/null 2>&1; then break; fi; \
        echo "bakoma: wrong checksum from $url, trying the next mirror" >&2; \
        rm -f /opt/src/bakoma.zip; \
    done; \
    echo "$BAKOMA_SHA256  /opt/src/bakoma.zip" | sha256sum -c -

COPY pins.env tex-files.extra.json tex-files.collected.json build-engine.sh collect-tex-files.sh /opt/engine-build/
RUN chmod +x /opt/engine-build/build-engine.sh /opt/engine-build/collect-tex-files.sh

WORKDIR /opt/engine-build
CMD ["/opt/engine-build/build-engine.sh"]
