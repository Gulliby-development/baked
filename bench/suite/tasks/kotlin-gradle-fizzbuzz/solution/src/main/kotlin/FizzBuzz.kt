fun fizzBuzz(n: Int, rules: List<Pair<Int, String>> = listOf(3 to "Fizz", 5 to "Buzz")): List<String> {
    require(n >= 0) { "n must not be negative" }
    require(rules.all { it.first >= 1 }) { "divisors must be at least 1" }
    return (1..n).map { i -> rules.filter { i % it.first == 0 }.joinToString("") { it.second }.ifEmpty { i.toString() } }
}
