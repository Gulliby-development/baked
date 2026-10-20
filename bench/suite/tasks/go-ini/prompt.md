Write a Go package `ini` (module `example.com/ini`, files in the repository root) with `func Parse(r io.Reader) (map[string]map[string]string, error)`.

- `[section]` lines start a section; keys before any section go in section `""`.
- `key = value` lines, with spaces around key and value trimmed; a later duplicate key replaces the earlier one.
- Blank lines and lines starting with `;` or `#` are ignored.
- Any other line returns an error that contains its 1-based line number, for example `line 3: ...`.

Add tests and a README.md with an example.
