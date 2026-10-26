summarise_scores <- function(df) {
  needed <- c("student", "subject", "score")
  missing_columns <- setdiff(needed, names(df))
  if (length(missing_columns) > 0) {
    stop("missing column: ", paste(missing_columns, collapse = ", "))
  }
  subjects <- sort(unique(df$subject))
  rows <- lapply(subjects, function(s) {
    part <- df[df$subject == s, , drop = FALSE]
    known <- part[!is.na(part$score), , drop = FALSE]
    best <- NA_character_
    if (nrow(known) > 0) {
      top <- known$student[known$score == max(known$score)]
      best <- sort(top)[1]
    }
    data.frame(
      subject = s,
      n = nrow(known),
      mean = if (nrow(known) > 0) round(mean(known$score), 2) else NA_real_,
      best = best,
      missing = sum(is.na(part$score)),
      stringsAsFactors = FALSE
    )
  })
  if (length(rows) == 0) {
    return(data.frame(
      subject = character(), n = integer(), mean = numeric(),
      best = character(), missing = integer(), stringsAsFactors = FALSE
    ))
  }
  out <- do.call(rbind, rows)
  rownames(out) <- NULL
  out
}
