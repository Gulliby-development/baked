param([string]$Workspace)

BeforeAll {
    Import-Module (Join-Path $Workspace 'src/SemVer.psm1') -Force
}

Describe 'ConvertTo-SemVer' {
    It 'parses <Text>' -ForEach @(
        @{ Text = '1.4.0'; Major = 1; Minor = 4; Patch = 0; Pre = @(); Build = '' }
        @{ Text = 'v2.0.0-rc.1'; Major = 2; Minor = 0; Patch = 0; Pre = @('rc', '1'); Build = '' }
        @{ Text = '1.0.0-alpha+build.5'; Major = 1; Minor = 0; Patch = 0; Pre = @('alpha'); Build = 'build.5' }
        @{ Text = '10.20.30'; Major = 10; Minor = 20; Patch = 30; Pre = @(); Build = '' }
        @{ Text = '1.0.0+20130313144700'; Major = 1; Minor = 0; Patch = 0; Pre = @(); Build = '20130313144700' }
    ) {
        $v = ConvertTo-SemVer -Version $Text
        $v.Major | Should -Be $Major
        $v.Minor | Should -Be $Minor
        $v.Patch | Should -Be $Patch
        @($v.PreRelease) | Should -Be $Pre
        "$($v.Build)" | Should -Be $Build
    }

    It 'rejects <Text>' -ForEach @(
        @{ Text = '1.2' }, @{ Text = '1.2.3.4' }, @{ Text = '01.2.3' }, @{ Text = '1.2.3-' },
        @{ Text = '1.0.0-a..b' }, @{ Text = '' }, @{ Text = '1.0.0-01' }
    ) {
        { ConvertTo-SemVer -Version $Text } | Should -Throw -ExpectedMessage '*Invalid version*'
    }
}

Describe 'Compare-SemVer' {
    It 'orders the SemVer precedence chain' {
        $chain = '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'
        for ($i = 0; $i -lt $chain.Count - 1; $i++) {
            Compare-SemVer -Left $chain[$i] -Right $chain[$i + 1] | Should -Be -1
            Compare-SemVer -Left $chain[$i + 1] -Right $chain[$i] | Should -Be 1
        }
    }

    It 'compares <Left> to <Right> as <Expected>' -ForEach @(
        @{ Left = '1.0.0'; Right = '1.0.0+build'; Expected = 0 }
        @{ Left = '1.10.0'; Right = '1.9.0'; Expected = 1 }
        @{ Left = '2.0.0'; Right = '10.0.0'; Expected = -1 }
        @{ Left = '1.0.0-2'; Right = '1.0.0-10'; Expected = -1 }
        @{ Left = '1.0.0-B'; Right = '1.0.0-a'; Expected = -1 }
        @{ Left = 'v1.2.3'; Right = '1.2.3'; Expected = 0 }
    ) {
        Compare-SemVer -Left $Left -Right $Right | Should -Be $Expected
    }
}
