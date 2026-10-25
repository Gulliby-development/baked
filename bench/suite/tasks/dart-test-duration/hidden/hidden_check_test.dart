import 'package:duration/duration.dart';
import 'package:test/test.dart';

void main() {
  test('parses parts in any order', () {
    expect(parseDuration('1h30m'), const Duration(hours: 1, minutes: 30));
    expect(parseDuration('5s 2m'), const Duration(minutes: 2, seconds: 5));
    expect(parseDuration('250ms'), const Duration(milliseconds: 250));
    expect(parseDuration('1m1s1ms'), const Duration(minutes: 1, seconds: 1, milliseconds: 1));
  });
  test('rejects malformed text', () {
    for (final text in ['', ' ', '1x', '-1s', '1h1h', 'h', '1.5s', '1 s']) {
      expect(() => parseDuration(text), throwsFormatException, reason: text);
    }
  });
  test('formats the shortest form', () {
    expect(formatDuration(const Duration(minutes: 90)), '1h30m');
    expect(formatDuration(Duration.zero), '0s');
    expect(formatDuration(const Duration(hours: 2, milliseconds: 5)), '2h5ms');
    expect(() => formatDuration(const Duration(seconds: -1)), throwsArgumentError);
  });
  test('round trips', () {
    for (final d in [const Duration(seconds: 59), const Duration(hours: 25, seconds: 1)]) {
      expect(parseDuration(formatDuration(d)), d);
    }
  });
}
