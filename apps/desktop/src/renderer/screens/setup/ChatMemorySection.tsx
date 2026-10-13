import { type FormEvent, useMemo, useState } from "react";
import {
  type ChatMemoryCategory,
  type ChatMemoryCleanupAction,
  type ChatMemoryCleanupCandidate,
  type ChatMemoryEdit,
  type ChatMemoryEntry,
  type ChatMemorySettings,
  type ChatMemoryView,
  setup,
} from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { ago } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  ADD,
  errorText,
  FL,
  FORM,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

type Option<T extends string> = [T, string];

const WRITE_SCOPES: Option<ChatMemorySettings["writeScope"]>[] = [
  ["project", "Project"],
  ["global", "Global"],
  ["none", "None"],
];
const READ_SCOPES: Option<ChatMemorySettings["readScope"]>[] = [
  ["all", "All"],
  ["project", "Project"],
  ["global", "Global"],
  ["none", "None"],
];
const SETTINGS_SCOPES: Option<ChatMemorySettings["settingsScope"]>[] = [
  ["project", "This project"],
  ["global", "All projects"],
];
const CATEGORIES: Option<ChatMemoryCategory | "">[] = [
  ["", "No category"],
  ["pref", "Preference"],
  ["decision", "Decision"],
  ["gotcha", "Gotcha"],
  ["context", "Context"],
];
const KIND_LABEL: Record<ChatMemoryCleanupCandidate["kind"], string> = {
  duplicate: "duplicate",
  dead: "files gone",
  stale: "unused",
  similar: "similar",
};

const keyOf = (e: { scope: string; id: string }) => `${e.scope}:${e.id}`;

function Choice<T extends string>({
  label,
  about,
  options,
  value,
  busy,
  onPick,
}: {
  label: string;
  about: string;
  options: Option<T>[];
  value: T;
  busy: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div className={STACK}>
      <span className={LABEL}>{label}</span>
      <SegmentGroup aria-label={label} disabled={busy}>
        {options.map(([v, text]) => (
          <Segment key={v} aria-pressed={v === value} onClick={() => v !== value && onPick(v)}>
            {text}
          </Segment>
        ))}
      </SegmentGroup>
      <span className={cn("text-dim-foreground", NOTE)}>{about}</span>
    </div>
  );
}

function EntryLine({
  entry,
  busy,
  onEdit,
}: {
  entry: ChatMemoryEntry;
  busy: boolean;
  onEdit: (edit: ChatMemoryEdit) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{
    summary: string;
    details: string;
    category: ChatMemoryCategory | "";
  } | null>(null);
  const target = { scope: entry.scope, id: entry.id };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!draft?.summary.trim()) return;
    const saved = await onEdit({
      action: "edit",
      ...target,
      summary: draft.summary.trim(),
      details: draft.details,
      category: draft.category || null,
    });
    if (saved) setDraft(null);
  };
  const field = `chat-mem-${entry.id}`;
  if (draft)
    return (
      <li className={LINE}>
        <form className={cn(FORM, GROW)} onSubmit={(e) => void save(e)}>
          <div className={FL}>
            <label htmlFor={`${field}-summary`}>Summary</label>
            <input
              id={`${field}-summary`}
              type="text"
              value={draft.summary}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              disabled={busy}
            />
          </div>
          <div className={FL}>
            <label htmlFor={`${field}-details`}>Details</label>
            <Textarea
              id={`${field}-details`}
              value={draft.details}
              maxLength={20_000}
              onChange={(e) => setDraft({ ...draft, details: e.target.value })}
              disabled={busy}
            />
          </div>
          <div className={FL}>
            <label htmlFor={`${field}-category`}>Category</label>
            <select
              id={`${field}-category`}
              value={draft.category}
              onChange={(e) =>
                setDraft({ ...draft, category: e.target.value as ChatMemoryCategory | "" })
              }
              disabled={busy}
            >
              {CATEGORIES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </div>
          <span className={ACTIONS}>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={busy || !draft.summary.trim()}
            >
              Save
            </Button>
            <Button variant="secondary" size="md" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </span>
        </form>
      </li>
    );
  return (
    <li className={LINE}>
      <span className={cn(GROW, WRAP, STACK, "gap-1")}>
        <span className="text-foreground">
          {entry.pinned && (
            <span role="img" aria-label="Pinned" className="mr-1">
              ★
            </span>
          )}
          {entry.summary}
        </span>
        {entry.details && (
          <span className={cn("text-dim-foreground", NOTE, "whitespace-pre-wrap")}>
            {entry.details}
          </span>
        )}
        <span className={cn("font-mono text-dim-foreground", NOTE)}>
          used {entry.useCount}× · last {ago(Date.parse(entry.lastUsedAt))} · saved by{" "}
          {entry.source === "user" ? "you" : "the agent"}
          {entry.topics.length > 0 && ` · ${entry.topics.join(", ")}`}
        </span>
      </span>
      <Tag>{entry.scope}</Tag>
      {entry.category && <Tag>{entry.category}</Tag>}
      <span className={ACTIONS}>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => void onEdit({ action: entry.pinned ? "unpin" : "pin", ...target })}
        >
          {entry.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() =>
            setDraft({
              summary: entry.summary,
              details: entry.details,
              category: entry.category ?? "",
            })
          }
        >
          Edit
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => void onEdit({ action: "hide", ...target })}
          aria-label={`Hide ${entry.summary}`}
        >
          Hide
        </Button>
      </span>
    </li>
  );
}

