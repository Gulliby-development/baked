from collections import Counter


def word_count(text: str) -> int:
    return len(text.split())


def top_words(text: str, n: int) -> list[tuple[str, int]]:
    words = [w.strip(".,;:!?").lower() for w in text.split()]
    counts = Counter(w for w in words if w)
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
