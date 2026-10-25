Write a Dart library `lib/duration.dart` with `Duration parseDuration(String text)` and `String formatDuration(Duration d)`:

- `parseDuration` reads one or more `<number><unit>` parts with units `h`, `m`, `s` and `ms`, optionally separated by spaces (`"1h30m"`, `"2m 5s"`, `"250ms"`), in any order, each unit at most once. Anything else, including an empty text, a negative number or a repeated unit, throws a `FormatException`.
- `formatDuration` writes the shortest form `parseDuration` reads back, largest unit first and zero parts left out (`Duration(minutes: 90)` is `"1h30m"`); `Duration.zero` is `"0s"`; a negative duration throws an `ArgumentError`.

Add tests in `test/duration_test.dart` runnable with `dart test`, keep the package clean under `dart analyze` and `dart format`, and add a README.md.
