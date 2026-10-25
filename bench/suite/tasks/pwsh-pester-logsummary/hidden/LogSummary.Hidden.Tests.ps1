param([string]$Workspace)

BeforeAll {
    . (Join-Path $Workspace 'src/LogSummary.ps1')
    $script:Log = @(
        '2026-10-01T12:00:03Z ERROR billing: card declined'
        '2026-10-01T12:00:01Z info api: started'
        ''
        'garbage line'
        '2026-10-01T12:05:00Z WARN api: slow response'
        '2026-10-01T12:07:00Z error auth: token expired'
        '2026-10-01T11:59:00Z ERROR billing: retry'
        '2026-10-01T12:09:00Z DEBUG api: payload'
    )
    $script:File = Join-Path ([System.IO.Path]::GetTempPath()) "logsummary-$([guid]::NewGuid()).log"
    Set-Content -Path $script:File -Value $script:Log
}

AfterAll { Remove-Item $script:File -ErrorAction SilentlyContinue }

Describe 'Get-LogSummary' {
    It 'groups by level in severity order, from a file and from the pipeline' {
        foreach ($summary in @((Get-LogSummary -Path $script:File -WarningAction SilentlyContinue), ($script:Log | Get-LogSummary -WarningAction SilentlyContinue))) {
            @($summary.Level) | Should -Be @('ERROR', 'WARN', 'INFO', 'DEBUG')
            $err = $summary | Where-Object Level -EQ 'ERROR'
            $err.Count | Should -Be 3
            $err.First | Should -Be ([datetime]::new(2026, 10, 1, 11, 59, 0, [DateTimeKind]::Utc))
            $err.Last | Should -Be ([datetime]::new(2026, 10, 1, 12, 7, 0, [DateTimeKind]::Utc))
            @($err.Components) | Should -Be @('auth', 'billing')
        }
    }

    It 'warns about a malformed line by its number and keeps going' {
        $summary = $script:Log | Get-LogSummary -WarningVariable warned -WarningAction SilentlyContinue
        @($warned).Count | Should -Be 1
        "$($warned[0])" | Should -Match '\b4\b'
        @($summary).Count | Should -Be 4
    }

    It 'keeps lines at or after -Since' {
        $summary = $script:Log | Get-LogSummary -Since ([datetime]::new(2026, 10, 1, 12, 5, 0, [DateTimeKind]::Utc)) -WarningAction SilentlyContinue
        @($summary.Level) | Should -Be @('ERROR', 'WARN', 'DEBUG')
        ($summary | Where-Object Level -EQ 'ERROR').Count | Should -Be 1
    }

    It 'returns nothing for an empty log' {
        @(@('', '') | Get-LogSummary).Count | Should -Be 0
    }
}
