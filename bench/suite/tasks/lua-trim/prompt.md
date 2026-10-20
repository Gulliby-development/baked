Write a Lua 5.4 module `src/text.lua` that returns a table with `trim(s)`, `starts_with(s, prefix)` and `pad_left(s, width, char)`.

- `trim` removes leading and trailing whitespace.
- `starts_with` compares literally, so pattern characters in `prefix` are plain text.
- `pad_left` pads with `char` (default a space) up to `width` characters and returns `s` unchanged when it is already that long; a `char` that is not exactly one character raises an error.

Add a test script `tests/run.lua` runnable as `lua tests/run.lua` that exits non-zero on a failure, and a README.md.
