import pytest
from roman import from_roman, to_roman

@pytest.mark.parametrize("n,s", [(1, "I"), (4, "IV"), (9, "IX"), (14, "XIV"), (40, "XL"), (90, "XC"), (400, "CD"), (1994, "MCMXCIV"), (3999, "MMMCMXCIX")])
def test_round_trip(n, s):
    assert to_roman(n) == s
    assert from_roman(s) == n
    assert from_roman(s.lower()) == n

@pytest.mark.parametrize("n", [0, -1, 4000])
def test_range(n):
    with pytest.raises(ValueError):
        to_roman(n)

@pytest.mark.parametrize("s", ["", "IIII", "VX", "ABC", "MMMM"])
def test_malformed(s):
    with pytest.raises(ValueError):
        from_roman(s)
