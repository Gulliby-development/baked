#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
c++ -std=c++17 -Wall -Wextra -Werror -Isrc -o "$OUT/hidden_check" "$HERE/hidden/check.cpp" src/roman.cpp
"$OUT/hidden_check"
