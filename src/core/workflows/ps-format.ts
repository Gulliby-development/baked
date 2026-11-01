/**
 * PSScriptAnalyzer's `Invoke-Formatter` as a file formatter (#2595). It formats a script's text and
 * returns text, so the gate is a short script that reads each file, formats it with the project's
 * root `PSScriptAnalyzerSettings.psd1` when there is one (the `CodeFormatting` preset otherwise),
 * and in check mode names each file it would change and exits 1, in write mode writes it back. It
 * writes UTF-8 and keeps the file's byte-order mark state, so it does not repeat the BOM that
 * `Invoke-ScriptAnalyzer -Fix` adds (#2592). The files come after the script, which `-Command`
 * joins into it as the arguments of its script block (`$args`); with none it formats every
 * `*.ps1`, `*.psm1` and `*.psd1` below the working directory. Windows PowerShell 5.1 runs it too.
 */
function psFormat(write: boolean): string {
  const changed = write
    ? "[IO.File]::WriteAllText($p, $o, (New-Object Text.UTF8Encoding $bom))"
    : "Write-Output ($f + ': would be reformatted by Invoke-Formatter'); $bad = 1";
  return [
    "& {",
    "$s = @{};",
    "if (Test-Path -LiteralPath ./PSScriptAnalyzerSettings.psd1) { $s.Settings = './PSScriptAnalyzerSettings.psd1' };",
    "$files = if ($args.Count) { $args } else { Get-ChildItem -Recurse -File -Include *.ps1, *.psm1, *.psd1 | ForEach-Object { $_.FullName } };",
    "$bad = 0;",
    "foreach ($f in $files) {",
    "$p = (Resolve-Path -LiteralPath $f).ProviderPath;",
    "$b = [IO.File]::ReadAllBytes($p);",
    "$bom = $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF;",
    "$t = [IO.File]::ReadAllText($p);",
    "if (-not $t.Trim()) { continue };",
    "$o = Invoke-Formatter -ScriptDefinition $t @s;",
    `if ($o -cne $t) { ${changed} }`,
    "};",
    "exit $bad",
    "}",
  ].join(" ");
}

/** The check: names each file Invoke-Formatter would change and exits 1. */
export const PS_FORMAT_CHECK = psFormat(false);
/** The fixer: writes each file Invoke-Formatter changes, keeping its BOM state. */
export const PS_FORMAT_FIX = psFormat(true);
