Write a Go package `wordwrap` (module `example.com/wordwrap`, files in the repository root) with `func Wrap(text string, width int) []string`.

- Splits text into words on any whitespace and greedily fills lines of at most `width` characters (counted in runes), words joined by one space.
- A word longer than `width` goes on its own line unbroken.
- Empty or all-whitespace text returns an empty, non-nil slice; `width < 1` panics.

Add table-driven tests and a README.md with an example.
