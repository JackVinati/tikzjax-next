# Installation profile for TUG's net installer (TEXLIVE=net).
#
# scheme-full because tex_files.json reaches broadly across the distribution and a narrower
# scheme fails at gen-tex-files time with a bare "Unable to locate X" that is easy to miss.
# Docs and sources are skipped: they are roughly two thirds of the download and nothing in this
# build reads them.
selected_scheme scheme-full

TEXDIR /usr/local/texlive/tl
TEXMFLOCAL /usr/local/texlive/texmf-local
TEXMFSYSCONFIG /usr/local/texlive/tl/texmf-config
TEXMFSYSVAR /usr/local/texlive/tl/texmf-var
TEXMFCONFIG ~/.texlive/texmf-config
TEXMFHOME ~/texmf
TEXMFVAR ~/.texlive/texmf-var

instopt_adjustpath 1
instopt_adjustrepo 1
instopt_letter 0
instopt_portable 0
instopt_write18_restricted 1

tlpdbopt_autobackup 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
tlpdbopt_create_formats 1
