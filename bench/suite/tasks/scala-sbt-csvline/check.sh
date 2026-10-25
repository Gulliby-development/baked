#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p src/test/scala
cp "$HERE"/hidden/*.scala src/test/scala/
sbt -batch "testOnly HiddenCheck*"
