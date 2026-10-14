import { type ReactNode, useMemo } from "react";
import { bridge } from "../../client/bridge.js";
import { cn } from "../../lib/cn.js";
import { type Align, type Block, type Inline, parseMarkdown } from "./markdown-parse.js";

/** Inline code in assistant text and tool titles. */
export const INLINE_CODE =
  "font-mono text-[13px] text-[var(--accent-soft)] bg-raised border border-border px-[5px] py-0 rounded-[4px]";
const BLOCK_SPACING = "mt-0 mx-0 mb-[10px]";
const LIST = `${BLOCK_SPACING} pl-[22px] [&_ul]:mb-0 [&_ol]:mb-0 [&_li_p]:mb-0 [&_li]:mt-[2px]`;
const HEADING = "mt-[14px] mx-0 mb-[6px] text-foreground font-semibold";
const HEADING_SIZE = ["text-[18px]", "text-[16px]", "text-[15px]"];
const CELL = "px-3 py-[7px] align-top border-b border-b-[color:var(--line)]";
const ALIGN: Record<Exclude<Align, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map(inline);
}

function inline(node: Inline, i: number): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "break":
      return <br key={i} />;
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
    case "del":
      return (
        <del key={i} className="text-muted-foreground">
          {inlines(node.children)}
        </del>
      );
    case "link":
      return (
        <a
          key={i}
          href={node.href}
          rel="noreferrer"
          title={node.href}
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

/** About four lines of a quoted answer, fading out at the bottom. */
export const CLAMPED =
  "max-h-[6.2em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]";

/** A task list mark in BAKED style rather than a native checkbox. */
function TaskMark({ checked }: { checked: boolean }) {
  return (
    <span
      role="img"
      aria-label={checked ? "Done" : "Not done"}
      className={cn(
        "mr-2 mt-[0.35em] inline-flex size-[15px] flex-none items-center justify-center rounded-[3px] border-2 border-border",
        checked ? "bg-main text-main-foreground" : "bg-background",
      )}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        </svg>
      )}
    </span>
  );
}

function table(node: Extract<Block, { type: "table" }>, key: number): ReactNode {
  const align = (i: number) => ALIGN[node.align[i] ?? "left"];
  return (
    <div
      key={key}
      className={`${BLOCK_SPACING} max-w-full overflow-x-auto rounded-base border-2 border-border shadow-sm-hard`}
    >
      <table className="w-full border-collapse text-[0.93em] leading-[1.5] wrap-break-word [&_tbody_tr:last-child>td]:border-b-0">
        <thead className="bg-raised">
          <tr>
            {node.header.map((cell, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                key={i}
                scope="col"
                className={cn(
                  "px-3 py-2 align-bottom border-b-2 border-b-border font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-foreground",
                  align(i),
                )}
              >
                {inlines(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={r} className="even:bg-[color-mix(in_srgb,var(--bg-raised)_45%,transparent)]">
              {node.header.map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <td key={i} className={cn(CELL, align(i), "min-w-[80px]")}>
                  {inlines(row[i] ?? [])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
      const Tag = node.level <= 1 ? "h2" : node.level === 2 ? "h3" : "h4";
      return (
        <Tag key={key} className={cn(HEADING, HEADING_SIZE[Math.min(node.level, 3) - 1])}>
          {inlines(node.children)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre
          key={key}
          className={`${BLOCK_SPACING} bg-[var(--bg-code)] border-2 border-border rounded-base shadow-sm-hard px-[14px] py-3 overflow-x-auto text-[13px] leading-[1.6]`}
          {...(node.lang ? { "data-lang": node.lang } : {})}
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
      const tasks = node.items.some((item) => item.checked !== undefined);
      const items = node.items.map((item, i) =>
        item.checked === undefined ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
          <li key={i}>{item.children.map(block)}</li>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
          <li key={i} className="flex list-none items-start">
            <TaskMark checked={item.checked} />
            <div className="min-w-0 flex-1">{item.children.map(block)}</div>
          </li>
        ),
      );
      return node.ordered ? (
        <ol key={key} start={node.start} className={cn(LIST, "list-decimal")}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={cn(LIST, "list-disc", tasks && "pl-1")}>
          {items}
        </ul>
      );
    }
    case "table":
      return table(node, key);
    case "rule":
      return (
        <hr key={key} className="my-[14px] border-x-0 border-b-0 border-t border-t-[var(--line)]" />
      );
  }
}

/**
 * Assistant text as Markdown, built from React elements only (no HTML from the model).
 * `streaming` hides a link the model has not finished writing; `compact` is the smaller size
 * for cards that quote an answer.
 */
export function Markdown({
  text,
  streaming = false,
  compact = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text, { streaming }), [text, streaming]);
  return (
    <div
      className={cn(
        "min-w-0 text-soft-foreground wrap-anywhere [&>:first-child]:mt-0 [&>:last-child]:mb-0",
        compact ? "text-[13px] leading-[1.5]" : "text-[15px] leading-[1.7]",
        className,
      )}
    >
      {blocks.map(block)}
    </div>
  );
}
