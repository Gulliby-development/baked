Write a bash script `bin/wordfreq.sh` that reads text on standard input and prints how often each word occurs:

- A word is a run of ASCII letters, compared without case (`The` and `the` are one word, printed lowercased).
- Each output line is the count, one space and the word (`3 the`), sorted by count, highest first, then by word in ascending order.
- An optional argument `N` prints only the first `N` lines; an argument that is not a positive integer prints `usage: wordfreq.sh [N]` to standard error and exits with status 2.
- Empty input prints nothing.

The script must be executable, run under `bash` on Linux and macOS (bash 3.2: no associative arrays), pass `shellcheck` with the given `.shellcheckrc` and be formatted with `shfmt` per the given `.editorconfig`. Add bats tests in `test/wordfreq.bats` runnable with `bats test`, and a README.md.
