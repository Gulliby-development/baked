import XCTest
@testable import WordWrap

final class HiddenCheckTests: XCTestCase {
  func testJoinsWordsUpToWidth() {
    XCTAssertEqual(wrap("the quick  brown\nfox", width: 9), ["the quick", "brown fox"])
  }
  func testSplitsLongWords() {
    XCTAssertEqual(wrap("abcdefgh ij", width: 3), ["abc", "def", "gh", "ij"])
  }
  func testCountsCharacters() {
    XCTAssertEqual(wrap("café olé", width: 4), ["café", "olé"])
  }
  func testBlankText() {
    XCTAssertEqual(wrap("   \n ", width: 5), [])
    XCTAssertEqual(wrap("", width: 5), [])
  }
}
