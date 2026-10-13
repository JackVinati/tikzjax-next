\filesize of a file that does not exist expands to nothing, as it does in pdfTeX.

web2js's filesize.ch prints whatever the host's getfilesize returns, and both hosts returned 0 for
a file they did not have. LaTeX's \IfFileExists asks \filesize, and takes any answer that is not
empty for a file that exists: every missing package, every \input of a missing file and every
probe for an optional .cfg was found, and then read as an empty file. The hosts now return -1 for
a file they do not have (engine-src/library.ts, and web2js's library.js for the format build), and
\filesize prints the size only when there is one. Applied after every change file web2js applies
(engine-build/build-engine.sh, internal/DECISIONS.md D16).

@x
filesize_code: print_int(cur_val);
@y
filesize_code: if cur_val>=0 then print_int(cur_val);
@z
