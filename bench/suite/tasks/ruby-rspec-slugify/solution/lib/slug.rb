# frozen_string_literal: true

# URL slugs from free text.
module Slug
  def self.slugify(text, separator: '-')
    plain = text.unicode_normalize(:nfkd).gsub(/\p{Mn}/, '').downcase
    plain.split(/[^a-z0-9]+/).reject(&:empty?).join(separator)
  end
end
