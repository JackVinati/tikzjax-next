The \ifincsname primitive, as pdfTeX has it: true while TeX is expanding the tokens between
\csname or \ifcsname and the \endcsname that ends them, false everywhere else.

LaTeX defines ~ as \ifincsname ... \else \nobreakspace \fi, so without the primitive every ~ in a
diagram gave three errors and printed a stray tilde. LaTeX's utf8.def also tests for it, and on an
engine without it falls back to utf8-2018.def, which pdfTeX has not loaded since 2018.

Each change below is pdfTeX's own (pdftex.web), in the order tie needs: the flag is saved and set
around \csname's expansion in |expand| and \ifcsname's in |conditional|, and restored after it,
so a \csname inside a \csname leaves the outer one's flag as it found it. Applied after every
change file web2js applies (engine-build/build-engine.sh, internal/DECISIONS.md D16).

@x
procedure expand;
label reswitch;
var t:halfword; {token that is being ``expanded after''}
@y
procedure expand;
label reswitch;
var t:halfword; {token that is being ``expanded after''}
@!b:boolean; {keep track of nested csnames}
@z

@x
@ @<Manufacture a control...@>=
begin r:=get_avail; p:=r; {head of the list of characters}
repeat get_x_token;
if cur_cs=0 then store_new_token(cur_tok);
until cur_cs<>0;
if cur_cmd<>end_cs_name then @<Complain about missing \.{\\endcsname}@>;
@y
@ @<Glob...@>=
@!is_in_csname: boolean;

@ @<Set init...@>=
is_in_csname := false;

@ @<Manufacture a control...@>=
begin r:=get_avail; p:=r; {head of the list of characters}
b := is_in_csname; is_in_csname := true;
repeat get_x_token;
if cur_cs=0 then store_new_token(cur_tok);
until cur_cs<>0;
if cur_cmd<>end_cs_name then @<Complain about missing \.{\\endcsname}@>;
is_in_csname := b;
@z

@x
var b:boolean; {is the condition true?}
@y
var b:boolean; {is the condition true?}
@!e:boolean; {keep track of nested csnames}
@z

@x
@d if_font_char_code=19 { `\.{\\iffontchar}' }
@y
@d if_font_char_code=19 { `\.{\\iffontchar}' }
@d if_in_csname_code=20 { `\.{\\ifincsname}' }
@z

@x
primitive("iffontchar",if_test,if_font_char_code);
@!@:if_font_char_}{\.{\\iffontchar} primitive@>
@y
primitive("iffontchar",if_test,if_font_char_code);
@!@:if_font_char_}{\.{\\iffontchar} primitive@>
primitive("ifincsname",if_test,if_in_csname_code);
@!@:if_in_csname_}{\.{\\ifincsname} primitive@>
@z

@x
if_font_char_code:print_esc("iffontchar");
@y
if_font_char_code:print_esc("iffontchar");
if_in_csname_code:print_esc("ifincsname");
@z

@x
if_cs_code:begin n:=get_avail; p:=n; {head of the list of characters}
  repeat get_x_token;
  if cur_cs=0 then store_new_token(cur_tok);
  until cur_cs<>0;
  if cur_cmd<>end_cs_name then @<Complain about missing \.{\\endcsname}@>;
  @<Look up the characters of list |n| in the hash table, and set |cur_cs|@>;
  flush_list(n);
  b:=(eq_type(cur_cs)<>undefined_cs);
  end;
@y
if_cs_code:begin n:=get_avail; p:=n; {head of the list of characters}
  e := is_in_csname; is_in_csname := true;
  repeat get_x_token;
  if cur_cs=0 then store_new_token(cur_tok);
  until cur_cs<>0;
  if cur_cmd<>end_cs_name then @<Complain about missing \.{\\endcsname}@>;
  @<Look up the characters of list |n| in the hash table, and set |cur_cs|@>;
  flush_list(n);
  b:=(eq_type(cur_cs)<>undefined_cs);
  is_in_csname := e;
  end;
@z

@x
if_font_char_code:begin scan_font_ident; n:=cur_val; scan_char_num;
  if (font_bc[n]<=cur_val)and(font_ec[n]>=cur_val) then
    b:=char_exists(char_info(n)(qi(cur_val)))
  else b:=false;
  end;
@y
if_font_char_code:begin scan_font_ident; n:=cur_val; scan_char_num;
  if (font_bc[n]<=cur_val)and(font_ec[n]>=cur_val) then
    b:=char_exists(char_info(n)(qi(cur_val)))
  else b:=false;
  end;

@ @<Cases for |conditional|@>=
if_in_csname_code: b := is_in_csname;
@z
