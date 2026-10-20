namespace Calendar;

public static class Dates
{
    private static readonly int[] Days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };

    public static bool IsLeapYear(int year)
    {
        if (year < 1) throw new ArgumentOutOfRangeException(nameof(year));
        return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    }

    public static int DaysInMonth(int year, int month)
    {
        if (month < 1 || month > 12) throw new ArgumentOutOfRangeException(nameof(month));
        return month == 2 && IsLeapYear(year) ? 29 : Days[month - 1];
    }

    public static int DayOfYear(int year, int month, int day)
    {
        if (day < 1 || day > DaysInMonth(year, month)) throw new ArgumentOutOfRangeException(nameof(day));
        var total = day;
        for (var m = 1; m < month; m++) total += DaysInMonth(year, m);
        return total;
    }
}
