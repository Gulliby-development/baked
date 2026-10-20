namespace StringCalc;

public static class Calculator
{
    public static int Add(string numbers)
    {
        if (numbers.Length == 0) return 0;
        var delimiters = new List<char> { ',', '\n' };
        if (numbers.StartsWith("//") && numbers.Length >= 4 && numbers[3] == '\n')
        {
            delimiters.Add(numbers[2]);
            numbers = numbers[4..];
        }
        var values = numbers.Split(delimiters.ToArray()).Select(int.Parse).ToList();
        var negatives = values.Where(v => v < 0).ToList();
        if (negatives.Count > 0) throw new ArgumentException($"negatives not allowed: {string.Join(", ", negatives)}");
        return values.Where(v => v <= 1000).Sum();
    }
}
