$script:LogLine = '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(ERROR|WARN|INFO|DEBUG)\s+([^:\s]+):\s?(.*)$'

function ConvertFrom-LogLine {
    param([string]$Text, [int]$Number)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $m = [regex]::Match($Text, $script:LogLine, 'IgnoreCase')
    if (-not $m.Success) {
        Write-Warning "Line ${Number}: not a log line"
        return
    }
    $styles = [System.Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal'
    [pscustomobject]@{
        Time      = [datetime]::ParseExact($m.Groups[1].Value, "yyyy-MM-dd'T'HH:mm:ss'Z'", [cultureinfo]::InvariantCulture, $styles)
        Level     = $m.Groups[2].Value.ToUpperInvariant()
        Component = $m.Groups[3].Value
    }
}

function Get-LogSummary {
    [CmdletBinding(DefaultParameterSetName = 'Path')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Path')][string]$Path,
        [Parameter(Mandatory, ValueFromPipeline, ParameterSetName = 'Line')][AllowEmptyString()][string]$Line,
        [datetime]$Since
    )
    begin {
        $lines = [System.Collections.Generic.List[string]]::new()
    }
    process {
        if ($PSCmdlet.ParameterSetName -eq 'Line') { $lines.Add($Line) }
    }
    end {
        if ($PSCmdlet.ParameterSetName -eq 'Path') { $lines.AddRange([string[]]@(Get-Content -LiteralPath $Path)) }
        $entries = for ($i = 0; $i -lt $lines.Count; $i++) { ConvertFrom-LogLine -Text $lines[$i] -Number ($i + 1) }
        if ($PSBoundParameters.ContainsKey('Since')) {
            $from = $Since.ToUniversalTime()
            $entries = @($entries | Where-Object Time -GE $from)
        }
        foreach ($level in 'ERROR', 'WARN', 'INFO', 'DEBUG') {
            $items = @($entries | Where-Object Level -EQ $level)
            if (-not $items.Count) { continue }
            $times = @($items.Time | Sort-Object)
            [pscustomobject]@{
                Level      = $level
                Count      = $items.Count
                First      = $times[0]
                Last       = $times[-1]
                Components = [string[]]@($items.Component | Sort-Object -Unique)
            }
        }
    }
}
