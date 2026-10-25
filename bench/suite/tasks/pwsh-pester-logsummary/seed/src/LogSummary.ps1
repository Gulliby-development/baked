function Get-LogSummary {
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Path')][string]$Path,
        [Parameter(Mandatory, ValueFromPipeline, ParameterSetName = 'Line')][AllowEmptyString()][string]$Line,
        [datetime]$Since
    )
    throw 'not implemented'
}
