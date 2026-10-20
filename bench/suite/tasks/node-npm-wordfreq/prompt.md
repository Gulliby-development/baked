Write a Node.js ES module `src/wordfreq.js` (no dependencies) that exports `topWords(text, n)`.

- Words are runs of letters, digits and apostrophes, compared lower-cased.
- Returns an array of `{ word, count }` with the `n` most frequent words, ties in alphabetical order.
- Throws a `TypeError` when `text` is not a string or `n` is not a positive integer.

Add tests under `test/` using `node:test`, runnable with `npm test`, and a README.md.
