/// The words of a text and how often they occur.
library;

final _word = RegExp(r"[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*", unicode: true);

/// The [n] most frequent words of [text], lowercased, ties in alphabetical order.
List<(String, int)> topWords(String text, int n) {
  if (n <= 0) return [];
  final counts = <String, int>{};
  for (final match in _word.allMatches(text)) {
    final word = match[0]!.toLowerCase();
    counts[word] = (counts[word] ?? 0) + 1;
  }
  final entries = counts.entries.toList()
    ..sort((a, b) {
      final byCount = b.value.compareTo(a.value);
      return byCount != 0 ? byCount : a.key.compareTo(b.key);
    });
  return [for (final e in entries.take(n)) (e.key, e.value)];
}
