package com.example;

public final class Main {
  public static void main(String[] args) {
    if (args.length < 3 || !(args[0].equals("encode") || args[0].equals("decode"))) {
      System.err.println("usage: Main encode|decode KEY TEXT...");
      System.exit(2);
    }
    int key;
    try {
      key = Integer.parseInt(args[1]);
    } catch (NumberFormatException e) {
      System.err.println("usage: Main encode|decode KEY TEXT...");
      System.exit(2);
      return;
    }
    String text = String.join(" ", java.util.Arrays.copyOfRange(args, 2, args.length));
    System.out.println(Cipher.shift(text, args[0].equals("encode") ? key : -key));
  }
}
