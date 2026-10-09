import { describe, expect, test } from "bun:test";
import { codeToAnsi, codeToStyledTokens, getHighlighter, isShikiLanguage } from "../src/core/utils/shiki.js";
import { renderMarkdownToAnsi } from "../src/core/utils/markdown-ansi.js";
import { parseInstructionStructure } from "../src/core/instructions.js";

describe("shiki", () => {
  test("getHighlighter returns a singleton", async () => {
    const hl1 = await getHighlighter();
    const hl2 = await getHighlighter();
    expect(hl1).toBe(hl2);
  });

  test("isShikiLanguage returns true for loaded languages", async () => {
    await getHighlighter(); // ensure loaded
    expect(isShikiLanguage("typescript")).toBe(true);
    expect(isShikiLanguage("ts")).toBe(true);
    expect(isShikiLanguage("python")).toBe(true);
    expect(isShikiLanguage("py")).toBe(true);
    expect(isShikiLanguage("rust")).toBe(true);
    expect(isShikiLanguage("go")).toBe(true);
    expect(isShikiLanguage("bash")).toBe(true);
    expect(isShikiLanguage("sh")).toBe(true);
  });

  test("isShikiLanguage returns false for unknown languages", async () => {
    await getHighlighter();
    expect(isShikiLanguage("brainfuck")).toBe(false);
    expect(isShikiLanguage("")).toBe(false);
  });

  test("codeToAnsi produces ANSI escape sequences", async () => {
    const result = await codeToAnsi('const x = 42;', "ts");
    // Should contain ANSI escape codes
    expect(result).toContain("\x1b[");
    // Should contain the original text content
    expect(result).toContain("const");
    expect(result).toContain("42");
  });

  test("codeToAnsi falls back gracefully for unknown lang", async () => {
    const code = "hello world";
    const result = await codeToAnsi(code, "nonexistent_lang_xyz");
    // Should still return the code content
    expect(result).toContain("hello world");
  });

  test("codeToAnsi works without lang (text mode)", async () => {
    const result = await codeToAnsi("plain text");
    expect(result).toContain("plain text");
  });

  test("codeToStyledTokens returns structured tokens", async () => {
    const tokens = await codeToStyledTokens('const x = 42;', "ts");
    expect(tokens.length).toBeGreaterThan(0);
    // Each line should have tokens
    expect(tokens[0]!.length).toBeGreaterThan(0);
    // Each token should have content
    for (const line of tokens) {
      for (const token of line) {
        expect(typeof token.content).toBe("string");
      }
    }
  });

  test("codeToStyledTokens includes color info", async () => {
    const tokens = await codeToStyledTokens('function foo() { return 1; }', "ts");
    // At least some tokens should have colors
    const hasColors = tokens.some((line) => line.some((t) => t.color));
    expect(hasColors).toBe(true);
  });

  test("codeToAnsi handles multiline code", async () => {
    const code = 'const a = 1;\nconst b = 2;\nconst c = a + b;';
    const result = await codeToAnsi(code, "ts");
    // Should have newlines in output
    expect(result.split("\n").length).toBe(3);
  });

  test("lang aliases work correctly", async () => {
    const jsResult = await codeToAnsi('var x = 1;', "js");
    const jsFullResult = await codeToAnsi('var x = 1;', "javascript");
    // Both should produce ANSI output
    expect(jsResult).toContain("\x1b[");
    expect(jsFullResult).toContain("\x1b[");
  });
});

