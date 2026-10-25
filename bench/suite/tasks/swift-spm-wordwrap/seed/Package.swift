// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "WordWrap",
  targets: [
    .target(name: "WordWrap"),
    .testTarget(name: "WordWrapTests", dependencies: ["WordWrap"]),
  ]
)
