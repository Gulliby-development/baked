/**
 * Assistant Markdown as plain lines for the coordinator popup, which shows the tail of its
 * conversation that fits and so needs every line wrapped up front. The chat draws the same text
 * with OpenTUI's `<markdown>`; this keeps what that shows (tables with borders, lists, headings,
 * emphasis, inline code and links without their markers) without giving up the line budget.
 */
import { Lexer, type Token, type Tokens } from "marked";
import type { LineTone, ViewLine } from "./model.js";

type Wrap = (text: string, width: number) => string[];

/** Text of inline tokens without their Markdown markers. */
function inline(tokens: Token[] | undefined): string {
  let out = "";
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
      case "em":
      case "del":
        out += inline((token as Tokens.Strong).tokens);
        break;
      case "codespan":
        out += decodeEntities((token as Tokens.Codespan).text);
        break;
      case "link": {
        const link = token as Tokens.Link;
        const text = inline(link.tokens);
        out += !link.href || text === link.href ? text : `${text} (${link.href})`;
        break;
      }
      case "image":
        out += (token as Tokens.Image).text;
        break;
      case "br":
        out += "\n";
        break;
      case "text": {
        const text = token as Tokens.Text;
        out += text.tokens ? inline(text.tokens) : decodeEntities(text.text);
        break;
      }
      default:
        out += decodeEntities(
          "text" in token && typeof token.text === "string" ? token.text : token.raw,
        );
    }
  }
  return out;
}

/** marked keeps HTML entities it escaped in text tokens; the terminal shows the characters. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return width <= 1 ? "…".slice(0, width) : `${text.slice(0, width - 1)}…`;
}

/** A table with rounded borders, its columns narrowed from the widest until it fits `width`. */
function tableLines(table: Tokens.Table, width: number): string[] {
  const header = table.header.map((cell) => inline(cell.tokens).replace(/\s+/g, " ").trim());
  const rows = table.rows.map((row) =>
    row.map((cell) => inline(cell.tokens).replace(/\s+/g, " ").trim()),
  );
  const widths = header.map((cell, i) =>
    Math.max(1, cell.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  // Each column has a space on either side and a border after it, plus the first border.
  const room = width - 1 - widths.length * 3;
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 1) <= 1) break;
    widths[widest] = (widths[widest] ?? 1) - 1;
  }
  const rule = (left: string, middle: string, right: string) =>
    `${left}${widths.map((w) => "─".repeat(w + 2)).join(middle)}${right}`;
  const row = (cells: string[]) =>
    `│${widths.map((w, i) => ` ${fit(cells[i] ?? "", w)} `).join("│")}│`;
  return [
    rule("╭", "┬", "╮"),
    row(header),
    rule("├", "┼", "┤"),
    ...rows.map(row),
    rule("╰", "┴", "╯"),
  ];
}

function blockLines(
  tokens: Token[],
  width: number,
  wrap: Wrap,
  tone: LineTone,
  lines: ViewLine[],
  blank = false,
): void {
  const push = (text: string, lineTone = tone) => {
    for (const line of wrap(text, width)) lines.push({ text: line, tone: lineTone });
  };
  // A blank line between blocks of the reply stays, as the chat shows it.
  let gap = false;
  for (const token of tokens) {
    if (token.type === "space") {
      gap = lines.length > 0;
      continue;
    }
    if (gap && blank) lines.push({ text: "", tone });
    gap = /\n[ \t]*\n$/.test(token.raw);
    switch (token.type) {
      case "heading":
        push(inline((token as Tokens.Heading).tokens), "accent");
        break;
      case "paragraph":
        push(inline((token as Tokens.Paragraph).tokens));
        break;
      case "text": {
        const text = token as Tokens.Text;
        push(text.tokens ? inline(text.tokens) : decodeEntities(text.text));
        break;
      }
      case "code":
        for (const line of (token as Tokens.Code).text.split("\n"))
          lines.push({ text: `  ${line}`.slice(0, width), tone: "tool" });
        break;
      case "blockquote": {
        const quoted: ViewLine[] = [];
        blockLines((token as Tokens.Blockquote).tokens, width - 2, wrap, "muted", quoted);
        for (const line of quoted) lines.push({ text: `│ ${line.text}`, tone: "muted" });
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, i) => {
          const start = typeof list.start === "number" ? list.start : 1;
          const marker = item.task
            ? item.checked
              ? "✓ "
              : "○ "
            : list.ordered
              ? `${start + i}. `
              : "• ";
          const nested: ViewLine[] = [];
          blockLines(item.tokens, width - marker.length, wrap, tone, nested);
          const pad = " ".repeat(marker.length);
          nested.forEach((line, n) => {
            lines.push({ text: `${n === 0 ? marker : pad}${line.text}`, tone: line.tone });
          });
        });
        break;
      }
      case "table":
        for (const line of tableLines(token as Tokens.Table, width))
          lines.push({ text: line, tone });
        break;
      case "hr":
        lines.push({ text: "─".repeat(Math.min(width, 40)), tone: "muted" });
        break;
      default:
        if (token.raw.trim()) push(token.raw.trim());
    }
  }
}

/** Assistant Markdown as lines of at most `width` columns. */
export function markdownLines(text: string, width: number, wrap: Wrap): ViewLine[] {
  const lines: ViewLine[] = [];
  blockLines(
    new Lexer({ gfm: true }).lex(text),
    Math.max(1, width),
    wrap,
    "assistant",
    lines,
    true,
  );
  return lines;
}
