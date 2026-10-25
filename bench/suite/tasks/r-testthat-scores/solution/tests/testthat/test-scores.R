source("../../R/scores.R")

test_that("ties go to the first student by name and NA scores are counted", {
  df <- data.frame(
    student = c("bob", "ann", "cid"), subject = "math", score = c(9, 9, NA)
  )
  out <- summarise_scores(df)
  expect_identical(out$best, "ann")
  expect_identical(out$missing, 1L)
  expect_identical(out$n, 2L)
})

test_that("a missing column is an error", {
  expect_error(summarise_scores(data.frame(student = "a")), "subject")
})
