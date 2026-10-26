#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
# Paths go inside a native program's own code here, where Git Bash on Windows does not
# translate them: `pwd -W` gives the Windows form there and fails elsewhere.
HERE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"
Rscript -e "source('R/scores.R'); testthat::test_file('$HERE/hidden/test-hidden-scores.R', reporter = testthat::CheckReporter\$new(), stop_on_failure = TRUE)"
Rscript -e "testthat::test_dir('tests/testthat', reporter = testthat::CheckReporter\$new())"
Rscript -e "l <- lintr::lint_dir('.'); print(l); quit(status = as.integer(length(l) > 0))"
