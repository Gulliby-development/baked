import pytest
from durfmt import format_duration, parse_duration

@pytest.mark.parametrize("n,s", [(0, "0s"), (59, "59s"), (60, "1m"), (3725, "1h 2m 5s"), (90061, "1d 1h 1m 1s"), (86400, "1d")])
def test_format(n, s):
    assert format_duration(n) == s
    assert parse_duration(s) == n

def test_parse_loose():
    assert parse_duration("5s 1m") == 65
    assert parse_duration("  2h   3s ") == 7203

@pytest.mark.parametrize("bad", ["", "5x", "abc"])
def test_parse_bad(bad):
    with pytest.raises(ValueError):
        parse_duration(bad)

def test_negative():
    with pytest.raises(ValueError):
        format_duration(-1)
