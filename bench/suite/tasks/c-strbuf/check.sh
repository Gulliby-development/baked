#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p build
cc -std=c11 -Wall -Wextra -Werror -Isrc -o build/hidden_check "$HERE/hidden/check.c" src/*.c
./build/hidden_check
