#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p tests
cp "$HERE/hidden/hidden_check.rs" tests/hidden_check.rs
cargo test --quiet --test hidden_check
