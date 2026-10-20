Write a Kotlin/JVM Gradle library with `fun fizzBuzz(n: Int, rules: List<Pair<Int, String>> = listOf(3 to "Fizz", 5 to "Buzz")): List<String>` in `src/main/kotlin/FizzBuzz.kt` (no package).

- Returns the entries for 1..n: the concatenated words of every rule whose divisor divides the number, in rule order, or the number itself.
- `n < 0` or a divisor below 1 throws `IllegalArgumentException`; `n = 0` returns an empty list.

Add `kotlin.test` tests under `src/test/kotlin/` and a README.md.
