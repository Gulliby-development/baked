Write a Swift library target `WordWrap` with `public func wrap(_ text: String, width: Int) -> [String]` in `Sources/WordWrap/WordWrap.swift`:

- Words are separated by runs of spaces and newlines; each returned line joins words with one space and is at most `width` characters (counted as `Character`s, so `"é"` is one).
- A word longer than `width` is split into pieces of `width` characters.
- An empty or blank text returns `[]`; a `width` below 1 is a precondition failure the caller must avoid, so document it.

Add XCTest or swift-testing tests in `Tests/WordWrapTests/` runnable with `swift test`, and add a README.md.
