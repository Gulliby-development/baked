Write a C# (.NET 8) class library `Calendar` with `public static class Dates`.

- `public static bool IsLeapYear(int year)` for the Gregorian calendar; years below 1 throw `ArgumentOutOfRangeException`.
- `public static int DaysInMonth(int year, int month)`; a month outside 1..12 throws `ArgumentOutOfRangeException`.
- `public static int DayOfYear(int year, int month, int day)`; an invalid day throws `ArgumentOutOfRangeException`.

Do not use `DateTime` for the calculations. Put xUnit tests in `Calendar.Tests` and add a README.md.
