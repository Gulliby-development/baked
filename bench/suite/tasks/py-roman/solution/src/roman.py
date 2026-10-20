VALUES = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
          (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]


def to_roman(n: int) -> str:
    if not 1 <= n <= 3999:
        raise ValueError(f"out of range: {n}")
    out = []
    for value, sym in VALUES:
        while n >= value:
            out.append(sym)
            n -= value
    return "".join(out)


def from_roman(s: str) -> int:
    text = s.upper()
    total, i = 0, 0
    for value, sym in VALUES:
        while text.startswith(sym, i):
            total += value
            i += len(sym)
    if i != len(text) or total == 0 or total > 3999 or to_roman(total) != text:
        raise ValueError(f"malformed numeral: {s!r}")
    return total
