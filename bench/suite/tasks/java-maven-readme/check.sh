#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p src/test/java/com/example
cp "$HERE/hidden/HiddenCheckTest.java" src/test/java/com/example/HiddenCheckTest.java
mvn -B -q test -Dtest=HiddenCheckTest -Dsurefire.failIfNoSpecifiedTests=false
mvn -B -q package -DskipTests
test "$(java -cp target/classes com.example.Main encode 3 Hello, World)" = "Khoor, Zruog"
test "$(java -cp target/classes com.example.Main decode 29 Khoor)" = "Hello"
set +e; java -cp target/classes com.example.Main 2>/dev/null; code=$?; set -e
test "$code" = "2"
grep -q "java -cp target/classes com.example.Main" README.md
