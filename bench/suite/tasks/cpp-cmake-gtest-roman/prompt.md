Write a C++17 library for Roman numerals: `src/roman.hpp` declares and `src/roman.cpp` defines, in namespace `roman`,

- `std::string to_roman(int value)`, which writes 1 to 3999 in standard subtractive form (`to_roman(1994)` is `"MCMXCIV"`, `to_roman(4)` is `"IV"`) and throws `std::out_of_range` for any other value;
- `int from_roman(const std::string& text)`, which reads an upper-case numeral back and throws `std::invalid_argument` for an empty string, a character that is not one of `IVXLCDM`, and any numeral that is not in standard form (`"IIII"`, `"VX"`, `"IC"`, `"MMMM"`), so that `from_roman(to_roman(n)) == n` for every valid `n` and nothing else is accepted.

Add GoogleTest tests in `tests/roman_test.cpp`; the given `CMakeLists.txt` builds the library and the tests and registers them with CTest (`find_package(GTest)`, `gtest_discover_tests`). Keep every file formatted with `clang-format` and the given `.clang-format`, and add a README.md.
