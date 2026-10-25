roman_values <- c(
  1000L, 900L, 500L, 400L, 100L, 90L, 50L, 40L, 10L, 9L, 5L, 4L, 1L
)
roman_symbols <- c(
  "M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"
)

#' Roman numerals of whole numbers from 1 to 3999.
#' @export
to_roman <- function(x) {
  ok <- is.na(x) | (x >= 1 & x <= 3999 & x == round(x))
  if (!all(ok)) {
    stop("value out of range: Roman numerals cover 1 to 3999")
  }
  vapply(x, function(n) {
    if (is.na(n)) {
      return(NA_character_)
    }
    out <- ""
    for (i in seq_along(roman_values)) {
      while (n >= roman_values[i]) {
        out <- paste0(out, roman_symbols[i])
        n <- n - roman_values[i]
      }
    }
    out
  }, character(1), USE.NAMES = FALSE)
}

#' Numbers of Roman numerals in standard form.
#' @export
from_roman <- function(x) {
  standard <- "^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$"
  vapply(x, function(s) {
    if (is.na(s)) {
      return(NA_integer_)
    }
    s <- toupper(trimws(s))
    if (!nzchar(s) || !grepl(standard, s)) stop("invalid numeral: ", s)
    total <- 0L
    for (i in seq_along(roman_values)) {
      while (startsWith(s, roman_symbols[i])) {
        total <- total + roman_values[i]
        s <- substr(s, nchar(roman_symbols[i]) + 1L, nchar(s))
      }
    }
    total
  }, integer(1), USE.NAMES = FALSE)
}
