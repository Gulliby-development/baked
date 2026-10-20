#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p src/test/kotlin
cp "$HERE/hidden/HiddenCheckTest.kt" src/test/kotlin/HiddenCheckTest.kt
gradle test --quiet --console=plain --tests HiddenCheckTest
