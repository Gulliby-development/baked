#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cp "$HERE/hidden/check.ts" ./hidden-check.test.ts
bun test ./hidden-check.test.ts
printf 'name,amount\n"Smith, J",2.5\nLee,\nKim,4\n' > /tmp/bench-suite-sum.csv
test "$(bun src/cli.ts /tmp/bench-suite-sum.csv amount)" = "6.5"
if bun src/cli.ts /tmp/bench-suite-sum.csv missing 2>/dev/null; then exit 1; fi
