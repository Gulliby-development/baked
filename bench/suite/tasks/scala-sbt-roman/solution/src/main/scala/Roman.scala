object Roman:
  private val numerals = List(
    1000 -> "M", 900 -> "CM", 500 -> "D", 400 -> "CD", 100 -> "C", 90 -> "XC",
    50 -> "L", 40 -> "XL", 10 -> "X", 9 -> "IX", 5 -> "V", 4 -> "IV", 1 -> "I"
  )

  def toRoman(n: Int): String =
    require(n >= 1 && n <= 3999, s"$n is outside 1 to 3999")
    numerals
      .foldLeft((n, new StringBuilder)) { case ((left, out), (value, text)) =>
        (left % value, out.append(text * (left / value)))
      }
      ._2
      .toString

  def fromRoman(s: String): Option[Int] =
    if !s.matches("[MDCLXVI]+") then None
    else
      val values = s.map(Map('M' -> 1000, 'D' -> 500, 'C' -> 100, 'L' -> 50, 'X' -> 10, 'V' -> 5, 'I' -> 1))
      val total = values.indices.map(i => if i + 1 < values.length && values(i) < values(i + 1) then -values(i) else values(i)).sum
      Option.when(total >= 1 && total <= 3999 && toRoman(total) == s)(total)
