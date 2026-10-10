# baked Windows bundle script
#
# Produces dist/bundle/baked-<version>-windows-<arch>.zip containing:
#   baked.exe
#   deps/
#     native/win32-<arch>/opentui.dll
#     workers/intelligence.worker.js
#     workers/io.worker.js
#     wasm/tree-sitter.wasm + grammars
#     opentui-assets/...
#
# The runtime resolver (scripts/build.ts patches the bundle at compile time)
# looks first in %LOCALAPPDATA%\baked\native\<triplet>\, then beside the
# .exe in deps/native/<triplet>\. install.ps1 (or a manual unzip) drops
# the deps/ tree next to baked.exe and the binary self-heals on first
# run by copying everything into %LOCALAPPDATA%.
#
# Usage (from repo root, on any OS with PowerShell 5.1+ or pwsh):
#   pwsh scripts/bundle-windows.ps1            # defaults to x64
#   pwsh scripts/bundle-windows.ps1 -Arch arm64
#
# Cross-bundles from macOS/Linux fine because Bun's --compile target is
# fully cross-platform. The only Windows-specific step is unzipping, which
# Compress-Archive handles natively.

param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64",
    [switch]$NoExe
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $triplet = "win32-$Arch"
    $bundleName = "baked-$version-windows-$Arch"
    $stageDir = Join-Path $repoRoot "dist/bundle/$bundleName"
    $depsDir = Join-Path $stageDir "deps"
    $nativeDir = Join-Path $depsDir "native/$triplet"

    Write-Host "==> Bundling baked $version for windows/$Arch"

    if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $depsDir "workers") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $depsDir "wasm") -Force | Out-Null

    if (-not $NoExe) {
        Write-Host "==> Compiling baked-windows-$Arch.exe"
        $bunTarget = if ($Arch -eq "arm64") { "bun-windows-arm64" } else { "bun-windows-x64" }
        $exeOut = Join-Path $stageDir "baked.exe"
        & bun scripts/build.ts --compile --target=$bunTarget --outfile=$exeOut
        if ($LASTEXITCODE -ne 0) { throw "bun build failed (exit $LASTEXITCODE)" }
    } else {
        $existing = Join-Path $repoRoot "bin/baked-windows-$Arch.exe"
        if (-not (Test-Path $existing)) { throw "Pre-built exe not found: $existing" }
        Copy-Item $existing (Join-Path $stageDir "baked.exe") -Force
    }
    Write-Host "    OK baked.exe"

    # OpenTUI native DLL. Bun on non-win32 hosts skips win32 optionals even
    # with --include=optional, so when cross-bundling from macOS/Linux we
    # fetch the tarball directly from the npm registry (no npm CLI — Bun-only
    # toolchain rule) and stage opentui.dll into node_modules so the runtime
    # resolver layout matches a real install.
    $opentuiPkg = Join-Path $repoRoot "node_modules/@opentui/core-$triplet"
    $opentuiDll = Join-Path $opentuiPkg "opentui.dll"
    if (-not (Test-Path $opentuiDll)) {
        Write-Host "    fetching @opentui/core-$triplet from npm registry..."
        $coreVersion = (Get-Content (Join-Path $repoRoot "node_modules/@opentui/core/package.json") -Raw | ConvertFrom-Json).version
        $tmpPull = Join-Path ([System.IO.Path]::GetTempPath()) "baked-otui-$triplet"
        if (Test-Path $tmpPull) { Remove-Item $tmpPull -Recurse -Force }
        New-Item -ItemType Directory -Path $tmpPull -Force | Out-Null
        Push-Location $tmpPull
        try {
            $pkgPath = "@opentui%2fcore-$triplet"
            $tarballUrl = "https://registry.npmjs.org/$pkgPath/-/core-$triplet-$coreVersion.tgz"
            $tgzPath = Join-Path $tmpPull "core-$triplet-$coreVersion.tgz"
            Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath
            if (-not (Test-Path $tgzPath)) { throw "tarball fetch failed: $tarballUrl" }
            & tar -xzf $tgzPath
            if (-not (Test-Path "package/opentui.dll")) { throw "extracted tarball is missing opentui.dll" }
            New-Item -ItemType Directory -Path $opentuiPkg -Force | Out-Null
            Copy-Item "package/opentui.dll" $opentuiPkg -Force
            Copy-Item "package/package.json" $opentuiPkg -Force
            if (Test-Path "package/index.ts") { Copy-Item "package/index.ts" $opentuiPkg -Force }
        } finally {
            Pop-Location
            Remove-Item $tmpPull -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-Path $opentuiDll)) {
        throw "opentui.dll still missing after fetch attempt: $opentuiDll"
    }
    Copy-Item $opentuiDll $nativeDir -Force
    Write-Host "    OK opentui.dll"

    # Use --outdir + --entry-naming because Bun may emit multiple chunks for
    # the intelligence worker (code-splitting via dynamic imports of ts-morph,
    # tree-sitter, etc.). --outfile only accepts a single output file.
    #
    # --external is scoped to binary asset extensions only. TUI packages USED
    # to be externalised here too as a 2.18.x workaround; that left unresolved
    # require("@opentui/core") calls in the worker JS which crashed at startup
    # with "Worker has been terminated". The real fix is in the source — see
    # bundle.sh comment + scripts/build.ts leak canary for context.
    $workersDir = Join-Path $depsDir "workers"
    $workerExternals = @(
        "--external", "*.node",
        "--external", "*.wasm",
        "--external", "*.scm"
    )
    & bun build src/core/workers/intelligence.worker.ts `
        --outdir $workersDir `
        --entry-naming "[name].[ext]" `
        --target=bun `
        @workerExternals
    if ($LASTEXITCODE -ne 0) { throw "intelligence worker bundle failed" }
    & bun build src/core/workers/io.worker.ts `
        --outdir $workersDir `
        --entry-naming "[name].[ext]" `
        --target=bun `
        @workerExternals
    if ($LASTEXITCODE -ne 0) { throw "io worker bundle failed" }
    & bun build src/core/workers/workflow.worker.ts `
        --outdir $workersDir `
        --entry-naming "[name].[ext]" `
        --target=bun `
        @workerExternals
    if ($LASTEXITCODE -ne 0) { throw "workflow worker bundle failed" }
    Write-Host "    OK workers"

    # Worker bundle leak canary — mirrors scripts/build.ts + scripts/bundle.sh.
    # Drop a TUI import into a worker handler chain and this fails.
    $ioBundlePath = Join-Path $workersDir "io.worker.js"
    $intelBundlePath = Join-Path $workersDir "intelligence.worker.js"
    $ioBundle = Get-Content $ioBundlePath -Raw
    $intelBundle = Get-Content $intelBundlePath -Raw
    $ioForbidden = @("src/index.tsx", "@opentui/core", "src/components/", "react/cjs/react.development")
    $intelForbidden = @("src/index.tsx", "@opentui/core", "src/components/")
    $leaks = @()
    foreach ($n in $ioForbidden) {
        if ($ioBundle.Contains($n)) { $leaks += "io.worker.js->$n" }
    }
    foreach ($n in $intelForbidden) {
        if ($intelBundle.Contains($n)) { $leaks += "intelligence.worker.js->$n" }
    }
    if ($leaks.Count -gt 0) {
        Write-Host "X worker bundle TUI leak: $($leaks -join ', ')" -ForegroundColor Red
        Write-Host "  worker handlers must only import leaf modules - see scripts/build.ts canary." -ForegroundColor Red
        throw "worker bundle leak canary failed"
    }
    Write-Host "    OK worker leak canary"

    $wts = Join-Path $repoRoot "node_modules/web-tree-sitter"
    $wasmTargets = @((Join-Path $wts "tree-sitter.wasm"), (Join-Path $wts "web-tree-sitter.wasm"))
    $wasmSrc = $wasmTargets | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $wasmSrc) { throw "tree-sitter.wasm not found in node_modules/web-tree-sitter" }
    Copy-Item $wasmSrc (Join-Path $depsDir "wasm/tree-sitter.wasm") -Force
    $grammars = Join-Path $repoRoot "node_modules/tree-sitter-wasms/out"
    if (Test-Path $grammars) {
        Get-ChildItem $grammars -Filter *.wasm | Copy-Item -Destination (Join-Path $depsDir "wasm") -Force
    }
    Write-Host "    OK wasm"

    $opentuiAssets = Join-Path $repoRoot "node_modules/@opentui/core/assets"
    if (Test-Path $opentuiAssets) {
        Copy-Item $opentuiAssets (Join-Path $depsDir "opentui-assets") -Recurse -Force
    }
    $parserWorker = Join-Path $repoRoot "node_modules/@opentui/core/parser.worker.js"
    if (Test-Path $parserWorker) {
        & bun build $parserWorker --outdir (Join-Path $depsDir "opentui-assets") --target=bun --asset-naming="[name].[ext]"
        # No post-build patching: since OpenTUI 0.5 the main thread resolves
        # tree-sitter.wasm and passes its path to the worker in the INIT
        # message, and the worker is plain ESM where Bun provides `require`.
        # The 0.4.x require() -> __require() rewrites now crash the worker.
        $workerJs = Join-Path $depsDir "opentui-assets/parser.worker.js"
        if (Test-Path $workerJs) {
            $content = Get-Content $workerJs -Raw
            if ($content.Contains('__require(') -and -not $content.Contains('__require =')) {
                throw "parser.worker.js calls __require() without defining it"
            }
        }
    }
    Write-Host "    OK opentui-assets"


    @"
baked $version - Windows $Arch bundle

To run:
  .\baked.exe --version

The deps\ directory must remain next to baked.exe. On first run the
binary copies these files into %LOCALAPPDATA%\baked\ so the bundle
location no longer matters after that.

"@ | Set-Content (Join-Path $stageDir "README.txt")

    $zipPath = Join-Path $repoRoot "dist/bundle/$bundleName.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Write-Host "==> Compressing $bundleName.zip"
    Compress-Archive -Path "$stageDir/*" -DestinationPath $zipPath -CompressionLevel Optimal

    $zipSize = "{0:N1} MB" -f ((Get-Item $zipPath).Length / 1MB)
    Write-Host ""
    Write-Host "Bundle ready: $zipPath ($zipSize)" -ForegroundColor Green
} finally {
    Pop-Location
}
