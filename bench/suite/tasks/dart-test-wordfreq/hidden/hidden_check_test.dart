import 'package:test/test.dart';
import 'package:wordfreq/wordfreq.dart';

void main() {
  test('counts lowercased words, most frequent first', () {
    expect(topWords('The cat and the hat. THE end', 2), [('the', 3), ('and', 1)]);
  });
  test('ties are alphabetical', () {
    expect(topWords('b a c b a c', 3), [('a', 2), ('b', 2), ('c', 2)]);
  });
  test('apostrophes inside words only', () {
    expect(topWords("don't 'quoted' don't", 5), [("don't", 2), ('quoted', 1)]);
  });
  test('non-ASCII letters are letters', () {
    expect(topWords('Ünïcode ünïcode café', 5), [('ünïcode', 2), ('café', 1)]);
  });
  test('n bounds', () {
    expect(topWords('a b', 10), [('a', 1), ('b', 1)]);
    expect(topWords('a b', 0), isEmpty);
    expect(topWords('a b', -1), isEmpty);
    expect(topWords('', 3), isEmpty);
  });
}
