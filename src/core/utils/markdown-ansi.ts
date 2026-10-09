import { Marked, type Tokens } from "marked";
import { getThemeTokens } from "../theme/index.js";
import { codeToAnsi } from "./shiki.js";

const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKETHROUGH = "\x1b[9m";

function expandHex(hex: string): string {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  return h;
}

function hexToAnsiFg(hex: string): string {
  const n = Number.parseInt(expandHex(hex), 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

function hexToAnsiBg(hex: string): string {
  const n = Number.parseInt(expandHex(hex), 16);
  return `\x1b[48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

function colors() {
  const t = getThemeTokens();
  return {
    PURPLE: hexToAnsiFg(t.brand),
    BLUE: hexToAnsiFg(t.info),
    GREEN: hexToAnsiFg(t.success),
    YELLOW: hexToAnsiFg(t.warning),
    CYAN: hexToAnsiFg(t.info),
    GRAY: hexToAnsiFg(t.textSecondary),
    CODE_BG: hexToAnsiBg(t.bgElevated),
  };
}

/**
 * Render markdown to ANSI-formatted terminal text.
 * Code blocks are syntax-highlighted via shiki.
 */
export async function renderMarkdownToAnsi(markdown: string): Promise<string> {
  const { PURPLE, BLUE, GREEN, YELLOW, CYAN, GRAY, CODE_BG } = colors();
  const HEADING_COLORS = [PURPLE, PURPLE, BLUE, CYAN, GRAY, GRAY];

  const codeBlocks: Array<{ placeholder: string; lang: string; code: string }> = [];
  let blockIdx = 0;

  const renderer: Record<string, (...args: unknown[]) => string> = {
    heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Heading;
      const text = this.parser.parseInline(tk.tokens);
      const color = HEADING_COLORS[tk.depth - 1] ?? GRAY;
      const prefix = tk.depth <= 2 ? `${"━".repeat(Math.max(1, 4 - tk.depth))} ` : "";
      return `\n${color}${BOLD}${prefix}${text}${RST}\n\n`;
    },

    paragraph(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Paragraph;
      return `${this.parser.parseInline(tk.tokens)}\n\n`;
    },

    code(_token: unknown) {
      const tk = _token as Tokens.Code;
      const placeholder = `\x00CODEBLOCK_${String(blockIdx)}\x00`;
      codeBlocks.push({ placeholder, lang: tk.lang ?? "", code: tk.text });
      blockIdx++;
      return `${placeholder}\n`;
    },

    blockquote(this: { parser: { parse(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Blockquote;
      const body = this.parser.parse(tk.tokens);
      const lines = body.trimEnd().split("\n");
      const quoted = lines.map((l: string) => `${GRAY}  │${RST} ${ITALIC}${l}${RST}`).join("\n");
      return `${quoted}\n\n`;
    },

    list(this: { listitem(item: Tokens.ListItem, ordered?: boolean): string }, token: unknown) {
      const tk = token as Tokens.List;
      const items: string[] = [];
      for (const item of tk.items) {
        items.push(this.listitem(item, tk.ordered));
      }
      return `${items.join("")}\n`;
    },

    listitem(
      this: { parser: { parse(tokens: Tokens.Generic[]): string } },
      item: unknown,
      ordered: unknown,
    ) {
      const it = item as Tokens.ListItem;
      const text = this.parser.parse(it.tokens).trimEnd();
      const bullet = ordered ? `${YELLOW}  •${RST}` : `${YELLOW}  •${RST}`;
      if (it.task) {
        const check = it.checked ? `${GREEN}✓${RST}` : `${DIM}○${RST}`;
        return `  ${check} ${text}\n`;
      }
      return `${bullet} ${text}\n`;
    },

    hr() {
      return `${DIM}${"─".repeat(40)}${RST}\n\n`;
    },

    table(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Table;
      const rows: string[] = [];
      const headerCells = tk.header.map(
        (cell) => `${BOLD}${this.parser.parseInline(cell.tokens)}${RST}`,
      );
      rows.push(`  ${headerCells.join(`${DIM} │ ${RST}`)}`);
      rows.push(`  ${DIM}${"─".repeat(40)}${RST}`);
      for (const row of tk.rows) {
        const cells = row.map((cell) => this.parser.parseInline(cell.tokens));
        rows.push(`  ${cells.join(`${DIM} │ ${RST}`)}`);
      }
      return `${rows.join("\n")}\n\n`;
    },

    strong(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Strong;
      return `${BOLD}${this.parser.parseInline(tk.tokens)}${RST}`;
    },

    em(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Em;
      return `${ITALIC}${this.parser.parseInline(tk.tokens)}${RST}`;
    },

    codespan(token: unknown) {
      const tk = token as Tokens.Codespan;
      return `${CODE_BG}${CYAN} ${tk.text} ${RST}`;
    },

    del(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Del;
      return `${STRIKETHROUGH}${this.parser.parseInline(tk.tokens)}${RST}`;
    },

    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Link;
      const text = this.parser.parseInline(tk.tokens);
      return `${UNDERLINE}${BLUE}${text}${RST} ${DIM}(${tk.href})${RST}`;
    },

    image(token: unknown) {
      const tk = token as Tokens.Image;
      return `${DIM}[image: ${tk.text ?? tk.href}]${RST}`;
    },

    br() {
      return "\n";
    },

    html(token: unknown) {
      const tk = token as Tokens.HTML;
      return tk.text.replace(/<[^>]*>/g, "");
    },

    text(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: unknown) {
      const tk = token as Tokens.Text;
      if ("tokens" in tk && tk.tokens) {
        return this.parser.parseInline(tk.tokens);
      }
      return tk.text;
    },

    space() {
      return "\n";
    },
  };

  const marked = new Marked({ renderer, async: false });
  let result = marked.parse(markdown) as string;

  for (const block of codeBlocks) {
    try {
      const highlighted = await codeToAnsi(block.code, block.lang || undefined);
      const langLabel = block.lang ? `${DIM}${block.lang}${RST}\n` : "";
      const border = `${DIM}${"─".repeat(40)}${RST}`;
      result = result.replace(
        block.placeholder,
        `${langLabel}${border}\n${CODE_BG}${highlighted}${RST}\n${border}`,
      );
    } catch {
      result = result.replace(block.placeholder, block.code);
    }
  }

  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
