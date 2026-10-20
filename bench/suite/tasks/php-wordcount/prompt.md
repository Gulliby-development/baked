Write a PHP 8 library file `src/wordcount.php` (no Composer) defining `function word_counts(string $text): array`.

- Returns an array of word to count, words compared lower-case, where a word is a run of letters, digits or apostrophes (Unicode letters included).
- The array is sorted by count descending, then by word ascending.

Add a test script `tests/run.php` that exits non-zero on a failure, runnable as `php tests/run.php`, and a README.md.
