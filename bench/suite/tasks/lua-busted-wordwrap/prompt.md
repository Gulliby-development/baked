Write a Lua module `src/wordwrap.lua` that returns a table with `wrap(text, width)`, which wraps text at word boundaries and returns the lines as a list:

- Words are runs of characters other than spaces, tabs and newlines; any run of whitespace between two words counts as one space.
- Each line holds as many words as fit in `width` characters, joined by single spaces, with no space at either end (`wrap("the quick brown fox", 10)` is `{"the quick", "brown fox"}`).
- A word longer than `width` stands on a line of its own and is not split.
- A text with no words gives an empty list, and a `width` below 1 raises an error.

Add busted specs in `spec/wordwrap_spec.lua` runnable with `busted` (the given `.busted` puts `src/` on the module path), keep the code clean under `luacheck` with the given `.luacheckrc` and formatted with `stylua` with the given `stylua.toml`, and add a README.md.
