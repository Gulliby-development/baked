import { type ReactNode, useMemo } from "react";
import { bridge } from "../../client/bridge.js";
import { type Block, type Inline, parseMarkdown } from "./markdown-parse.js";

/** Inline code in assistant text and tool titles. */
export const INLINE_CODE =
  "font-mono text-[13px] text-[var(--accent-soft)] bg-raised border border-border px-[5px] py-0 rounded-[4px]";
const BLOCK_SPACING = "mt-0 mx-0 mb-[10px]";
const LIST = `${BLOCK_SPACING} pl-[22px]`;
const HEADING = "mt-[14px] mx-0 mb-[6px] text-foreground text-[15px] font-semibold";

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map(inline);
}

function inline(node: Inline, i: number): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return (
        <code key={i} className={INLINE_CODE}>
          {node.text}
        </code>
      );
    case "strong":
      return (
        <strong key={i} className="text-foreground font-semibold">
          {inlines(node.children)}
        </strong>
      );
    case "em":
      return <em key={i}>{inlines(node.children)}</em>;
    case "link":
      return (
        <a
          key={i}
          href={node.href}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void bridge.openExternal(node.href);
          }}
        >
          {inlines(node.children)}
        </a>
      );
  }
}

function block(node: Block, key: number): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} className={BLOCK_SPACING}>
          {inlines(node.children)}
        </p>
      );
    case "heading": {
      const Tag = node.level <= 2 ? "h3" : "h4";
      return (
        <Tag key={key} className={HEADING}>
          {inlines(node.children)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre
          key={key}
          className={`${BLOCK_SPACING} bg-[var(--bg-code)] border-2 border-border rounded-base shadow-sm-hard px-[14px] py-3 overflow-x-auto text-[13px] leading-[1.6]`}
        >
          <code className="font-mono text-[13px] text-soft-foreground rounded-[4px]">
            {node.text}
          </code>
        </pre>
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className={`${BLOCK_SPACING} border-l-4 border-l-main pl-3 text-muted-foreground`}
        >
          {node.children.map(block)}
        </blockquote>
      );
    case "list": {
      const items = node.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
        <li key={i}>{inlines(item)}</li>
      ));
      return node.ordered ? (
        <ol key={key} start={node.start} className={LIST}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={LIST}>
          {items}
        </ul>
      );
    }
    case "rule":
      return <hr key={key} className="border-x-0 border-b-0 border-t border-t-[var(--line)]" />;
  }
}

/** Assistant text as Markdown, built from React elements only (no HTML from the model). */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="text-soft-foreground text-[15px] leading-[1.7] wrap-anywhere [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      {blocks.map(block)}
    </div>
  );
}
