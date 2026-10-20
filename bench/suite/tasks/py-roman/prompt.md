Write a small Python module `src/roman.py` that converts between integers and Roman numerals.

- `to_roman(n: int) -> str` returns the standard form (`4` is `IV`, `1994` is `MCMXCIV`).
- `from_roman(s: str) -> int` accepts upper or lower case and returns the integer.
- Both raise `ValueError` for values outside 1..3999 and for malformed numerals such as `IIII`, `VX` or an empty string.

Add pytest tests under `tests/` and a short README.md with one usage example.
