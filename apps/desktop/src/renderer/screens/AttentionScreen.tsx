import { type ComponentType, useEffect, useState } from "react";
import type { AttentionItem } from "../../shared/api.js";
import {
  attentionItemId,
  attentionTitle,
  type DetailKind,
  detailKind,
  findAttention,
  groupAttention,
  kindLabel,
  sourceOf,
} from "../../shared/attention.js";
import { Alert } from "../components/ui/alert.js";
import { Empty } from "../components/ui/empty.js";
import { ago } from "../format.js";
import { cn } from "../lib/cn.js";
import { ITEM, LABEL, LEDE, STACK } from "../lib/styles.js";
import { href } from "../router.js";
import { useDesktop } from "../store.js";
import { ChatDetail } from "./attention/ChatDetail.js";
import { PROJECT } from "./attention/common.js";
import { DeliveryDetail } from "./attention/DeliveryDetail.js";
import {
  ApprovalDetail,
  ClarificationDetail,
  type DetailProps,
  InitiativeDetail,
  RunDetail,
} from "./attention/RunDetails.js";

const DETAILS: Record<DetailKind, ComponentType<DetailProps>> = {
  approval: ApprovalDetail,
  clarification: ClarificationDetail,
  delivery: DeliveryDetail,
  "chat-approval": ChatDetail,
  "chat-question": ChatDetail,
  initiative: InitiativeDetail,
  run: RunDetail,
};

const MARK: Record<DetailKind, { mark: string; tone: string }> = {
  approval: { mark: "⚑", tone: "var(--warn)" },
  clarification: { mark: "?", tone: "var(--warn)" },
  delivery: { mark: "↗", tone: "var(--ok)" },
  "chat-approval": { mark: "⚑", tone: "var(--warn)" },
  "chat-question": { mark: "?", tone: "var(--warn)" },
  initiative: { mark: "⚐", tone: "var(--warn)" },
  run: { mark: "◎", tone: "var(--info)" },
};

const CHIP =
  "min-h-[26px] cursor-pointer rounded-[13px] border-2 border-border bg-raised px-[10px] py-0 text-muted-foreground [font-family:inherit] text-[12px] leading-[inherit] font-semibold aria-pressed:bg-main aria-pressed:text-foreground";

const itemHref = (item: AttentionItem): string =>
  href({ name: "attention", key: item.projectKey, id: attentionItemId(item) });

function Entry({ item, selected }: { item: AttentionItem; selected: boolean }) {
  const kind = detailKind(item);
  const source = sourceOf(item);
  const owner = source === "run" ? item.featureId : source === "chat" ? "chat" : "initiative";
  return (
    <a
      className={cn(
        ITEM,
        "no-underline aria-[current=true]:border-border aria-[current=true]:bg-hover aria-[current=true]:shadow-sm-hard",
      )}
      href={itemHref(item)}
      aria-current={selected ? "true" : undefined}
    >
      <span
        className="font-mono"
        style={{ color: item.blocking ? MARK[kind].tone : "var(--info)" }}
        aria-hidden="true"
      >
        {MARK[kind].mark}
      </span>
      <span className={STACK} style={{ gap: 2 }}>
        <span className="text-foreground">{attentionTitle(item)}</span>
        <span className="text-[12px] text-dim-foreground">
          <span className={PROJECT}>{item.projectName}</span> · {owner} · {kindLabel(item.kind)} ·{" "}
          {item.blocking ? ago(item.createdAt) : "run continues"}
        </span>
      </span>
    </a>
  );
}

export function AttentionScreen({ projectKey, itemId }: { projectKey?: string; itemId?: string }) {
  const { attention } = useDesktop();
  const [filter, setFilter] = useState<string | null>(null);
  /** What the last answer did; it stays while the route is the one the answer led to. */
  const [notice, setNotice] = useState<{ text: string; at: string; next?: string } | null>(null);
  const here = href(
    projectKey && itemId
      ? { name: "attention", key: projectKey, id: itemId }
      : { name: "attention" },
  );
  useEffect(
    () => setNotice((current) => (current && current.at !== here ? null : current)),
    [here],
  );
  const groups = groupAttention(attention, filter);
  const shown = [...groups.blocking, ...groups.advisory];
  const routed = findAttention(attention, projectKey, itemId);
  const selected = routed ?? (itemId ? undefined : shown[0]);
  const Detail = selected ? DETAILS[detailKind(selected)] : null;

  const done = (key: string) => (text: string, next?: string) => {
    const at = next ? href({ name: "attention", key, id: next }) : href({ name: "attention" });
    setNotice({ text, at, ...(next ? { next } : {}) });
    window.location.hash = at;
  };

  return (
    <div className="flex min-h-full min-w-0 flex-wrap">
      <section
        className="flex max-w-[480px] flex-[1_1_360px] flex-col gap-[10px] border-r-[3px] border-r-border px-5 py-[22px]"
        aria-label="Waiting items"
      >
        <h1 className="mx-0 mt-0 mb-1 text-[20px] font-semibold">Needs you</h1>
        <p className={LEDE}>
          Everything in every open project that waits for a person. Each item opens in its own
          project; new ones also arrive as system notifications.
        </p>
        {groups.projects.length > 0 && (
          <fieldset
            className="mx-0 mt-0 mb-1 flex min-w-0 flex-wrap gap-[6px] border-0 p-0"
            aria-label="Filter by project"
          >
            <button
              type="button"
              className={CHIP}
              aria-pressed={filter === null}
              onClick={() => setFilter(null)}
            >
              All · {groups.total}
            </button>
            {groups.projects.map((project) => (
              <button
                key={project.key}
                type="button"
                className={CHIP}
                aria-pressed={filter === project.key}
                onClick={() => setFilter(project.key)}
              >
                {project.name} · {project.count}
              </button>
            ))}
          </fieldset>
        )}
        {shown.length === 0 && <Empty>Nothing waits for you in the open projects.</Empty>}
        {groups.blocking.length > 0 && <p className={LABEL}>Blocking</p>}
        {groups.blocking.map((item) => (
          <Entry
            key={`${item.projectKey}:${attentionItemId(item)}`}
            item={item}
            selected={item === selected}
          />
        ))}
        {groups.advisory.length > 0 && (
          <p className={LABEL} style={{ marginTop: 10 }}>
            Advisory
          </p>
        )}
        {groups.advisory.map((item) => (
          <Entry
            key={`${item.projectKey}:${attentionItemId(item)}`}
            item={item}
            selected={item === selected}
          />
        ))}
      </section>
      <section
        className="flex min-w-0 max-w-[900px] flex-[999_1_480px] flex-col gap-4 px-7 py-[22px]"
        aria-label="Selected item"
        aria-live="polite"
      >
        {notice && (
          <Alert className="border-[color:var(--ok)]" role="status">
            {notice.text}
          </Alert>
        )}
        {selected && Detail ? (
          <Detail
            key={`${selected.projectKey}:${attentionItemId(selected)}`}
            item={selected}
            onDone={done(selected.projectKey)}
          />
        ) : itemId && !notice?.next ? (
          <p className="text-dim-foreground">This item was answered or is no longer waiting.</p>
        ) : !notice && shown.length > 0 ? (
          <p className="text-dim-foreground">Select an item.</p>
        ) : null}
      </section>
    </div>
  );
}
