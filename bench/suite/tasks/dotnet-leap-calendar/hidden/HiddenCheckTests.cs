using Calendar;
using Xunit;

public class HiddenCheckTests
{
    [Fact]
    public void Leap()
    {
        Assert.True(Dates.IsLeapYear(2000));
        Assert.False(Dates.IsLeapYear(1900));
        Assert.True(Dates.IsLeapYear(2024));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dates.IsLeapYear(0));
    }

    [Fact]
    public void Days()
    {
        Assert.Equal(29, Dates.DaysInMonth(2024, 2));
        Assert.Equal(28, Dates.DaysInMonth(2023, 2));
        Assert.Equal(366, Dates.DayOfYear(2024, 12, 31));
        Assert.Equal(60, Dates.DayOfYear(2023, 3, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dates.DayOfYear(2023, 2, 29));
        Assert.Throws<ArgumentOutOfRangeException>(() => Dates.DaysInMonth(2023, 13));
    }
}
