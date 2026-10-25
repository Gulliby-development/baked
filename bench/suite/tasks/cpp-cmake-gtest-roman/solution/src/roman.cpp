#include "roman.hpp"

#include <array>
#include <stdexcept>
#include <utility>

namespace roman {

namespace {

const std::array<std::pair<int, const char *>, 13> kSymbols{{{1000, "M"},
                                                             {900, "CM"},
                                                             {500, "D"},
                                                             {400, "CD"},
                                                             {100, "C"},
                                                             {90, "XC"},
                                                             {50, "L"},
                                                             {40, "XL"},
                                                             {10, "X"},
                                                             {9, "IX"},
                                                             {5, "V"},
                                                             {4, "IV"},
                                                             {1, "I"}}};

int digit(char c) {
  switch (c) {
  case 'I':
    return 1;
  case 'V':
    return 5;
  case 'X':
    return 10;
  case 'L':
    return 50;
  case 'C':
    return 100;
  case 'D':
    return 500;
  case 'M':
    return 1000;
  default:
    throw std::invalid_argument("not a Roman numeral digit");
  }
}

} // namespace

std::string to_roman(int value) {
  if (value < 1 || value > 3999)
    throw std::out_of_range("Roman numerals cover 1 to 3999");
  std::string out;
  for (const auto &[amount, symbol] : kSymbols)
    while (value >= amount) {
      out += symbol;
      value -= amount;
    }
  return out;
}

int from_roman(const std::string &text) {
  if (text.empty())
    throw std::invalid_argument("empty Roman numeral");
  int total = 0;
  for (std::size_t i = 0; i < text.size(); ++i) {
    const int current = digit(text[i]);
    const int next = i + 1 < text.size() ? digit(text[i + 1]) : 0;
    total += current < next ? -current : current;
  }
  // Only the standard form of a value reads back: "IIII", "VX" and "IC" do not.
  if (total < 1 || total > 3999 || to_roman(total) != text)
    throw std::invalid_argument("not a standard-form Roman numeral");
  return total;
}

} // namespace roman
