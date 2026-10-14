/**
 * Markdown for assistant text, read with marked's GitHub-flavoured lexer and turned into a small
 * tree that the screen renders as React elements. Model output never reaches the DOM as HTML: raw
 * tags stay literal text, and only http(s) and mailto links become links.
 */
import { lexer, type Token, type Tokens } from "marked";

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** Set for a task list item (`- [ ]` or `- [x]`). */
  checked?: boolean;
  children: Block[];
}

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

/** Chat text keeps its single line breaks, as GitHub comments do. */
const OPTIONS = { gfm: true, breaks: true } as const;

/** Only links a browser can safely open outside the app. */
function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out.at(-1);
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

function pushAll(out: Inline[], nodes: Inline[]): void {
  for (const node of nodes) {
    if (node.type === "text") pushText(out, node.text);
    else out.push(node);
  }
}

function inlineTokens(tokens: Token[] | undefined): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
        if ("tokens" in token && token.tokens?.length) pushAll(out, inlineTokens(token.tokens));
        else pushText(out, token.text);
        break;
      case "escape":
      case "html":
        pushText(out, token.type === "html" ? token.raw : token.text);
        break;
      case "codespan":
        out.push({ type: "code", text: token.text });
        break;
      case "strong":
      case "em":
      case "del":
        out.push({ type: token.type, children: inlineTokens(token.tokens) });
        break;
      case "br":
        out.push({ type: "break" });
        break;
      case "link": {
        const children = inlineTokens(token.tokens);
        const href = safeHref(token.href);
        if (href) out.push({ type: "link", href, children });
        else pushAll(out, children);
        break;
      }
      case "image": {
        // Images are not loaded from model output; the alt text links to the address instead.
        const href = safeHref(token.href);
        const children: Inline[] = [{ type: "text", text: token.text || token.href }];
        if (href) out.push({ type: "link", href, children });
        else pushAll(out, children);
        break;
      }
      default:
        pushText(out, token.raw);
    }
  }
  return out;
}

function blockTokens(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
      case "checkbox":
        break;
      case "paragraph":
        out.push({ type: "paragraph", children: inlineTokens(token.tokens) });
        break;
      case "text": {
        // A tight list item's text, or loose text between blocks.
        const children =
          "tokens" in token && token.tokens?.length
            ? inlineTokens(token.tokens)
            : [{ type: "text" as const, text: token.text }];
        out.push({ type: "paragraph", children });
        break;
      }
      case "heading":
        out.push({ type: "heading", level: token.depth, children: inlineTokens(token.tokens) });
        break;
      case "code":
        out.push({
          type: "code",
          lang: (token.lang ?? "").split(/\s/)[0] ?? "",
          text: token.text,
        });
        break;
      case "blockquote":
        out.push({ type: "quote", children: blockTokens(token.tokens ?? []) });
        break;
      case "list": {
        const list = token as Tokens.List;
        out.push({
          type: "list",
          ordered: list.ordered,
          start: list.ordered && typeof list.start === "number" ? list.start : 1,
          items: list.items.map((item) => ({
            ...(item.task ? { checked: item.checked === true } : {}),
            children: blockTokens(item.tokens),
          })),
        });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        out.push({
          type: "table",
          align: table.align,
          header: table.header.map((cell) => inlineTokens(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inlineTokens(cell.tokens))),
        });
        break;
      }
      case "hr":
        out.push({ type: "rule" });
        break;
      default:
        // Raw HTML blocks and anything unknown stay visible as plain text.
        if (token.raw.trim())
          out.push({ type: "paragraph", children: [{ type: "text", text: token.raw.trim() }] });
    }
  }
  return out;
}

/**
 * Hides a link the model is still writing at the very end of a streaming reply (`[`, `[text`,
 * `[text](https://ex`), so half a link does not flash up as stray brackets.
 */
export function trimPartialMarkdown(source: string): string {
  return source.replace(/!?\[[^\]\n]*(\]\([^)\s]*)?$/, "").replace(/!?\[[^\]\n]*\]$/, "");
}

export function parseInline(source: string): Inline[] {
  const blocks = lexer(source, OPTIONS);
  const out: Inline[] = [];
  for (const block of blockTokens(blocks)) {
    if (out.length > 0) out.push({ type: "break" });
    if (block.type === "paragraph" || block.type === "heading") pushAll(out, block.children);
  }
  return out;
}

export function parseMarkdown(source: string, options: { streaming?: boolean } = {}): Block[] {
  const text = source.replace(/\r\n?/g, "\n");
  return blockTokens(lexer(options.streaming ? trimPartialMarkdown(text) : text, OPTIONS));
}
