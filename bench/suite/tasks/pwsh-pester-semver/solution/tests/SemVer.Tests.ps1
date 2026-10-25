BeforeAll {
    Import-Module "$PSScriptRoot/../src/SemVer.psm1" -Force
}

Describe 'ConvertTo-SemVer' {
    It 'parses a pre-release and build metadata' {
        $v = ConvertTo-SemVer -Version '1.0.0-alpha.1+build.5'
        $v.Major | Should -Be 1
        @($v.PreRelease) | Should -Be @('alpha', '1')
        $v.Build | Should -Be 'build.5'
    }

    It 'rejects <Text>' -ForEach @(@{ Text = '1.2' }, @{ Text = '01.2.3' }, @{ Text = '1.0.0-a..b' }) {
        { ConvertTo-SemVer -Version $Text } | Should -Throw -ExpectedMessage '*Invalid version*'
    }
}

Describe 'Compare-SemVer' {
    It 'orders the SemVer precedence chain' {
        $chain = '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'
        for ($i = 0; $i -lt $chain.Count - 1; $i++) {
            Compare-SemVer -Left $chain[$i] -Right $chain[$i + 1] | Should -Be -1
        }
    }

    It 'ignores build metadata' {
        Compare-SemVer -Left '1.0.0+a' -Right '1.0.0+b' | Should -Be 0
    }
}
