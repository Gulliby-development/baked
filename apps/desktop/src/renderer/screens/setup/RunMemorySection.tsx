import { type FormEvent, useState } from "react";
import {
  type MemoryEntry,
  type MemoryEntryKind,
  type RunMemoryEdit,
  setup,
} from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  ADD,
  errorText,
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

const GROUPS: [MemoryEntryKind, string, string][] = [
  ["note", "Notes", "Your own notes. Every new run's research, spec and plan read them."],
  ["answer", "Answers", "Answers people gave to research and spec questions; the newest wins."],
  ["assumption", "Assumptions", "Assumptions of specifications that completed runs approved."],
  ["check", "Checks", "Check commands that passed in completed runs."],
];

const NOTE_MAX = 600;

function EntryLine({
  entry,
  sent,
  busy,
  onEdit,
}: {
  entry: MemoryEntry;
  sent: boolean;
  busy: boolean;
  onEdit: (edit: RunMemoryEdit) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = draft?.trim();
    if (text && (await onEdit({ action: "edit", id: entry.id, text }))) setDraft(null);
  };
  return (
    <li className={LINE}>
      {draft === null ? (
        <span className={cn(GROW, WRAP)}>
          {entry.question && <span className="text-dim-foreground">Q: {entry.question} · A: </span>}
          <span className={entry.kind === "check" ? "font-mono" : undefined}>{entry.text}</span>
          {entry.recorded && (
            <span className={cn("text-dim-foreground", NOTE)}>
              {" "}
              Runs recorded: {entry.recorded}
            </span>
          )}
        </span>
      ) : (
        <form className={cn(ADD, GROW)} onSubmit={(e) => void save(e)}>
          <label htmlFor={`mem-${entry.id}`} className="sr-only">
            New text
          </label>
          <input
            id={`mem-${entry.id}`}
            type="text"
            value={draft}
            maxLength={NOTE_MAX}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || !draft.trim()}>
            Save
          </Button>
          <Button variant="secondary" size="md" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </form>
      )}
      {entry.runId && (
        <span className="font-mono text-dim-foreground">run {entry.runId.slice(0, 8)}</span>
      )}
      {entry.runs !== undefined && (
        <span className="font-mono text-dim-foreground">{entry.runs}×</span>
      )}
      {entry.recorded && <Tag>edited</Tag>}
      {!sent && <Tag tone="warn">not sent: the policy lists it</Tag>}
      {draft === null && (
        <span className={ACTIONS}>
          {entry.kind !== "check" && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => setDraft(entry.text)}
            >
              Edit
            </Button>
          )}
          {entry.recorded && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => void onEdit({ action: "restore", id: entry.id })}
            >
              Restore
            </Button>
          )}
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => void onEdit({ action: "forget", id: entry.id })}
            aria-label={`${entry.kind === "note" ? "Delete" : "Forget"} ${entry.text}`}
          >
            {entry.kind === "note" ? "Delete" : "Forget"}
          </Button>
        </span>
      )}
    </li>
  );
}

export function RunMemorySection({ project }: SectionProps) {
  const [memory, , setMemory] = useLoad(
    () => setup.runMemory(project.key),
    [project.key, "runMemory"],
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (edit: RunMemoryEdit): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setMemory(await setup.editRunMemory(project.key, edit));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = note.trim();
    if (text && (await change({ action: "add", text }))) setNote("");
  };

  if (memory.state !== "ready") return <LoadState value={memory} what="run memory" />;
  const view = memory.data;

  return (
    <div className={SETUP}>
      <p className={LEDE}>
        What earlier workflow runs of this project learned, and notes of your own. A run reads it
        when it starts; changes apply to runs started afterwards, and started runs keep their copy.
      </p>
      {!view.enabled && (
        <Alert>
          Run memory is off for new runs: the workflow policy sets{" "}
          <span className="font-mono">projectMemory: false</span>.
        </Alert>
      )}

      <form className={ADD} onSubmit={(e) => void add(e)}>
        <label htmlFor="mem-note" className="sr-only">
          New note
        </label>
        <input
          id="mem-note"
          type="text"
          placeholder="A note every new run reads, e.g. Public APIs keep their names"
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        <Button type="submit" variant="primary" size="md" disabled={busy || !note.trim()}>
          Add note
        </Button>
      </form>
      {error && <Alert tone="error">{error}</Alert>}

      {view.entries.length === 0 && (
        <Empty>
          Nothing yet. Runs record the answers you give, the assumptions you approve and the checks
          that pass.
        </Empty>
      )}
      {GROUPS.map(([kind, label, about]) => {
        const entries = view.entries.filter((e) => e.kind === kind);
        if (!entries.length) return null;
        return (
          <section key={kind} aria-label={label} className={STACK}>
            <h2 className={LABEL}>{label}</h2>
            <span className={cn("text-dim-foreground", NOTE)}>{about}</span>
            <ul className={cn(PANEL, LIST, "p-0")}>
              {entries.map((e) => (
                <EntryLine key={e.id} entry={e} sent={e.sent} busy={busy} onEdit={change} />
              ))}
            </ul>
          </section>
        );
      })}

      {view.hidden.length > 0 && (
        <section aria-label="Forgotten" className={STACK}>
          <h2 className={LABEL}>Forgotten</h2>
          <ul className={cn(PANEL, LIST, "p-0")}>
            {view.hidden.map((e) => (
              <li key={e.id} className={LINE}>
                <span className={cn(GROW, WRAP, "text-dim-foreground")}>
                  {e.question ? `Q: ${e.question} · A: ` : ""}
                  {e.text}
                </span>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={busy}
                  onClick={() => void change({ action: "restore", id: e.id })}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.rendered && (
        <details className={STACK}>
          <summary className={LABEL}>What the next run reads</summary>
          <pre className={cn(PANEL, "font-mono", WRAP)}>{view.rendered}</pre>
        </details>
      )}
    </div>
  );
}
