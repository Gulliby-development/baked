import { describe, expect, test } from "bun:test";
import { renderInline } from "./src/inline.ts";

// Expected HTML follows CommonMark 0.31 emphasis rules.
const cases: Record<string, [string, string][]> = {
  "single runs": [
    ["*foo bar*", "<em>foo bar</em>"],
    ["_foo bar_", "<em>foo bar</em>"],
    ["**foo bar**", "<strong>foo bar</strong>"],
    ["__foo bar__", "<strong>foo bar</strong>"],
    ["a * foo bar*", "a * foo bar*"],
    ["foo*bar*", "foo<em>bar</em>"],
    ["foo_bar_", "foo_bar_"],
    ["5*6*78", "5<em>6</em>78"],
    ["_foo_bar", "_foo_bar"],
  ],
  "nested emphasis": [
    ["*a **b** c*", "<em>a <strong>b</strong> c</em>"],
    ["**a *b* c**", "<strong>a <em>b</em> c</strong>"],
    ["_foo __bar__ baz_", "<em>foo <strong>bar</strong> baz</em>"],
    ["__foo _bar_ baz__", "<strong>foo <em>bar</em> baz</strong>"],
    ["*foo *bar**", "<em>foo <em>bar</em></em>"],
    ["*foo **bar *baz* bim** bop*", "<em>foo <strong>bar <em>baz</em> bim</strong> bop</em>"],
    ["**foo *bar **baz** bim* bop**", "<strong>foo <em>bar <strong>baz</strong> bim</em> bop</strong>"],
  ],
  "runs of three and more": [
    ["***foo***", "<em><strong>foo</strong></em>"],
    ["***foo** bar*", "<em><strong>foo</strong> bar</em>"],
    ["*foo **bar***", "<em>foo <strong>bar</strong></em>"],
    ["**foo *bar***", "<strong>foo <em>bar</em></strong>"],
    ["***foo* bar**", "<strong><em>foo</em> bar</strong>"],
    ["_____foo_____", "<em><strong><strong>foo</strong></strong></em>"],
    ["******foo******", "<strong><strong><strong>foo</strong></strong></strong>"],
    ["foo***bar***baz", "foo<em><strong>bar</strong></em>baz"],
  ],
  "rule of three": [
    ["*foo**bar**baz*", "<em>foo<strong>bar</strong>baz</em>"],
    ["*foo**bar*", "<em>foo**bar</em>"],
    ["**foo*bar*baz**", "<strong>foo<em>bar</em>baz</strong>"],
    ["foo******bar*********baz", "foo<strong><strong><strong>bar</strong></strong></strong>***baz"],
  ],
  "unmatched delimiters stay text": [
    ["**foo*", "*<em>foo</em>"],
    ["*foo**", "<em>foo</em>*"],
    ["***foo**", "*<strong>foo</strong>"],
    ["****foo*", "***<em>foo</em>"],
    ["**foo***", "<strong>foo</strong>*"],
    ["*foo****", "<em>foo</em>***"],
    ["foo ***", "foo ***"],
    ["** is not empty", "** is not empty"],
    ["*foo _bar* baz_", "<em>foo _bar</em> baz_"],
    ["*foo __bar *baz bim__ bam*", "<em>foo <strong>bar *baz bim</strong> bam</em>"],
  ],
  "escapes and html": [
    ["foo *\\**", "foo <em>*</em>"],
    ["\\*not emphasis\\*", "*not emphasis*"],
    ["x & <y> \"z\"", "x &amp; &lt;y&gt; &quot;z&quot;"],
    ["*a < b*", "<em>a &lt; b</em>"],
  ],
};

describe("renderInline", () => {
  for (const [name, list] of Object.entries(cases))
    test(name, () => {
      for (const [input, html] of list) expect([input, renderInline(input)]).toEqual([input, html]);
    });
});
