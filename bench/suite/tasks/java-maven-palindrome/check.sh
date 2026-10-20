#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p src/test/java/com/example
cp "$HERE/hidden/HiddenCheckTest.java" src/test/java/com/example/HiddenCheckTest.java
mvn -B -q test -Dtest=HiddenCheckTest -Dsurefire.failIfNoSpecifiedTests=false