function Cleanup({
  projectKey,
  busy,
  run,
}: {
  projectKey: string;
  busy: boolean;
  run: (work: () => Promise<ChatMemoryView>) => Promise<boolean>;
}) {
  const [candidates, setCandidates] = useState<ChatMemoryCleanupCandidate[] | null>(null);
  const [choice, setChoice] = useState<Map<string, ChatMemoryCleanupAction["action"]>>(new Map());
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const find = async (): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      const found = (await setup.chatMemoryCleanup(projectKey)).candidates;
      setCandidates(found);
      // Suggestions start as "hide", as the terminal's cleanup tab does on a first keypress.
      setChoice(new Map(found.map((c) => [keyOf(c), "hide"])));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const apply = async (): Promise<void> => {
    if (!candidates) return;
    const actions = candidates.flatMap((c): ChatMemoryCleanupAction[] => {
      const action = choice.get(keyOf(c));
      return action ? [{ scope: c.scope, id: c.id, action }] : [];
    });
    let summary = "";
    const ok = await run(async () => {
      const result = await setup.applyChatMemoryCleanup(projectKey, actions);
      summary = `Cleanup done: ${result.applied.hidden} hidden, ${result.applied.pinned} pinned.`;
      return result;
    });
    if (ok) {
      setCandidates(null);
      setDone(summary);
    }
  };
  const pick = (c: ChatMemoryCleanupCandidate, action: ChatMemoryCleanupAction["action"] | null) =>
    setChoice((prev) => {
      const next = new Map(prev);
      if (action) next.set(keyOf(c), action);
      else next.delete(keyOf(c));
      return next;
    });

  return (
    <section aria-label="Cleanup" className={STACK}>
      <h2 className={LABEL}>Cleanup</h2>
      <span className={cn("text-dim-foreground", NOTE)}>
        Finds duplicates, memories whose files are gone, long-unused ones and near-duplicates.
        Hidden memories stay restorable.
      </span>
      {error && <Alert tone="error">{error}</Alert>}
      {done && <Alert>{done}</Alert>}
      {candidates === null ? (
        <span className={ACTIONS}>
          <Button variant="secondary" size="md" disabled={busy} onClick={() => void find()}>
            Find suggestions
          </Button>
        </span>
      ) : candidates.length === 0 ? (
        <Empty>Nothing to clean up.</Empty>
      ) : (
        <>
          <ul className={cn(PANEL, LIST, "p-0")}>
            {candidates.map((c) => {
              const current = choice.get(keyOf(c)) ?? null;
              return (
                <li key={keyOf(c)} className={LINE}>
                  <span className={cn(GROW, WRAP)}>{c.summary}</span>
                  <Tag tone="warn">{KIND_LABEL[c.kind]}</Tag>
                  <span className={cn("font-mono text-dim-foreground", NOTE)}>{c.detail}</span>
                  <SegmentGroup aria-label={`What to do with ${c.summary}`} disabled={busy}>
                    {(
                      [
                        ["hide", "Hide"],
                        ["pin", "Pin"],
                        [null, "Skip"],
                      ] as const
                    ).map(([action, text]) => (
                      <Segment
                        key={text}
                        aria-pressed={current === action}
                        onClick={() => pick(c, action)}
                      >
                        {text}
                      </Segment>
                    ))}
                  </SegmentGroup>
                </li>
              );
            })}
          </ul>
          <span className={ACTIONS}>
            <Button variant="primary" size="md" disabled={busy} onClick={() => void apply()}>
              Apply
            </Button>
            <Button variant="secondary" size="md" onClick={() => setCandidates(null)}>
              Cancel
            </Button>
          </span>
        </>
      )}
    </section>
  );
}

