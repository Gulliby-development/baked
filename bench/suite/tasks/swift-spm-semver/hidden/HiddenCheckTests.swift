import XCTest
@testable import SemVer

final class HiddenCheckTests: XCTestCase {
  func testParses() {
    XCTAssertEqual(Version("1.2.3-alpha.1+build.5")?.description, "1.2.3-alpha.1+build.5")
    for bad in ["1.2", "01.2.3", "1.2.3-", "1.2.3+", "v1.2.3", "1.2.3-01", ""] {
      XCTAssertNil(Version(bad), bad)
    }
  }
  func testOrdersPrereleases() {
    let order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
    let versions = order.compactMap(Version.init)
    XCTAssertEqual(versions.count, order.count)
    XCTAssertEqual(versions.sorted().map(\.description), order)
  }
  func testIgnoresBuildMetadata() {
    XCTAssertFalse(Version("1.0.0+a")! < Version("1.0.0+b")!)
    XCTAssertTrue(Version("1.9.9")! < Version("1.10.0")!)
  }
}
