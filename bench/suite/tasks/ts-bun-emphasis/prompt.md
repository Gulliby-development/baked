Write a TypeScript module `src/inline.ts` for Bun that exports `renderInline(text: string): string`. It renders the emphasis of one line of Markdown inline text to HTML, exactly as CommonMark 0.31 section 6.2 "Emphasis and strong emphasis" specifies:

- `*` and `_` delimiter runs become `<em>` and `<strong>`, following the left- and right-flanking rules, the intraword rule for `_` and the rule of 3.
- Emphasis nests in any order and depth: `*a **b** c*` is `<em>a <strong>b</strong> c</em>`, `***foo***` is `<em><strong>foo</strong></em>`, and a delimiter that matches nothing stays literal text (`**foo*` is `*<em>foo</em>`).
- A backslash before an ASCII punctuation character gives that character as text (`\*` is `*`).
- `&`, `<`, `>` and `"` in text are written as `&amp;`, `&lt;`, `&gt;` and `&quot;`.
- No other inline syntax: code spans, links and raw HTML are plain text.

Add `bun:test` tests under `tests/` and a README.md with an example.
