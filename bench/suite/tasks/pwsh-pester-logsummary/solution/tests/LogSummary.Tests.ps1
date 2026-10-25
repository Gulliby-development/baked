BeforeAll {
    . "$PSScriptRoot/../src/LogSummary.ps1"
}

Describe 'Get-LogSummary' {
    It 'summarises lines from the pipeline' {
        $summary = '2026-10-01T12:00:00Z ERROR db: down', '2026-10-01T12:01:00Z info db: up' | Get-LogSummary
        @($summary.Level) | Should -Be @('ERROR', 'INFO')
    }

    It 'warns about a malformed line' {
        $null = 'nope' | Get-LogSummary -WarningVariable warned -WarningAction SilentlyContinue
        @($warned).Count | Should -Be 1
    }

    It 'filters by -Since' {
        $since = [datetime]::new(2026, 10, 1, 12, 1, 0, [DateTimeKind]::Utc)
        $summary = '2026-10-01T12:00:00Z ERROR db: down', '2026-10-01T12:01:00Z INFO db: up' | Get-LogSummary -Since $since
        @($summary.Level) | Should -Be @('INFO')
    }
}
