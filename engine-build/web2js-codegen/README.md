# web2js code generation, changed

Three files of web2js's compiler (`pascal/`), replaced whole before TeX is compiled. Why, and what
it costs, is `internal/DECISIONS.md` D27.

- `function-declaration.js`: a procedure's scalar local variables, its result and its parameters are
  WebAssembly locals and parameters instead of slots on the shadow stack in linear memory. A variable
  whose address is taken stays in memory. Values are narrowed exactly as the store and load of their
  width would narrow them.
- `function-evaluation.js`: a call to such a procedure passes its arguments as call operands.
- `memory.js`: every use of a variable's base address is a copy of it, so that no expression node
  appears twice in the tree, where an optimisation that rewrites a node in place would change both.

The static memory image (globals and string literals), and so everything in the core dump but the
stale contents of the shadow stack at its top, is the same as web2js's own compiler produces.

Each file was written against web2js's own at the commit `engine-build/pins.env` pins.
`build-engine.sh` checks the sha256 of each of web2js's files before putting ours in its place, and
stops if one differs. When web2js moves: diff its new file against the old one, carry the change
into ours, update the sum in `build-engine.sh`, rebuild, and hold the result to `verify:golden` and
`verify:worker`, the stack floor among them.

These files keep web2js's style (four spaces, its own line length), so `git diff --no-index` against
the file each replaces shows only what changed. Prettier and ESLint leave them alone.
