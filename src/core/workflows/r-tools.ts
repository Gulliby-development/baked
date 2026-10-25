/**
 * The R expressions the R gates run through `Rscript -e` (#1500). Each exits non-zero on a
 * finding, which `lintr` and `styler` do not do themselves.
 */

/**
 * testthat 3 with the check reporter, the one `R CMD check` uses: the default progress reporter
 * prints a spinner frame and running counts per file, which made every run's output differ. It is
 * named by its class, since the word `check` in `reporter = 'check'` made `isStaticCheck` take the
 * test gate for a linter, and the written-tests check skipped it. A
 * package (a `DESCRIPTION`) is loaded with `test_local`; a project of scripts runs
 * `tests/testthat` as a directory. Both stop with an error on a failed test.
 */
export const testthatRun = (pkg: boolean): string => testthatOn(null, pkg);

/** testthat on the given test files only, by its `filter` on their names (`test-sum.R` is `sum`). */
export function testthatOn(files: readonly string[] | null, pkg: boolean): string {
  const names = (files ?? []).map((f) =>
    (f.split("/").at(-1) ?? f).replace(/^test[-_]?/, "").replace(/\.[rR]$/, ""),
  );
  const filter = names.length
    ? `, filter = '^(${names.map((n) => n.replace(/[\\^$.|?*+()[\]{}]/g, "\\\\$&").replaceAll("'", "\\'")).join("|")})$'`
    : "";
  return pkg
    ? `testthat::test_local(reporter = testthat::CheckReporter$new()${filter})`
    : `testthat::test_dir('tests/testthat', reporter = testthat::CheckReporter$new()${filter})`;
}

/** lintr on the package or the directory, one `path:line:column: type: [linter] message` per lint. */
export const lintrRun = (pkg: boolean): string =>
  `l <- lintr::${pkg ? "lint_package()" : "lint_dir('.')"}; print(l); quit(status = as.integer(length(l) > 0))`;

/**
 * styler in dry mode, one `path: would be reformatted by styler` line per file it would change:
 * `dry = 'fail'` stops at the first such file with a long backtrace. `style_dir` leaves out
 * `renv` and `packrat`.
 */
const stylerList = (target: string): string =>
  `options(styler.quiet = TRUE); r <- ${target}; f <- sort(r$file[r$changed]); for (x in f) cat(x, ': would be reformatted by styler\\n', sep = ''); quit(status = as.integer(length(f) > 0))`;

export const STYLER_CHECK = stylerList("styler::style_dir('.', dry = 'on')");
/** The check on the files given after the expression (`Rscript -e ... a.R b.R`). */
export const STYLER_CHECK_FILES = stylerList("styler::style_file(commandArgs(TRUE), dry = 'on')");
/** The fixer: styles the files given after the expression. */
export const STYLER_FIX =
  "options(styler.quiet = TRUE); invisible(styler::style_file(commandArgs(TRUE)))";
