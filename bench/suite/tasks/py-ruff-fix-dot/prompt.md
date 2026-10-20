Write a small word statistics tool in Python.

- `src/textstats.py`: `word_count(text: str) -> int` counts words separated by whitespace; `top_words(text: str, n: int) -> list[tuple[str, int]]` returns the `n` most frequent lower-cased words, ties broken alphabetically, with punctuation `.,;:!?` stripped from word ends.
- `src/cli.py`: `main(argv: list[str]) -> int` reads the file named by `argv[0]` and prints `words: N` followed by one `word count` line per top word (n = 3), returning 0; a missing file prints an error to stderr and returns 1.

Add pytest tests for both modules under `tests/`.
