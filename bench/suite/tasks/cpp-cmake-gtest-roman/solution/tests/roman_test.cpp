#include <gtest/gtest.h>

#include <stdexcept>

#include "roman.hpp"

TEST(ToRoman, WritesSubtractiveForm) {
  EXPECT_EQ(roman::to_roman(4), "IV");
  EXPECT_EQ(roman::to_roman(1994), "MCMXCIV");
  EXPECT_EQ(roman::to_roman(3999), "MMMCMXCIX");
}

TEST(ToRoman, RejectsValuesOutsideTheRange) {
  EXPECT_THROW(roman::to_roman(0), std::out_of_range);
  EXPECT_THROW(roman::to_roman(4000), std::out_of_range);
}

TEST(FromRoman, ReadsEveryValueBack) {
  for (int n = 1; n <= 3999; ++n)
    ASSERT_EQ(roman::from_roman(roman::to_roman(n)), n);
}

TEST(FromRoman, RejectsNonStandardNumerals) {
  for (const char *bad : {"", "IIII", "VX", "IC", "MMMM", "iv"})
    EXPECT_THROW(roman::from_roman(bad), std::invalid_argument) << bad;
}
