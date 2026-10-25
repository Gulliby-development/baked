// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "SemVer",
  targets: [
    .target(name: "SemVer"),
    .testTarget(name: "SemVerTests", dependencies: ["SemVer"]),
  ]
)
