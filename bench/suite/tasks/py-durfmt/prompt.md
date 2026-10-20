Write a Python module `src/durfmt.py` for human-readable durations.

- `format_duration(seconds: int) -> str` gives the largest units first, skipping zero units: `3725` is `1h 2m 5s`, `60` is `1m`, `0` is `0s`, `90061` is `1d 1h 1m 1s`. Units are `d`, `h`, `m`, `s`.
- `parse_duration(text: str) -> int` is the inverse and also accepts extra spaces and units in any order (`"5s 1m"` is 65).
- Negative input to `format_duration` and unknown units or empty text in `parse_duration` raise `ValueError`.

Add pytest tests under `tests/` and a README.md with an example.
