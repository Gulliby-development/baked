/// A Semantic Versioning 2.0.0 version.
public struct Version: Comparable, CustomStringConvertible {
  public let major: Int
  public let minor: Int
  public let patch: Int
  public let prerelease: [String]
  public let description: String

  public init?(_ text: String) {
    var core = Substring(text)
    if let plus = core.firstIndex(of: "+") {
      let build = core[core.index(after: plus)...]
      guard Version.validIdentifiers(build, numericRule: false) else { return nil }
      core = core[..<plus]
    }
    var pre: [String] = []
    if let dash = core.firstIndex(of: "-") {
      let tail = core[core.index(after: dash)...]
      guard Version.validIdentifiers(tail, numericRule: true) else { return nil }
      pre = tail.split(separator: ".").map(String.init)
      core = core[..<dash]
    }
    let parts = core.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, parts.allSatisfy(Version.isNumber) else { return nil }
    guard let major = Int(parts[0]), let minor = Int(parts[1]), let patch = Int(parts[2]) else {
      return nil
    }
    self.major = major
    self.minor = minor
    self.patch = patch
    self.prerelease = pre
    self.description = text
  }

  private static func isNumber(_ part: Substring) -> Bool {
    !part.isEmpty && part.allSatisfy(\.isASCIIDigit) && (part == "0" || part.first != "0")
  }

  private static func validIdentifiers(_ text: Substring, numericRule: Bool) -> Bool {
    let ids = text.split(separator: ".", omittingEmptySubsequences: false)
    return !ids.isEmpty
      && ids.allSatisfy { id in
        !id.isEmpty && id.allSatisfy { $0.isASCIIDigit || $0.isASCIILetter || $0 == "-" }
          && (!numericRule || !id.allSatisfy(\.isASCIIDigit) || isNumber(id))
      }
  }

  public static func == (a: Version, b: Version) -> Bool {
    (a.major, a.minor, a.patch) == (b.major, b.minor, b.patch) && a.prerelease == b.prerelease
  }

  public static func < (a: Version, b: Version) -> Bool {
    if (a.major, a.minor, a.patch) != (b.major, b.minor, b.patch) {
      return (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }
    if a.prerelease.isEmpty || b.prerelease.isEmpty {
      return !a.prerelease.isEmpty && b.prerelease.isEmpty
    }
    for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
      switch (Int(x), Int(y)) {
      case (let i?, let j?): return i < j
      case (.some, nil): return true
      case (nil, .some): return false
      case (nil, nil): return x < y
      }
    }
    return a.prerelease.count < b.prerelease.count
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { ("0"..."9").contains(self) }
  fileprivate var isASCIILetter: Bool { ("a"..."z").contains(self) || ("A"..."Z").contains(self) }
}
