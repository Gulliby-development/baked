Write a Swift library target `SemVer` in `Sources/SemVer/SemVer.swift` with a `public struct Version: Comparable, CustomStringConvertible` and `public init?(_ text: String)` that reads Semantic Versioning 2.0.0 versions:

- `MAJOR.MINOR.PATCH` with no leading zeros, an optional pre-release (`-alpha.1`) and optional build metadata (`+build.5`); anything else gives `nil` (`"1.2"`, `"01.2.3"`, `"1.2.3-"`).
- Comparison follows the specification: build metadata is ignored, a pre-release sorts before its release, and pre-release identifiers compare numerically when both are numeric, else by ASCII order, with numeric ones first (`1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-rc.1 < 1.0.0`).
- `description` prints the version as given.

Add tests in `Tests/SemVerTests/` runnable with `swift test`, keep the code clean under `swift format lint --strict` with the given `.swift-format`, and add a README.md.