export function ChatMemorySection({ project }: SectionProps) {
  const [memory, , setMemory] = useLoad(
    () => setup.chatMemory(project.key),
    [project.key, "chatMemory"],
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const run = async (work: () => Promise<ChatMemoryView>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setMemory(await work());
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit = (change: ChatMemoryEdit) => run(() => setup.editChatMemory(project.key, change));
  const settings = (change: Partial<ChatMemorySettings>) =>
    run(() => setup.chatMemorySettings(project.key, change));

  const view = memory.state === "ready" ? memory.data : null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!view || !q) return view?.entries ?? [];
    return view.entries.filter((e) =>
      `${e.summary} ${e.details} ${e.category ?? ""} ${e.scope} ${e.topics.join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }, [view, query]);

  if (!view) return <LoadState value={memory} what="chat memory" />;
  const { writeScope, readScope, shareWithRuns, settingsScope } = view.settings;
  const total = view.entries.length + view.hidden.length;

  return (
    <div className={SETUP}>
      <p className={LEDE}>
        What the chat agent remembers across sessions: your preferences, decisions and gotchas it
        saved, in this project and for all projects. Chat in the terminal and here share it. The
        memory of workflow runs is in the Runs part.
      </p>
      {writeScope === "none" && readScope === "none" && (
        <Alert>Chat memory is off: the agent neither saves nor recalls memories.</Alert>
      )}
      {view.cleanupHint && (
        <Alert>
          {view.cleanupHint.sessions} sessions since the last cleanup and {view.cleanupHint.stale}{" "}
          stale memories: a cleanup below would help recall.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <section aria-label="Settings" className={cn(PANEL, STACK, "gap-4")}>
        <Choice
          label="Save new memories to"
          about="None stops the agent from saving memories."
          options={WRITE_SCOPES}
          value={writeScope}
          busy={busy}
          onPick={(v) => void settings({ writeScope: v })}
        />
        <Choice
          label="Recall memories from"
          about="None turns recall off; saved memories stay."
          options={READ_SCOPES}
          value={readScope}
          busy={busy}
          onPick={(v) => void settings({ readScope: v })}
        />
        <div className={STACK}>
          <span className={LABEL}>Share with runs</span>
          <span className="flex items-center gap-2 text-[13px]">
            <Switch
              aria-label="Share memory between chats and runs"
              checked={shareWithRuns}
              disabled={busy}
              onCheckedChange={(checked) => void settings({ shareWithRuns: checked })}
            />
            {shareWithRuns ? "On" : "Off"}
          </span>
          <span className={cn("text-dim-foreground", NOTE)}>
            When on, chats also recall what runs learned (answers, approved assumptions, active
            rules), and new runs read up to 10 of this project's pinned memories and decisions,
            preferences and gotchas. Global, hidden and context memories stay in the chat.
          </span>
        </div>
        <Choice
          label="Keep these settings for"
          about="This project saves them in .baked; all projects in your BAKED folder."
          options={SETTINGS_SCOPES}
          value={settingsScope}
          busy={busy}
          onPick={(v) => void settings({ settingsScope: v })}
        />
      </section>

      <section aria-label="Memories" className={STACK}>
        <h2 className={LABEL}>Memories</h2>
        {view.entries.length > 0 && (
          <div className={ADD}>
            <label htmlFor="chat-mem-search" className="sr-only">
              Search memories
            </label>
            <input
              id="chat-mem-search"
              type="text"
              placeholder="Search summaries, details and topics"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {view.entries.length === 0 ? (
          <Empty>
            Nothing yet. The agent saves what you ask it to remember and what it learns about the
            project.
          </Empty>
        ) : shown.length === 0 ? (
          <Empty>No memory matches.</Empty>
        ) : (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {shown.map((e) => (
              <EntryLine key={keyOf(e)} entry={e} busy={busy} onEdit={edit} />
            ))}
          </ul>
        )}
      </section>

      {view.hidden.length > 0 && (
        <section aria-label="Hidden" className={STACK}>
          <h2 className={LABEL}>Hidden</h2>
          <ul className={cn(PANEL, LIST, "p-0")}>
            {view.hidden.map((e) => (
              <li key={keyOf(e)} className={LINE}>
                <span className={cn(GROW, WRAP, "text-dim-foreground")}>{e.summary}</span>
                <Tag>{e.scope}</Tag>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={busy}
                  onClick={() => void edit({ action: "restore", scope: e.scope, id: e.id })}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.entries.length > 0 && <Cleanup projectKey={project.key} busy={busy} run={run} />}

      {total > 0 && (
        <section aria-label="Delete all" className={STACK}>
          <h2 className={LABEL}>Delete all</h2>
          <span className={cn("text-dim-foreground", NOTE)}>
            Deletes every memory of this project and every global one, hidden ones included. This
            cannot be undone.
          </span>
          <span className={ACTIONS}>
            {confirmPurge ? (
              <>
                <Button
                  variant="danger"
                  size="md"
                  disabled={busy}
                  onClick={() =>
                    void edit({ action: "purge", scope: "all" }).then(() => setConfirmPurge(false))
                  }
                >
                  Delete {total} memories
                </Button>
                <Button variant="secondary" size="md" onClick={() => setConfirmPurge(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => setConfirmPurge(true)}
              >
                Delete all memories…
              </Button>
            )}
          </span>
        </section>
      )}
    </div>
  );
}
