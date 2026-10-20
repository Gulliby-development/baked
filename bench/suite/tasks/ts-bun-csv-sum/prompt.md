Write a small Bun command-line tool in TypeScript that sums a column of a CSV file.

- `src/csv.ts` exports `sumColumn(csv: string, column: string): number`. The first line is the header. Fields may be quoted with `"` and a quoted field may contain commas. Empty cells count as 0; a non-numeric cell throws an `Error` naming its line number; an unknown column throws an `Error` naming the column.
- `src/cli.ts` runs as `bun src/cli.ts FILE COLUMN`, prints the sum, and exits 1 with the error message on stderr on any error.

Add `bun:test` tests under `tests/` and a README.md with an example.
