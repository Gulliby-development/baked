#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cp "$HERE/hidden/HiddenCheckTests.cs" Calendar.Tests/HiddenCheckTests.cs
dotnet test Calendar.Tests --nologo --filter "FullyQualifiedName~HiddenCheckTests"
