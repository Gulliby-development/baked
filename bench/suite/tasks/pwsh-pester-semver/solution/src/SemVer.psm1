$script:Pattern = '^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'

function ConvertTo-SemVer {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Version)
    $m = [regex]::Match($Version, $script:Pattern)
    if (-not $m.Success) { throw "Invalid version: '$Version'" }
    [pscustomobject]@{
        Major      = [int]$m.Groups[1].Value
        Minor      = [int]$m.Groups[2].Value
        Patch      = [int]$m.Groups[3].Value
        PreRelease = if ($m.Groups[4].Success) { [string[]]$m.Groups[4].Value.Split('.') } else { [string[]]@() }
        Build      = if ($m.Groups[5].Success) { $m.Groups[5].Value } else { '' }
    }
}

function Compare-Identifier {
    param([string]$A, [string]$B)
    $an = $A -match '^\d+$'
    $bn = $B -match '^\d+$'
    if ($an -and $bn) { return [math]::Sign(([bigint]$A).CompareTo([bigint]$B)) }
    if ($an) { return -1 }
    if ($bn) { return 1 }
    return [math]::Sign([string]::CompareOrdinal($A, $B))
}

function Compare-SemVer {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    $l = ConvertTo-SemVer -Version $Left
    $r = ConvertTo-SemVer -Version $Right
    foreach ($part in 'Major', 'Minor', 'Patch') {
        if ($l.$part -ne $r.$part) { return [math]::Sign($l.$part - $r.$part) }
    }
    $lp = @($l.PreRelease)
    $rp = @($r.PreRelease)
    if ($lp.Count -eq 0 -and $rp.Count -eq 0) { return 0 }
    if ($lp.Count -eq 0) { return 1 }
    if ($rp.Count -eq 0) { return -1 }
    for ($i = 0; $i -lt [math]::Min($lp.Count, $rp.Count); $i++) {
        $c = Compare-Identifier -A $lp[$i] -B $rp[$i]
        if ($c -ne 0) { return $c }
    }
    return [math]::Sign($lp.Count - $rp.Count)
}

Export-ModuleMember -Function ConvertTo-SemVer, Compare-SemVer
