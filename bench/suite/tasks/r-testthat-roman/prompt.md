`romanr` is an R package. Finish `R/roman.R`:

- `to_roman(x)` takes a numeric vector of whole numbers from 1 to 3999 and returns a character vector of the same length with their Roman numerals in standard subtractive form (`4` is `"IV"`, `1994` is `"MCMXCIV"`). An `NA` element gives `NA_character_`. A value outside 1 to 3999 or with a fractional part stops with an error whose message contains `out of range`.
- `from_roman(x)` takes a character vector and returns an integer vector of the same length. Letters may be upper or lower case and surrounding whitespace is ignored. `NA` gives `NA_integer_`. A string that is not a valid numeral in standard form (`"IIII"`, `"VX"`, `"IC"`, `"MMMM"`, `""`) stops with an error whose message contains `invalid numeral`.
- Both are exported and `from_roman(to_roman(1:3999))` is `1:3999`.

Write testthat tests in `tests/testthat/test-roman.R` covering both functions, including vectors with `NA` and the errors. The package must pass `lintr::lint_package()` with the default linters. Add a README.md with an example.
