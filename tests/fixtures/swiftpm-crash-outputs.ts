// Outputs of two `swift test` runs that failed without a code defect, bench round 76 hintsieve
// (#2418, Windows 11, Swift 6.4.1, feature runs and task worktrees building at once). The cloud has
// no Swift toolchain, so these are the issue's recorded lines around the SwiftPM progress output.

/**
 * Run f2a9bb3c (`strategy-commands`), 17:35:06Z: exit 4 after 27.7 s with SwiftPM progress lines
 * only, ending at the test runner's link step. The same tree passed at 17:48:07Z.
 */
export const SWIFT_TEST_SILENT_EXIT_4 = `Building for debugging...
[1 / 31] Write sources
[2 / 31] Write swift-version--58304C5D6DBC2206.txt
[18 / 31] Compiling HintSieveCore Strategy.swift
[21 / 31] Emitting module HintSieveCore
[23 / 31] Compiling HintSieveCoreTests StrategyCommandTests.swift
[24 / 31] HintSieveCoreTests-test-runner
`;

/**
 * Run 47058c0b (`inputs`), task T009 beside T010, 16:18:11Z: exit 1 with SwiftPM's own crash while a
 * sibling worktree built. The same check passed at 16:18:40Z.
 */
export const SWIFT_TEST_FATAL_ERROR = `Building for debugging...
[12 / 29] Compiling HintSieveCore Inputs.swift
warning: unable to create symbolic link at C:\\Users\\bench\\hintsieve\\.baked\\worktrees\\T009\\.build\\debug: encountered an I/O error (code: 512)
error: Build failed
error: fatalError
`;

/** A real compile error and a real swift-testing failure: the code's, never the machine's. */
export const SWIFT_COMPILE_ERROR = `Building for debugging...
/w/Sources/HintSieveCore/Strategy.swift:14:9: error: cannot find 'x' in scope
error: fatalError
error: Build failed
`;
export const SWIFT_TESTING_FAILURE = `Building for debugging...
[24 / 31] HintSieveCoreTests-test-runner
Test run started.
◇ Test strategyParses() started.
✘ Test strategyParses() recorded an issue at StrategyCommandTests.swift:12:5: Expectation failed: (parse("a") → nil) == "a"
✘ Test strategyParses() failed after 0.002 seconds with 1 issue.
✘ Test run with 1 test failed after 0.002 seconds with 1 issue.
`;

/**
 * A SwiftPM build that passed and still printed the symbolic-link warning (measured on the loop
 * machine with a fresh package, exit 0): the warning alone is not the signature.
 */
export const SWIFT_SYMLINK_WARNING_ONLY = `Building for debugging...
warning: unable to create symbolic link at C:\\Users\\bench\\fresh\\.build\\debug: encountered an I/O error (code: 512)
Build complete! (3.21s)
`;
