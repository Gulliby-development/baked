// Hidden acceptance check for cpp-cmake-gtest-roman: exits 0 when every case
// holds.
#include <cstdio>
#include <stdexcept>
#include <string>

#include "roman.hpp"

static int failures = 0;

static void expect(bool ok, const char *what) {
  if (!ok) {
    std::printf("FAIL: %s\n", what);
    ++failures;
  }
}

template <typename E, typename F> static bool throws(F f) {
  try {
    f();
  } catch (const E &) {
    return true;
  } catch (...) {
    return false;
  }
  return false;
}

int main() {
  expect(roman::to_roman(1) == "I", "to_roman(1)");
  expect(roman::to_roman(4) == "IV", "to_roman(4)");
  expect(roman::to_roman(9) == "IX", "to_roman(9)");
  expect(roman::to_roman(40) == "XL", "to_roman(40)");
  expect(roman::to_roman(1994) == "MCMXCIV", "to_roman(1994)");
  expect(roman::to_roman(3999) == "MMMCMXCIX", "to_roman(3999)");
  expect(throws<std::out_of_range>([] { roman::to_roman(0); }),
         "to_roman(0) throws");
  expect(throws<std::out_of_range>([] { roman::to_roman(4000); }),
         "to_roman(4000) throws");
  expect(throws<std::out_of_range>([] { roman::to_roman(-5); }),
         "to_roman(-5) throws");
  for (int n = 1; n <= 3999; ++n)
    if (roman::from_roman(roman::to_roman(n)) != n) {
      expect(false, "from_roman(to_roman(n)) == n");
      break;
    }
  for (const char *bad : {"", "IIII", "VX", "IC", "MMMM", "IIV", "XXXX", "VV",
                          "DM", "abc", "X I", "iv"})
    expect(throws<std::invalid_argument>([bad] { roman::from_roman(bad); }),
           bad);
  if (failures == 0)
    std::printf("ok\n");
  return failures == 0 ? 0 : 1;
}
