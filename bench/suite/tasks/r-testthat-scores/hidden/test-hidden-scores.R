scores <- data.frame(
  student = c("ann", "bob", "cid", "ann", "bob", "cid", "dee"),
  subject = c("math", "math", "math", "art", "art", "art", "bio"),
  score = c(90, 95, 95, NA, 70, 80.555, NA),
  stringsAsFactors = FALSE
)

test_that("one row per subject in name order, with counts, means and the best student", {
  out <- summarise_scores(scores)
  expect_identical(names(out), c("subject", "n", "mean", "best", "missing"))
  expect_identical(out$subject, c("art", "bio", "math"))
  expect_identical(out$n, c(2L, 0L, 3L))
  expect_equal(out$mean, c(75.28, NA, 93.33))
  expect_identical(out$best, c("cid", NA, "bob"))
  expect_identical(out$missing, c(1L, 1L, 0L))
  expect_identical(rownames(out), as.character(1:3))
})

test_that("an empty frame gives the five columns and no rows", {
  out <- summarise_scores(scores[0, ])
  expect_identical(names(out), c("subject", "n", "mean", "best", "missing"))
  expect_identical(nrow(out), 0L)
})

test_that("a missing column is named in the error", {
  expect_error(summarise_scores(scores[, c("student", "score")]), "subject")
  expect_error(summarise_scores(scores[, c("subject", "score")]), "student")
})
