Write a bash script `bin/slugify.sh` that prints a URL slug of its arguments, joined by spaces:

- ASCII letters are lowercased (`bin/slugify.sh "Hello World"` prints `hello-world`).
- Every run of characters that are not ASCII letters or digits becomes one `-`, with none at the start or end (`bin/slugify.sh "  Route 66 -- West! "` prints `route-66-west`).
- With no letters or digits it prints an empty line, and with no arguments it prints `usage: slugify.sh TEXT...` to standard error and exits with status 2.

The script must be executable, run under `bash` on Linux and macOS (bash 3.2: no `${var,,}`), pass `shellcheck` with the given `.shellcheckrc` and be formatted with `shfmt` per the given `.editorconfig`. Add bats tests in `test/slugify.bats` runnable with `bats test`, and a README.md.
