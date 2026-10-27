This is an R analysis project (scripts, not a package). Finish `R/scores.R`, which defines `summarise_scores(df)`:

- `df` is a data frame with columns `student` (character), `subject` (character) and `score` (numeric, may be `NA`).
- It returns a data frame with one row per subject, sorted by subject name, and the columns `subject`, `n` (the number of non-`NA` scores, an integer), `mean` (their mean, rounded to 2 decimals), `best` (the student with the highest score; on a tie the one first in alphabetical order) and `missing` (the number of `NA` scores, an integer). Rows have no row names beyond 1 to n.
- A subject whose scores are all `NA` still appears, with `n = 0`, and `mean` and `best` both `NA`.
- An empty data frame with these columns gives a data frame with these five columns and no rows. A data frame missing one of the three columns stops with an error whose message names the missing column.

The tests in `tests/testthat` load the code with `source("../../R/scores.R")`. Write tests in `tests/testthat/test-scores.R` that cover ties, `NA` scores and the errors. The project must pass `lintr::lint_dir('.')` with the default linters. Add a README.md with an example.
