/**
 * Pester 5 (5.5 or later for `RenderMode` and `CIFormat`) with its exit code, in plain text: Pester
 * colours its output with escape codes even when it is redirected. `CIFormat = 'None'`: on a CI
 * runner (`GITHUB_ACTIONS`, `TF_BUILD`) Pester prefixes each failed test with `::error::` or
 * `##vso[task.logissue type=error]`, which the failed-test lines then miss. No `-CI`: it writes `testResults.xml` into
 * the checkout, which the run then sees as a change. The default verbosity names each failed test
 * by its full path (`Describe.It`) and leaves out the passing ones (#1498).
 */
export const PESTER_RUN = pesterOn(null);

/** The Pester command on `files` (single-quoted PowerShell paths), or on the whole tree. */
export function pesterOn(files: readonly string[] | null): string {
  const path = files?.length
    ? `; Path = @(${files.map((f) => `'${f.replaceAll("'", "''")}'`).join(", ")})`
    : "";
  return `Invoke-Pester -Configuration @{ Run = @{ Exit = $true${path} }; Output = @{ RenderMode = 'Plaintext'; CIFormat = 'None' } }`;
}
