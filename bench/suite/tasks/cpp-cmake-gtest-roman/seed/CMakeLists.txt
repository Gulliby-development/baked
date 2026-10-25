cmake_minimum_required(VERSION 3.16)
project(roman CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

enable_testing()
find_package(GTest REQUIRED)

add_library(roman src/roman.cpp)
target_include_directories(roman PUBLIC src)

add_executable(roman_test tests/roman_test.cpp)
target_link_libraries(roman_test roman GTest::gtest_main)

include(GoogleTest)
gtest_discover_tests(roman_test)
