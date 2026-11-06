# Build the NSIS installer for Windows.
#
# Wraps scripts/bundle-windows.ps1 + makensis. Runs on Windows (where makensis
# lives on PATH after `choco install nsis` / `winget install NSIS.NSIS`).
#
# Needs no third-party NSIS plugin: the .nsi edits the user PATH with the
# embedded packaging/windows/user-path.ps1 (#2864, which replaced EnVar).
#
# Usage:
#   pwsh scripts/build-installer.ps1                         # x64, builds zip first
#   pwsh scripts/build-installer.ps1 -Arch arm64
#   pwsh scripts/build-installer.ps1 -SkipBundle             # reuse existing dist/bundle/
#
# Output:
#   dist/bundle/baked-setup-<version>-<arch>.exe

param(
    # x64 only for v1.2 — ARM64 deferred until the upstream native dependency
    # publishes a win32-arm64 build. ValidateSet keeps the public surface honest.
    [ValidateSet("x64")]
    [string]$Arch = "x64",
    [switch]$SkipBundle
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $bundleName = "baked-$version-windows-$Arch"
    $bundleDir = Join-Path $repoRoot "dist/bundle/$bundleName"
    $output = Join-Path $repoRoot "dist/bundle/baked-setup-$version-$Arch.exe"

    if (-not $SkipBundle) {
        Write-Host "==> Bundling first (re-uses cached .exe if present)..."
        & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "bundle-windows.ps1") -Arch $Arch
        if ($LASTEXITCODE -ne 0) { throw "bundle-windows.ps1 failed (exit $LASTEXITCODE)" }
    }

    if (-not (Test-Path $bundleDir)) {
        throw "Bundle dir not found: $bundleDir (run without -SkipBundle to produce it)"
    }

    # ── makensis ───────────────────────────────────────────────────────
    $makensis = Get-Command makensis -ErrorAction SilentlyContinue
    if (-not $makensis) {
        throw @"
makensis not found on PATH. Install NSIS:
    winget install NSIS.NSIS        # preferred
    choco install nsis              # alternative
    brew install makensis           # macOS / cross-bundle from a mac
"@
    }

    # ── makensis invocation ───────────────────────────────────────────
    Write-Host "==> makensis: building baked-setup-$version-$Arch.exe"
    $nsi = Join-Path $repoRoot "packaging/windows/BAKED.nsi"
    # makensis flag prefix is `/` on Windows, `-` on Linux/macOS.
    $flagPrefix = if ($IsWindows) { "/" } else { "-" }
    & makensis `
        "${flagPrefix}DVERSION=$version" `
        "${flagPrefix}DBUNDLE_DIR=$bundleDir" `
        "${flagPrefix}DOUTPUT=$output" `
        "${flagPrefix}DARCH=$Arch" `
        $nsi
    if ($LASTEXITCODE -ne 0) { throw "makensis failed (exit $LASTEXITCODE)" }

    $size = "{0:N1} MB" -f ((Get-Item $output).Length / 1MB)
    Write-Host ""
    Write-Host "Installer ready: $output ($size)" -ForegroundColor Green
} finally {
    Pop-Location
}
