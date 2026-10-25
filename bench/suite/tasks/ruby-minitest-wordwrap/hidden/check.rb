# frozen_string_literal: true

require "minitest/autorun"
require File.join(ARGV.fetch(0), "lib", "word_wrap")
ARGV.clear

class WordWrapHiddenTest < Minitest::Test
  def test_fills_lines
    assert_equal "the quick\nbrown fox\njumps", WordWrap.wrap("the quick brown fox jumps", 10)
  end

  def test_collapses_spaces
    assert_equal "a b\nc", WordWrap.wrap("a   b    c", 3)
  end

  def test_long_word_alone
    assert_equal "a\nsupercalifragilistic\nb", WordWrap.wrap("a supercalifragilistic b", 5)
  end

  def test_paragraphs
    assert_equal "one\ntwo\n\nthree", WordWrap.wrap("one two\n\nthree", 4)
  end

  def test_bad_width
    assert_raises(ArgumentError) { WordWrap.wrap("x", 0) }
  end
end
