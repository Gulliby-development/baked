# frozen_string_literal: true

require "minitest/autorun"
require File.join(ARGV.fetch(0), "lib", "slug")
ARGV.clear

class SlugHiddenTest < Minitest::Test
  def test_lowercases_and_joins_words
    assert_equal "hello-world", Slug.slugify("  Hello,  World! ")
  end

  def test_strips_accents
    assert_equal "creme-brulee", Slug.slugify("Crème Brûlée")
  end

  def test_custom_separator
    assert_equal "a_b_c", Slug.slugify("a b--c", separator: "_")
  end

  def test_digits_are_kept
    assert_equal "route-66", Slug.slugify("Route 66")
  end

  def test_nothing_left
    assert_equal "", Slug.slugify("!!! ...")
  end
end
