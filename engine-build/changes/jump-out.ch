A fatal error closes TeX's files before the run ends, as tex.web says it should where the
compiler has no jump out of a procedure.

jump_out is where a fatal error, a capacity overflow and a hundredth error end up. In tex.web it
is `goto end_of_TEX`, which jumps over every procedure on the stack to the end of the program,
where close_files_and_terminate finishes the DVI file, closes the transcript and says so. The
engine has no such jump: the build makes it a call to the host's jumpOut, which ends the run
where it is (engine-build/build-engine.sh), so close_files_and_terminate never ran. A page
shipped before the error was left in TeX's output buffer, never reached the DVI file, and was
lost, and the transcript ended at the error.

Section 81 of tex.web: "Some Pascal compilers do not implement non-local goto statements. In
such cases the body of jump_out should simply be `close_files_and_terminate;' followed by a call
on some system procedure that quietly terminates the program." web2c's tex.ch does the same.
close_files_and_terminate is written to be safe after a fatal error (section 1333), and tex.web
already declares it ahead of jump_out (section 78). Applied after every change file web2js
applies (internal/DECISIONS.md D17).

@x
procedure jump_out;
begin goto end_of_TEX;
end;
@y
procedure jump_out;
begin close_files_and_terminate; goto end_of_TEX;
end;
@z