describe("markdown-ansi", () => {
  test("renders headings with ANSI formatting", async () => {
    const result = await renderMarkdownToAnsi("# Hello World");
    expect(result).toContain("Hello World");
    // Should have ANSI bold
    expect(result).toContain("\x1b[1m");
  });

  test("renders bold text", async () => {
    const result = await renderMarkdownToAnsi("This is **bold** text.");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("bold");
  });

  test("renders italic text", async () => {
    const result = await renderMarkdownToAnsi("This is *italic* text.");
    expect(result).toContain("\x1b[3m");
    expect(result).toContain("italic");
  });

  test("renders inline code with background", async () => {
    const result = await renderMarkdownToAnsi("Use `npm install` to install.");
    expect(result).toContain("npm install");
    // Should have background color escape
    expect(result).toContain("\x1b[48;2;");
  });

  test("renders code blocks with syntax highlighting", async () => {
    const md = '# Example\n\n```typescript\nconst x = 42;\n```';
    const result = await renderMarkdownToAnsi(md);
    expect(result).toContain("42");
    expect(result).toContain("const");
    // Should have ANSI color codes from shiki
    expect(result).toContain("\x1b[38;2;");
  });

  test("renders lists", async () => {
    const md = "- item one\n- item two\n- item three";
    const result = await renderMarkdownToAnsi(md);
    expect(result).toContain("item one");
    expect(result).toContain("item two");
    expect(result).toContain("•");
  });

  test("renders horizontal rules", async () => {
    const md = "above\n\n---\n\nbelow";
    const result = await renderMarkdownToAnsi(md);
    expect(result).toContain("─");
    expect(result).toContain("above");
    expect(result).toContain("below");
  });

  test("renders links", async () => {
    const md = "Visit [Google](https://google.com) for search.";
    const result = await renderMarkdownToAnsi(md);
    expect(result).toContain("Google");
    expect(result).toContain("https://google.com");
  });

  test("renders blockquotes", async () => {
    const md = "> This is a quote";
    const result = await renderMarkdownToAnsi(md);
    expect(result).toContain("│");
    expect(result).toContain("This is a quote");
  });

  test("handles complex markdown", async () => {
    const md = `# Title

Some **bold** and *italic* text.

## Code Example

\`\`\`python
def hello():
    print("world")
\`\`\`

- First item
- Second item

> A wise quote

---

The end.`;
    const result = await renderMarkdownToAnsi(md);
    expect(result).toContain("Title");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("First item");
    expect(result).toContain("A wise quote");
    expect(result).toContain("The end");
  });

  test("cleans up excessive newlines", async () => {
    const md = "# Title\n\n\n\n\nSome text";
    const result = await renderMarkdownToAnsi(md);
    // No triple newlines
    expect(result).not.toContain("\n\n\n");
  });
});

describe("instruction parsing", () => {
  test("parses headings into sections", () => {
    const md = `# Setup

Install dependencies.

## Testing

Run tests with bun.

### Subsection

Details here.`;
    const result = parseInstructionStructure(md);
    expect(result.sections.length).toBe(3);
    expect(result.sections[0]!.heading).toBe("Setup");
    expect(result.sections[0]!.depth).toBe(1);
    expect(result.sections[0]!.content).toContain("Install dependencies");
    expect(result.sections[1]!.heading).toBe("Testing");
    expect(result.sections[1]!.depth).toBe(2);
    expect(result.sections[2]!.heading).toBe("Subsection");
    expect(result.sections[2]!.depth).toBe(3);
  });

  test("extracts code blocks", () => {
    const md = `# Config

\`\`\`json
{"key": "value"}
\`\`\`

\`\`\`bash
npm install
\`\`\``;
    const result = parseInstructionStructure(md);
    expect(result.codeBlocks.length).toBe(2);
    expect(result.codeBlocks[0]!.lang).toBe("json");
    expect(result.codeBlocks[0]!.code).toContain('"key"');
    expect(result.codeBlocks[1]!.lang).toBe("bash");
    expect(result.codeBlocks[1]!.code).toContain("npm install");
  });

  test("handles markdown with no headings", () => {
    const md = "Just some plain text.\n\nWith paragraphs.";
    const result = parseInstructionStructure(md);
    expect(result.sections.length).toBe(1);
    expect(result.sections[0]!.heading).toBe("");
    expect(result.sections[0]!.depth).toBe(0);
    expect(result.sections[0]!.content).toContain("Just some plain text");
  });

  test("preserves raw content", () => {
    const md = "# Hello\n\nWorld";
    const result = parseInstructionStructure(md);
    expect(result.raw).toBe(md);
  });

  test("handles empty content", () => {
    const result = parseInstructionStructure("");
    expect(result.sections.length).toBe(0);
    expect(result.codeBlocks.length).toBe(0);
  });

  test("parses real-world baked.md style", () => {
    const md = `# Project Conventions

## Code Style

- Use TypeScript strict mode
- Prefer const over let
- No any types

## Testing

Run all tests:

\`\`\`bash
bun test
\`\`\`

## Architecture

The project uses a layered architecture:

1. Core layer
2. UI layer
3. Integration layer`;

    const result = parseInstructionStructure(md);
    expect(result.sections.length).toBe(4);
    expect(result.sections[0]!.heading).toBe("Project Conventions");
    expect(result.sections[1]!.heading).toBe("Code Style");
    expect(result.sections[1]!.content).toContain("TypeScript strict mode");
    expect(result.sections[2]!.heading).toBe("Testing");
    expect(result.codeBlocks.length).toBe(1);
    expect(result.codeBlocks[0]!.lang).toBe("bash");
    expect(result.sections[3]!.heading).toBe("Architecture");
  });
});
