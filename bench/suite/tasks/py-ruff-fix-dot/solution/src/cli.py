import sys

from textstats import top_words, word_count


def main(argv: list[str]) -> int:
    try:
        with open(argv[0], encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"words: {word_count(text)}")
    for word, count in top_words(text, 3):
        print(f"{word} {count}")
    return 0
