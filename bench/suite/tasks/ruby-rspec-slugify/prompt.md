Write a Ruby module `Slug` in `lib/slug.rb` with `Slug.slugify(text, separator: "-")` that returns a URL slug:

- Letters are lowercased and accented Latin letters lose their accents (`"Crème Brûlée"` is `"creme-brulee"`).
- Every run of characters that are not ASCII letters or digits becomes one `separator`, and the slug has no separator at its start or end (`"  Hello,  World! "` is `"hello-world"`).
- `separator:` may be any string (`Slug.slugify("a b", separator: "_")` is `"a_b"`).
- A text with no letters or digits gives `""`.

Add RSpec specs in `spec/slug_spec.rb` runnable with `rspec`, keep the code clean under `rubocop` with the given `.rubocop.yml`, and add a README.md.
