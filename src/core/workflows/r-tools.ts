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

const LINT_LINES =
  "for (x in l) cat(sprintf('%s:%d:%d: %s: [%s] %s\\n', x$filename, x$line_number, x$column_number, x$type, x$linter, x$message), sep = '')";

/**
 * Where styler is installed it owns indentation, and the lints `l` keep no `indentation_linter` lint
 * (#2948). The format-written check styles every R file a task writes when styler is there (#2817),
 * and styler indents a multi-line `if` condition 2 past its first line, where lintr's default
 * `indentation_linter` asks for 6 and none of its `hanging_indent_style` values takes 2: no text
 * passed both, and in R101 turntrim the red lintr check opened 16 correctives. Without styler nothing restyles a file, so
 * lintr keeps the rule. The package name is split so the lint command never names styler, which
 * `FORMAT_COMMAND` (`check-policy.ts`) would read as a formatter check. It holds no `$` or `"`, so
 * a shell's double quotes keep it as written (the edit tools' lint profile, `project.ts`).
 */
export const STYLER_OWNS_INDENTATION =
  "if (requireNamespace(paste0('sty', 'ler'), quietly = TRUE)) l <- l[vapply(l, function(x) x[['linter']] != 'indentation_linter', logical(1))]";

/** The lintr call on the package (`DESCRIPTION`) or on the directory. */
const lintrCall = (pkg: boolean): string => `lintr::${pkg ? "lint_package()" : "lint_dir('.')"}`;

/**
 * lintr on the package or the directory, one `path:line:column: type: [linter] message` per lint.
 * The lines are written here, not by `print`: under `GITHUB_ACTIONS` lintr prints GitHub
 * `::warning file=...` annotations instead, which the diagnostic count does not read.
 */
export const lintrRun = (pkg: boolean): string =>
  `l <- ${lintrCall(pkg)}; ${STYLER_OWNS_INDENTATION}; ${LINT_LINES}; quit(status = as.integer(length(l) > 0))`;

/** lintr as the edit tools' lint command runs it: lintr's own print of the lints the gate keeps. */
export const lintrPrint = (pkg: boolean): string =>
  `l <- ${lintrCall(pkg)}; ${STYLER_OWNS_INDENTATION}; print(l)`;

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
