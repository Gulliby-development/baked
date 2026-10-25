#pragma once

#include <string>

namespace roman {

// Writes 1 to 3999 in standard subtractive form; throws std::out_of_range
// otherwise.
std::string to_roman(int value);

// Reads a standard-form upper-case numeral; throws std::invalid_argument
// otherwise.
int from_roman(const std::string &text);

} // namespace roman
