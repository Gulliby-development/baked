#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cp "$HERE/hidden/hidden.test.mjs" ./hidden-check.test.mjs
node --test ./hidden-check.test.mjs
