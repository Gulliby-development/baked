Write a TypeScript module `src/slug.ts` for Bun that exports `slugify(text: string, maxLength = 60): string`.

- Lower-cases, removes accents (`Crème Brûlée` becomes `creme-brulee`), turns every run of characters other than `a-z` and `0-9` into one `-`, and trims `-` from both ends.
- Cuts the result to `maxLength` characters without leaving a trailing `-`.
- Returns an empty string when nothing is left.

Add `bun:test` tests under `tests/` and a README.md with an example.
