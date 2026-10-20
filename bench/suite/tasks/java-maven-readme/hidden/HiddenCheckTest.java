package com.example;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

class HiddenCheckTest {
  @Test
  void shift() {
    assertEquals("Khoor, Zruog!", Cipher.shift("Hello, World!", 3));
    assertEquals("Hello", Cipher.shift("Khoor", -3));
    assertEquals("b", Cipher.shift("a", 27));
    assertEquals("Z", Cipher.shift("A", -1));
  }
}
