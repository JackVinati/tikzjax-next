A point a run can be saved at and started again from, so that a later diagram with the same
preamble starts where this one stood once its \begin{document} was done.

\tikzjaxsnapshot is \ignorespaces with one thing added first: TeX sets resume_pending to 1, calls
the host's snapshotPoint, and sets resume_pending back to 0. The host may copy TeX's memory during
the call, and then holds an image of TeX as it stood at that command, with resume_pending 1 in it.
A run that starts from such an image finds resume_pending 1 at the top of the program, skips all
the program does before main_control (the output and input routines, the first line from the
terminal, \everyjob), and main_control carries on where the command left off: it skips spaces as
\ignorespaces does and goes on with the first token that is not one. Every other part of TeX's
state is in its memory, the input stack and the token lists it is reading among them, so the run
goes on as the one that saved it did; the host puts back what it keeps outside the memory, its
table of files (engine-src/library.ts).

Nothing can be pending in the WebAssembly call stack when the copy is made, because the command is
carried out by main_control itself, where it dispatches a command: the call stack is the program,
main_control and the host. That is why it is a command of main_control's own and not an
expandable one, which would be carried out inside whatever was expanding it.

The format calls it from LaTeX's begindocument/end hook, with the code the engine build adds
there (engine-build/build-engine.sh), so the input TeX reads is the block's as it was, byte for
byte. A host that wants no copy returns from snapshotPoint at once. \tracingcommands does not show
the command: it is the engine's, at the end of every \begin{document}, and a transcript traced
with it would otherwise show one more line than it did before the snapshot.

@x [1] - a label to resume at
@d final_end=9999 {this label marks the ending of the program}
@y
@d final_end=9999 {this label marks the ending of the program}
@d resume_here=2 {go here when a run resumes from a saved image}
@z

@x [1]
start_of_TEX@t\hskip-2pt@>, end_of_TEX@t\hskip-2pt@>,@,final_end;
@y
start_of_TEX@t\hskip-2pt@>, end_of_TEX@t\hskip-2pt@>,@,final_end,@,resume_here;
@z

@x [18] - the primitive
primitive("ignorespaces",ignore_spaces,0);@/
@y
primitive("ignorespaces",ignore_spaces,0);@/
primitive("tikzjaxsnapshot",ignore_spaces,1);@/
@z

@x [18]
ignore_spaces: print_esc("ignorespaces");
@y
ignore_spaces: if chr_code=0 then print_esc("ignorespaces")
  @+else print_esc("tikzjaxsnapshot");
@z

@x [45] - main_control resumes where \tikzjaxsnapshot left off
begin if every_job<>null then begin_token_list(every_job,every_job_text);
big_switch: get_x_token;@/
@y
begin if resume_pending=1 then
  begin resume_pending:=0; @<Get the next non-blank non-call token@>;
  goto reswitch;
  end;
if every_job<>null then begin_token_list(every_job,every_job_text);
big_switch: get_x_token;@/
@z

@x [45] - not shown by \tracingcommands
if tracing_commands>0 then show_cur_cmd_chr
@y
if tracing_commands>0 then
  if (cur_cmd<>ignore_spaces)or(cur_chr=0) then show_cur_cmd_chr
@z

@x [45] - \tikzjaxsnapshot
any_mode(ignore_spaces): begin @<Get the next non-blank non-call...@>;
@y
any_mode(ignore_spaces): begin if cur_chr=1 then
    begin resume_pending:=1; snapshot_point(); resume_pending:=0;
    end;
  @<Get the next non-blank non-call...@>;
@z

@x [51] - the flag
@!ready_already:integer; {a sacrifice of purity for economy}
@y
@!ready_already:integer; {a sacrifice of purity for economy}
@!resume_pending:integer; {1 in an image saved by \.{\\tikzjaxsnapshot}}
@z

@x [51] - a run from such an image goes straight to main_control
@p begin @!{|start_here|}
history:=fatal_error_stop; {in case we quit during initialization}
@y
@p begin @!{|start_here|}
if resume_pending=1 then goto resume_here;
history:=fatal_error_stop; {in case we quit during initialization}
@z

@x [51]
main_control; {come to life}
@y
resume_here: main_control; {come to life}
@z
