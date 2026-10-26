test_that("to_roman writes subtractive numerals and keeps NA", {
  expect_identical(to_roman(c(4, 1994, NA)), c("IV", "MCMXCIV", NA_character_))
  expect_error(to_roman(4000), "out of range")
})

test_that("from_roman reads any case and rejects non-standard numerals", {
  expect_identical(from_roman(c("iv", NA)), c(4L, NA_integer_))
  expect_error(from_roman("IIII"), "invalid numeral")
  expect_identical(from_roman(to_roman(1:3999)), 1:3999)
})
