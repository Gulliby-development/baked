package com.example;

public final class Cipher {
  private Cipher() {}

  public static String shift(String text, int key) {
    int k = Math.floorMod(key, 26);
    StringBuilder out = new StringBuilder();
    for (char c : text.toCharArray()) {
      if (c >= 'a' && c <= 'z') out.append((char) ('a' + (c - 'a' + k) % 26));
      else if (c >= 'A' && c <= 'Z') out.append((char) ('A' + (c - 'A' + k) % 26));
      else out.append(c);
    }
    return out.toString();
  }
}
