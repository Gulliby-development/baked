Write a Java 17 Maven library class `com.example.Palindromes` in `src/main/java/com/example/Palindromes.java`.

- `static boolean isPalindrome(String s)` ignores case and every character that is not a letter or digit (`"A man, a plan, a canal: Panama"` is true); `null` throws `IllegalArgumentException`.
- `static String longestPalindrome(String s)` returns the longest palindromic substring of `s` compared exactly (case and punctuation count), the leftmost on ties, and `""` for an empty string.

Add JUnit 5 tests under `src/test/java/com/example/` and a README.md.
