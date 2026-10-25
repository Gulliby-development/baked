class HiddenCheckSuite extends munit.FunSuite:
  test("writes subtractive numerals") {
    assertEquals(Roman.toRoman(1994), "MCMXCIV")
    assertEquals(Roman.toRoman(3999), "MMMCMXCIX")
    assertEquals(Roman.toRoman(4), "IV")
  }
  test("rejects numbers outside 1 to 3999") {
    intercept[IllegalArgumentException](Roman.toRoman(0))
    intercept[IllegalArgumentException](Roman.toRoman(4000))
  }
  test("reads only the canonical form") {
    assertEquals(Roman.fromRoman("MCMXCIV"), Some(1994))
    for bad <- List("IIII", "IC", "mcm", "", "MMMM", "VX") do assertEquals(Roman.fromRoman(bad), None, bad)
  }
  test("round trips") {
    for n <- 1 to 3999 do assertEquals(Roman.fromRoman(Roman.toRoman(n)), Some(n))
  }
