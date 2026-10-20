package com.example;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class HiddenCheckTest {
  @Test
  void isPalindrome() {
    assertTrue(Palindromes.isPalindrome("A man, a plan, a canal: Panama"));
    assertTrue(Palindromes.isPalindrome(""));
    assertFalse(Palindromes.isPalindrome("ab"));
    assertThrows(IllegalArgumentException.class, () -> Palindromes.isPalindrome(null));
  }

  @Test
  void longest() {
    assertEquals("anana", Palindromes.longestPalindrome("bananas"));
    assertEquals("a", Palindromes.longestPalindrome("abc"));
    assertEquals("", Palindromes.longestPalindrome(""));
  }
}
