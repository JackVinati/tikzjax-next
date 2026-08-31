# Reproducible build environment for the TikZ/TeX WebAssembly engine.
#
# Produces tex.wasm + core.dump (from drgrice1/web2js) and the gzipped tex_files + font set
# (from drgrice1/tikzjax), which together are the engine this plugin ships. See
# docs/DECISIONS.md D8 for why this is in scope rather than a black box.
#
# Build:  docker build -t tikzjax-engine --build-arg TEXLIVE=apt engine-build
# Run:    docker run --rm -v "$PWD/engine-build/out:/out" tikzjax-engine
#
# TEXLIVE selects where the TeX *packages* come from, and is therefore the package-version pin:
#   apt  Ubuntu 24.04's texlive  -> TeX Live 2023. What upstream builds and tests against.
#   net  TUG net installer       -> current TeX Live: pgf 3.1.12, pgfplots 1.18.3, circuitikz 1.8.6.
# Build apt first. It is the known-good path, and it tells you whether a later failure on `net`
# is the version bump or the pipeline.

FROM ubuntu:24.04

ARG TEXLIVE=apt
ARG NODE_MAJOR=20

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NONINTERACTIVE_SEEN=true \
    DEBCONF_NOWARNINGS=yes

# Common toolchain. libkpathsea-dev is required in both paths: web2js depends on node-kpathsea,
# a native binding, and TeX Live's net installer ships no development headers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --no-install-suggests \
        ca-certificates curl git gnupg g++ make perl unzip xz-utils \
        libkpathsea-dev \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends --no-install-suggests nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# --- TeX distribution -------------------------------------------------------------------------
# apt path: Ubuntu's texlive. Mirrors upstream's Dockerfile exactly.
RUN if [ "$TEXLIVE" = "apt" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends --no-install-suggests \
            texlive texlive-latex-extra texlive-latex-recommended texlive-plain-generic \
            texlive-science texlive-pictures texlive-fonts-extra \
        && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* ; \
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

ARG BAKOMA_URL=https://mirrors.ctan.org/fonts/cm/ps-type1/bakoma.zip
RUN curl -fsSL "$BAKOMA_URL" -o /opt/src/bakoma.zip \
    && test -s /opt/src/bakoma.zip

COPY pins.env tex-files.extra.json tex-files.collected.json build-engine.sh collect-tex-files.sh /opt/engine-build/
RUN chmod +x /opt/engine-build/build-engine.sh /opt/engine-build/collect-tex-files.sh

WORKDIR /opt/engine-build
CMD ["/opt/engine-build/build-engine.sh"]
