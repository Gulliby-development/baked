Write a Ruby module `WordWrap` in `lib/word_wrap.rb` with `WordWrap.wrap(text, width)` that returns the text wrapped to lines of at most `width` characters, joined with `"\n"`:

- Words are split on runs of spaces; a line holds as many whole words as fit, separated by one space.
- A word longer than `width` stands on its own line, unbroken.
- An existing newline in `text` starts a new paragraph that is wrapped on its own; an empty line stays empty.
- `width` below 1 raises `ArgumentError`.

Add Minitest tests in `test/word_wrap_test.rb` that `rake test` runs, and a README.md.
