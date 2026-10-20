Write a PHP 8 library file `src/slug.php` (no Composer, no extensions beyond the defaults) defining `function slugify(string $text, string $separator = '-'): string`.

- Lower-cases, transliterates common Latin accents (`Crème Brûlée` becomes `creme-brulee`), replaces every run of other characters with the separator and trims it from both ends.
- Returns `''` when nothing is left.

Add a test script `tests/run.php` that exits non-zero on a failure, runnable as `php tests/run.php`, and a README.md.
