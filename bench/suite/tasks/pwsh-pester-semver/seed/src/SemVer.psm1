function ConvertTo-SemVer {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Version)
    throw 'not implemented'
}

function Compare-SemVer {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    throw 'not implemented'
}

Export-ModuleMember -Function ConvertTo-SemVer, Compare-SemVer
