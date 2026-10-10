/**
 * A small Markdown parser for assistant text. It returns a tree that the screen renders as React
 * elements, so model output never reaches the DOM as HTML: raw tags stay literal text.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "rule" };

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

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

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "\\" && i + 1 < source.length && /[\\`*_[\]()#>+\-.!]/.test(source[i + 1] ?? "")) {
      pushText(out, source[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(source.slice(i))?.[0] ?? "`";
      const end = source.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        out.push({ type: "code", text: source.slice(i + ticks.length, end).trim() });
        i = end + ticks.length;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && source[i + 1] === ch) {
      const marker = ch + ch;
      const end = source.indexOf(marker, i + 2);
      if (end > i + 2) {
        out.push({ type: "strong", children: parseInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const end = source.indexOf(ch, i + 1);
      const inner = source.slice(i + 1, end);
      const wordStart = ch === "*" || i === 0 || /\W/.test(source[i - 1] ?? " ");
      if (end > i + 1 && wordStart && !/^\s|\s$/.test(inner)) {
        out.push({ type: "em", children: parseInline(inner) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(source.slice(i));
      if (link) {
        const href = safeHref(link[2] ?? "");
        const children = parseInline(link[1] ?? "");
        if (href) out.push({ type: "link", href, children });
        else for (const child of children) out.push(child);
        i += link[0].length;
        continue;
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0)
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```"))
        body.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        children: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? ""))
        body.push(QUOTE.exec(lines[i++] ?? "")?.[1] ?? "");
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n")) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = !bullet;
      const pattern = isOrdered ? ORDERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const item = pattern.exec(current);
        if (item) items.push((isOrdered ? item[2] : item[1]) ?? "");
        else if (/^\s{2,}\S/.test(current) && items.length > 0)
          items[items.length - 1] += ` ${current.trim()}`;
        else break;
        i++;
      }
      blocks.push({
        type: "list",
        ordered: isOrdered,
        start: isOrdered ? Number(ordered?.[1] ?? 1) : 1,
        items: items.map(parseInline),
      });
      continue;
    }
    paragraph.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}
