#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p Tests/SemVerTests
cp "$HERE/hidden/HiddenCheckTests.swift" Tests/SemVerTests/HiddenCheckTests.swift
swift test --filter HiddenCheckTests
