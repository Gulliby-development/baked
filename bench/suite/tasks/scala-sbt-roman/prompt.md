Write a Scala 3 object `Roman` in `src/main/scala/Roman.scala` with `def toRoman(n: Int): String` and `def fromRoman(s: String): Option[Int]`:

- `toRoman` writes 1 to 3999 in standard subtractive form (`1994` is `"MCMXCIV"`) and throws an `IllegalArgumentException` outside that range.
- `fromRoman` reads only the canonical form `toRoman` writes, in upper case: `"MCMXCIV"` is `Some(1994)`, while `"IIII"`, `"IC"`, `"mcm"` and `""` are `None`.

Add munit tests in `src/test/scala/RomanSuite.scala` runnable with `sbt test`, and add a README.md.
