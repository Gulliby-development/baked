test_that("to_roman writes standard numerals", {
  expect_identical(to_roman(c(1, 4, 9, 14, 40, 90, 400, 1994, 2024, 3999)),
                   c("I", "IV", "IX", "XIV", "XL", "XC", "CD", "MCMXCIV", "MMXXIV", "MMMCMXCIX"))
  expect_identical(to_roman(c(3, NA, 5)), c("III", NA_character_, "V"))
  expect_identical(to_roman(integer()), character())
})

test_that("to_roman rejects values outside 1 to 3999", {
  for (bad in list(0, 4000, -1, 2.5)) expect_error(to_roman(bad), "out of range")
})

test_that("from_roman reads numerals in any case", {
  expect_identical(from_roman(c("MCMXCIV", "mmxxiv", " xl ", NA)), c(1994L, 2024L, 40L, NA_integer_))
  expect_identical(from_roman(to_roman(1:3999)), 1:3999)
})

test_that("from_roman rejects numerals not in standard form", {
  for (bad in c("IIII", "VX", "IC", "MMMM", "", "ABC", "IIV", "XM")) expect_error(from_roman(bad), "invalid numeral")
})
