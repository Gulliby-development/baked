#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p test
cp "$HERE/hidden/hidden_check_test.dart" test/hidden_check_test.dart
dart test test/hidden_check_test.dart
