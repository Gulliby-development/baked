import { useState } from "react";
import type { AttentionItem } from "../../shared/api.js";
import { ago } from "../format.js";
import { projectHref } from "../router.js";
import { useDesktop } from "../store.js";

const KIND_MARK: Record<string, string> = { approval: "⚑", clarification: "?", delivery: "↗" };

function Item({ item }: { item: AttentionItem }) {
  return (
    <a
      className="item"
      href={projectHref(item.projectKey, "runs", item.runId)}
      style={{ textDecoration: "none" }}
    >
      <span
        className="mono"
        style={{ color: item.blocking ? "var(--warn)" : "var(--info)" }}
        aria-hidden="true"
      >
        {KIND_MARK[item.kind] ?? "◎"}
      </span>
      <span className="stack" style={{ gap: 2 }}>
        <span style={{ color: "var(--text)" }}>{item.featureId}</span>
        <span style={{ fontSize: 12, color: "var(--text-4)" }}>
          <span style={{ color: "var(--info)" }}>{item.projectName}</span> · {item.kind} ·{" "}
          {ago(item.createdAt)}
        </span>
      </span>
    </a>
  );
}

export function AttentionScreen() {
  const { attention } = useDesktop();
  const [filter, setFilter] = useState<string | null>(null);
  const projects = [...new Map(attention.map((i) => [i.projectKey, i.projectName])).entries()];
  const shown = attention.filter((i) => filter === null || i.projectKey === filter);
  const blocking = shown.filter((i) => i.blocking);
  const advisory = shown.filter((i) => !i.blocking);
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h1>Needs you</h1>
      <p className="lede">
        Everything in every open project that waits for a person. New blocking items also arrive as
        system notifications.
      </p>
      {projects.length > 1 && (
        <fieldset className="seg-group" aria-label="Filter by project">
          <button
            type="button"
            className="seg"
            aria-pressed={filter === null}
            onClick={() => setFilter(null)}
          >
            All · {attention.length}
          </button>
          {projects.map(([key, name]) => (
            <button
              key={key}
              type="button"
              className="seg"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {name} · {attention.filter((i) => i.projectKey === key).length}
            </button>
          ))}
        </fieldset>
      )}
      {shown.length === 0 && (
        <div className="empty">Nothing waits for you in the open projects.</div>
      )}
      {blocking.length > 0 && <p className="label">Blocking</p>}
      {blocking.map((item) => (
        <Item key={`${item.projectKey}:${item.runId}:${item.requestId ?? item.kind}`} item={item} />
      ))}
      {advisory.length > 0 && (
        <p className="label" style={{ marginTop: 10 }}>
          Advisory
        </p>
      )}
      {advisory.map((item) => (
        <Item key={`${item.projectKey}:${item.runId}:${item.requestId ?? item.kind}`} item={item} />
      ))}
    </div>
  );
}
