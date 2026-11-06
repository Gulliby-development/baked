# Adds a directory to, or removes it from, the per-user PATH (HKCU\Environment\Path), for the
# NSIS installer and uninstaller (#2864). It replaces the EnVar plugin: on a Windows 11 laptop,
# 60 install/uninstall cycles of the 0.7.0 installer gave one installer busy-loop hang after
# EnVar::AddValue and two uninstaller access violations (0xC0000005 in ntdll), and the EnVar plugin
# was the only plugin code shared by both before those points.
#
# The value is read without expanding %VARIABLES% and written back as the kind it was (REG_EXPAND_SZ
# when new), so other entries keep their references. Matching ignores case and a trailing
# backslash, and also compares expanded forms. The caller broadcasts WM_SETTINGCHANGE.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File user-path.ps1 add|remove <dir>
param(
    [Parameter(Mandatory = $true)][ValidateSet("add", "remove")][string]$Action,
    [Parameter(Mandatory = $true)][string]$Dir
)
$ErrorActionPreference = "Stop"

function Normalize([string]$Entry) {
    [Environment]::ExpandEnvironmentVariables($Entry.Trim()).TrimEnd("\")
}

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
try {
    $exists = $key.GetValueNames() -contains "Path"
    $current = if ($exists) {
        [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } else { "" }
    $kind = if ($exists) { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    # Every part, empty ones too, so a round trip leaves the rest of the value byte for byte.
    $parts = if ($current -eq "") { @() } else { @($current -split ";") }
    $target = Normalize $Dir
    $others = @($parts | Where-Object { $_.Trim() -eq "" -or (Normalize $_) -ine $target })
    if ($Action -eq "add") {
        if ($others.Count -ne $parts.Count) { exit 0 }
        # A value that ends in ";" keeps that ending, so removing the dir restores it exactly.
        $next = if ($current -eq "") { $Dir } elseif ($current.EndsWith(";")) { "$current$Dir;" } else { "$current;$Dir" }
    } else {
        if ($others.Count -eq $parts.Count) { exit 0 }
        $next = $others -join ";"
    }
    $key.SetValue("Path", $next, $kind)
} finally {
    $key.Close()
}
exit 0
