#!/usr/bin/env bash
# Hidden acceptance check: runs in the finished workspace; exit 0 means the task passed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
pwsh -NoProfile -NonInteractive -Command "\$c = New-PesterContainer -Path '$HERE/hidden/LogSummary.Hidden.Tests.ps1' -Data @{ Workspace = '$PWD' }; Invoke-Pester -Configuration @{ Run = @{ Container = \$c; Exit = \$true }; Output = @{ RenderMode = 'Plaintext' } }"
pwsh -NoProfile -NonInteractive -Command "Invoke-Pester -Configuration @{ Run = @{ Exit = \$true }; Output = @{ RenderMode = 'Plaintext' } }"
pwsh -NoProfile -NonInteractive -Command "Invoke-ScriptAnalyzer -Path . -Recurse -Severity ParseError,Error,Warning -EnableExit"
