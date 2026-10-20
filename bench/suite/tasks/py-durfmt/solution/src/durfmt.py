UNITS = [("d", 86400), ("h", 3600), ("m", 60), ("s", 1)]


def format_duration(seconds: int) -> str:
    if seconds < 0:
        raise ValueError("negative duration")
    parts = []
    for name, size in UNITS:
        count, seconds = divmod(seconds, size)
        if count:
            parts.append(f"{count}{name}")
    return " ".join(parts) or "0s"


def parse_duration(text: str) -> int:
    sizes = dict(UNITS)
    tokens = text.split()
    if not tokens:
        raise ValueError("empty duration")
    total = 0
    for token in tokens:
        number, unit = token[:-1], token[-1:]
        if unit not in sizes or not number.isdigit():
            raise ValueError(f"bad part: {token!r}")
        total += int(number) * sizes[unit]
    return total
