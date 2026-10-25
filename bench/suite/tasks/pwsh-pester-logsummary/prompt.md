Finish `src/LogSummary.ps1`, a script that defines `Get-LogSummary`. It reads an application log where each line is `<ISO-8601 UTC time> <LEVEL> <component>: <message>`, for example `2026-10-01T12:00:03Z ERROR billing: card declined`.

- `Get-LogSummary -Path <file>` and `Get-Content <file> | Get-LogSummary` (lines from the pipeline) both work.
- It returns one object per level that occurs, with `Level`, `Count`, `First` and `Last` (the earliest and latest time of that level, as `[datetime]` in UTC), and `Components` (the distinct components of that level, sorted). The objects come in severity order `ERROR`, `WARN`, `INFO`, `DEBUG`.
- Levels are matched case-insensitively and reported in upper case. Blank lines are skipped. A line that does not match the format is skipped with a warning (`Write-Warning`) naming its line number, and never stops the summary.
- `-Since <datetime>` keeps only lines at or after that time.

Write Pester 5 tests in `tests/LogSummary.Tests.ps1` that cover the pipeline input, a malformed line and `-Since`. The code and tests must pass `Invoke-ScriptAnalyzer -Path . -Recurse -Severity ParseError,Error,Warning`. Add a README.md with a usage example.
