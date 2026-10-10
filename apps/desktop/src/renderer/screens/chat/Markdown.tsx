import { type ReactNode, useMemo } from "react";
import { bridge } from "../../client/bridge.js";
import { type Block, type Inline, parseMarkdown } from "./markdown.js";

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map(inline);
}

function inline(node: Inline, i: number): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return <code key={i}>{node.text}</code>;
    case "strong":
      return <strong key={i}>{inlines(node.children)}</strong>;
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
      return <p key={key}>{inlines(node.children)}</p>;
    case "heading": {
      const Tag = node.level <= 2 ? "h3" : "h4";
      return <Tag key={key}>{inlines(node.children)}</Tag>;
    }
    case "code":
      return (
        <pre key={key} className="md-code">
          <code>{node.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{node.children.map(block)}</blockquote>;
    case "list": {
      const items = node.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
        <li key={i}>{inlines(item)}</li>
      ));
      return node.ordered ? (
        <ol key={key} start={node.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "rule":
      return <hr key={key} />;
  }
}

/** Assistant text as Markdown, built from React elements only (no HTML from the model). */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map(block)}</div>;
}
