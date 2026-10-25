Write a Dart library `lib/wordfreq.dart` with `List<(String, int)> topWords(String text, int n)` that returns the `n` most frequent words of `text` with their counts:

- A word is a run of letters, digits and apostrophes inside a word (`don't` is one word, `'quoted'` is `quoted`), compared lowercased, and non-ASCII letters count as letters (`Ünïcode` is a word).
- The list is ordered by count, highest first, and words with the same count in alphabetical order.
- `n` larger than the number of distinct words returns them all; `n` of 0 or less returns an empty list.

Add tests in `test/wordfreq_test.dart` runnable with `dart test`, keep the package clean under `dart analyze` and `dart format`, and add a README.md.
