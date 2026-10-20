Write a C# (.NET 8) class library `StringCalc` with `public static class Calculator` and `public static int Add(string numbers)`.

- `""` is 0; numbers are separated by `,` or newlines (`"1\n2,3"` is 6).
- A first line `//X` sets a custom one-character delimiter (`"//;\n1;2"` is 3).
- Negative numbers throw `ArgumentException` whose message lists all of them; numbers above 1000 are ignored.

Put xUnit tests in `StringCalc.Tests` and add a README.md.
