import org.scalatest.funsuite.AnyFunSuite

class HiddenCheckSpec extends AnyFunSuite:
  test("splits plain fields") {
    assert(CsvLine.parse("a,b,,c") == Right(List("a", "b", "", "c")))
    assert(CsvLine.parse("") == Right(List("")))
  }
  test("reads quoted fields") {
    assert(CsvLine.parse("\"a,\"\"b\"\"\",c") == Right(List("a,\"b\"", "c")))
    assert(CsvLine.parse("\"\",x") == Right(List("", "x")))
  }
  test("names the column of an error") {
    assert(CsvLine.parse("ab\"c").left.exists(_.contains("2")))
    assert(CsvLine.parse("\"ab\"x").left.exists(_.contains("4")))
    assert(CsvLine.parse("x,\"open").isLeft)
  }
