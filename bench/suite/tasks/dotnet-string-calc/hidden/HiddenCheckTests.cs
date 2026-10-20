using StringCalc;
using Xunit;

public class HiddenCheckTests
{
    [Theory]
    [InlineData("", 0)]
    [InlineData("4", 4)]
    [InlineData("1\n2,3", 6)]
    [InlineData("//;\n1;2", 3)]
    [InlineData("2,1001", 2)]
    public void Adds(string input, int expected) => Assert.Equal(expected, Calculator.Add(input));

    [Fact]
    public void Negatives()
    {
        var e = Assert.Throws<ArgumentException>(() => Calculator.Add("1,-2,-5"));
        Assert.Contains("-2", e.Message);
        Assert.Contains("-5", e.Message);
    }
}
