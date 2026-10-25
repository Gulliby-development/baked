/// Short duration texts such as `1h30m`.
library;

final _part = RegExp(r'(\d+)(ms|h|m|s)');
final _text = RegExp(r'^(?:\d+(?:ms|h|m|s) ?)*\d+(?:ms|h|m|s)$');

/// Reads `<number><unit>` parts (`h`, `m`, `s`, `ms`), each unit at most once.
Duration parseDuration(String text) {
  if (!_text.hasMatch(text)) throw FormatException('Invalid duration', text);
  final seen = <String>{};
  var total = Duration.zero;
  for (final match in _part.allMatches(text)) {
    final unit = match[2]!;
    if (!seen.add(unit)) throw FormatException('Repeated unit $unit', text);
    final value = int.parse(match[1]!);
    total += switch (unit) {
      'h' => Duration(hours: value),
      'm' => Duration(minutes: value),
      's' => Duration(seconds: value),
      _ => Duration(milliseconds: value),
    };
  }
  return total;
}

/// The shortest text [parseDuration] reads back as [d].
String formatDuration(Duration d) {
  if (d.isNegative) throw ArgumentError.value(d, 'd', 'must not be negative');
  if (d == Duration.zero) return '0s';
  final parts = [
    (d.inHours, 'h'),
    (d.inMinutes % 60, 'm'),
    (d.inSeconds % 60, 's'),
    (d.inMilliseconds % 1000, 'ms'),
  ];
  return [
    for (final (value, unit) in parts)
      if (value > 0) '$value$unit',
  ].join();
}
