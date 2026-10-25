Write a TypeScript module `src/query.ts` for Bun that exports `evaluate(query: string, value: unknown): unknown`. It evaluates a small path query against a JSON value:

- A query starts with `$` (the whole value), followed by segments: `.name` selects a property of an object (a name is ASCII letters, digits and `_`, not starting with a digit), `[n]` selects element `n` of an array (`n` is a non-negative decimal integer without leading zeros: in `[02]` the `2` is the first character that does not fit).
- A segment that selects nothing (a missing property, an index past the end, a property of a non-object, an index of a non-array) gives `undefined`.
- A query has at most ten segments. A deeper query throws an `Error` whose message is `depth limit exceeded at segment N`, where `N` is the first segment past the limit, before anything is selected.
- Any other syntax throws an `Error` whose message is `invalid query at offset N`, where `N` is the zero-based offset of the first character that does not fit.

Examples, to copy exactly:

| query | value | result |
| --- | --- | --- |
| `$[0][0][0][0][0][0][0][0][0][0]` | ten nested one-element arrays around `7` | `7` |
| `$[0][0][0][0][0][0][0][0][0][0][0]` | anything | throws `depth limit exceeded at segment 11` |
| `$.a.b.c.d.e.f.g.h.i.j.k` | anything | throws `depth limit exceeded at segment 11` |
| `$.items[2].name` | `{"items":[{},{},{"name":"x"}]}` | `"x"` |
| `$.items[02]` | anything | throws `invalid query at offset 9` |
| `$..a` | anything | throws `invalid query at offset 2` |

Add `bun:test` tests under `tests/` that use these rows as written, and a README.md with an example.
