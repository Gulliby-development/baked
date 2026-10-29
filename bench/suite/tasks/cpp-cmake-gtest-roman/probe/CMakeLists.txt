# Configures only when GoogleTest is installed; the suite runner skips the task otherwise.
cmake_minimum_required(VERSION 3.16)
project(probe CXX)
find_package(GTest REQUIRED)
