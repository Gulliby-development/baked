# frozen_string_literal: true

# Greedy word wrapping.
module WordWrap
  def self.wrap(text, width)
    raise ArgumentError, "width must be at least 1" if width < 1

    text.split("\n", -1).map { |paragraph| wrap_paragraph(paragraph, width) }.join("\n")
  end

  def self.wrap_paragraph(paragraph, width)
    lines = []
    paragraph.split(/ +/).reject(&:empty?).each do |word|
      if lines.empty? || lines.last.length + 1 + word.length > width
        lines << word.dup
      else
        lines.last << " " << word
      end
    end
    lines.join("\n")
  end
end
