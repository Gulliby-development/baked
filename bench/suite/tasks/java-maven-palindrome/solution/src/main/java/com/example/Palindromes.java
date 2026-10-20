package com.example;

public final class Palindromes {
  private Palindromes() {}

  public static boolean isPalindrome(String s) {
    if (s == null) throw new IllegalArgumentException("null");
    int i = 0;
    int j = s.length() - 1;
    while (i < j) {
      if (!Character.isLetterOrDigit(s.charAt(i))) i++;
      else if (!Character.isLetterOrDigit(s.charAt(j))) j--;
      else if (Character.toLowerCase(s.charAt(i++)) != Character.toLowerCase(s.charAt(j--))) return false;
    }
    return true;
  }

  public static String longestPalindrome(String s) {
    String best = "";
    for (int c = 0; c < 2 * s.length() - 1; c++) {
      int l = c / 2;
      int r = l + c % 2;
      while (l >= 0 && r < s.length() && s.charAt(l) == s.charAt(r)) {
        l--;
        r++;
      }
      if (r - l - 1 > best.length()) best = s.substring(l + 1, r);
    }
    return best;
  }
}
