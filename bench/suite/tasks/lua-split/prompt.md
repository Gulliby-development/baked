Write a Lua 5.4 module `src/strutil.lua` that returns a table with `split(s, sep, plain)`.

- Splits `s` on `sep` and returns a list of the pieces, keeping empty pieces (`split("a,,b", ",")` is `{"a", "", "b"}`).
- With `plain = true` the separator is literal text; otherwise it is a Lua pattern.
- An empty separator raises an error.

Add a test script `tests/run.lua` runnable as `lua tests/run.lua` that exits non-zero on a failure, and a README.md.
