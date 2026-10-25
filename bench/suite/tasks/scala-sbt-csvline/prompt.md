Write a Scala 3 object `CsvLine` in `src/main/scala/CsvLine.scala` with `def parse(line: String): Either[String, List[String]]` that splits one CSV line (RFC 4180) into fields:

- Fields are separated by commas; an empty line is one empty field (`Right(List(""))`).
- A field in double quotes may hold commas, and `""` inside it is one quote (`"a,""b""",c` is `List("a,\"b\"", "c")`).
- A quote inside an unquoted field, text after a closing quote, or an unclosed quote gives a `Left` with a message naming the 0-based column where it went wrong.

Add ScalaTest tests in `src/test/scala/CsvLineSpec.scala` runnable with `sbt test`, keep the code formatted under the given `.scalafmt.conf` (`sbt scalafmtCheckAll`), and add a README.md.
