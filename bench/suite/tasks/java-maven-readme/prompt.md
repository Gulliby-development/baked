Write a Java 17 Maven command-line Caesar cipher.

- `com.example.Cipher` in `src/main/java/com/example/Cipher.java` with `static String shift(String text, int key)`: shifts ASCII letters by `key` (any integer, negative allowed), keeping case; other characters stay as they are.
- `com.example.Main` runs as `java -cp target/classes com.example.Main encode|decode KEY TEXT...` and prints the result; wrong arguments print a usage line to stderr and exit with status 2.
- README.md shows how to build with `mvn -q package` and two example runs with their exact output, run from the built classes.

Add JUnit 5 tests under `src/test/java/com/example/`.
