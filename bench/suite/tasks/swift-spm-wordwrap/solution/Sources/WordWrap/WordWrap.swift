/// Wraps `text` into lines of at most `width` characters.
///
/// - Precondition: `width` is at least 1.
public func wrap(_ text: String, width: Int) -> [String] {
  precondition(width >= 1, "width must be at least 1")
  var lines: [String] = []
  var line = ""
  for word in text.split(whereSeparator: { $0 == " " || $0 == "\n" }) {
    var rest = Substring(word)
    while rest.count > width {
      if !line.isEmpty {
        lines.append(line)
        line = ""
      }
      lines.append(String(rest.prefix(width)))
      rest = rest.dropFirst(width)
    }
    if line.isEmpty {
      line = String(rest)
    } else if line.count + 1 + rest.count <= width {
      line += " " + rest
    } else {
      lines.append(line)
      line = String(rest)
    }
  }
  if !line.isEmpty { lines.append(line) }
  return lines
}
