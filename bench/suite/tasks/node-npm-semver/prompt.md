Write a Node.js ES module `src/semver.js` (no dependencies) that exports `compare(a, b)` and `sort(versions)`.

- Versions are `MAJOR.MINOR.PATCH` with an optional `-prerelease` of dot-separated identifiers, following Semantic Versioning 2.0 precedence (`1.0.0-alpha` < `1.0.0-alpha.1` < `1.0.0-beta` < `1.0.0`; numeric identifiers compare numerically).
- `compare` returns -1, 0 or 1; `sort` returns a new ascending array.
- Invalid versions throw an `Error` that includes the bad string.

Add tests under `test/` using `node:test`, runnable with `npm test`, and a README.md.
