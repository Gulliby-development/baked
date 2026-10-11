import { type FormEvent, useState } from "react";
import {
  type MemoryEntry,
  type MemoryEntryKind,
  type RunMemoryEdit,
  setup,
} from "../../client/setup.js";
import "../../styles/setup.css";
import type { SectionProps } from "../sections.js";
import { errorText, LoadState, Tag, useLoad } from "./shared.js";

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
    <li className="setup-line">
      {draft === null ? (
        <span className="setup-grow setup-wrap">
          {entry.question && <span className="muted">Q: {entry.question} · A: </span>}
          <span className={entry.kind === "check" ? "mono" : undefined}>{entry.text}</span>
          {entry.recorded && (
            <span className="muted setup-note"> Runs recorded: {entry.recorded}</span>
          )}
        </span>
      ) : (
        <form className="setup-add setup-grow" onSubmit={(e) => void save(e)}>
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
          <button type="submit" className="btn-primary" disabled={busy || !draft.trim()}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </form>
      )}
      {entry.runId && <span className="muted mono">run {entry.runId.slice(0, 8)}</span>}
      {entry.runs !== undefined && <span className="muted mono">{entry.runs}×</span>}
      {entry.recorded && <Tag>edited</Tag>}
      {!sent && <Tag tone="warn">not sent: the policy lists it</Tag>}
      {draft === null && (
        <span className="setup-actions">
          {entry.kind !== "check" && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setDraft(entry.text)}
            >
              Edit
            </button>
          )}
          {entry.recorded && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void onEdit({ action: "restore", id: entry.id })}
            >
              Restore
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void onEdit({ action: "forget", id: entry.id })}
            aria-label={`${entry.kind === "note" ? "Delete" : "Forget"} ${entry.text}`}
          >
            {entry.kind === "note" ? "Delete" : "Forget"}
          </button>
        </span>
      )}
    </li>
  );
}

export function RunMemorySection({ project }: SectionProps) {
  const [memory, , setMemory] = useLoad(() => setup.runMemory(project.key), [project.key]);
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
    <div className="setup">
      <p className="lede">
        What earlier workflow runs of this project learned, and notes of your own. A run reads it
        when it starts; changes apply to runs started afterwards, and started runs keep their copy.
      </p>
      {!view.enabled && (
        <div className="banner">
          Run memory is off for new runs: the workflow policy sets{" "}
          <span className="mono">projectMemory: false</span>.
        </div>
      )}

      <form className="setup-add" onSubmit={(e) => void add(e)}>
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
        <button type="submit" className="btn-primary" disabled={busy || !note.trim()}>
          Add note
        </button>
      </form>
      {error && <div className="banner error">{error}</div>}

      {view.entries.length === 0 && (
        <div className="empty">
          Nothing yet. Runs record the answers you give, the assumptions you approve and the checks
          that pass.
        </div>
      )}
      {GROUPS.map(([kind, label, about]) => {
        const entries = view.entries.filter((e) => e.kind === kind);
        if (!entries.length) return null;
        return (
          <section key={kind} aria-label={label} className="setup-section">
            <h2 className="label">{label}</h2>
            <span className="muted setup-note">{about}</span>
            <ul className="card setup-list">
              {entries.map((e) => (
                <EntryLine key={e.id} entry={e} sent={e.sent} busy={busy} onEdit={change} />
              ))}
            </ul>
          </section>
        );
      })}

      {view.hidden.length > 0 && (
        <section aria-label="Forgotten" className="setup-section">
          <h2 className="label">Forgotten</h2>
          <ul className="card setup-list">
            {view.hidden.map((e) => (
              <li key={e.id} className="setup-line">
                <span className="setup-grow setup-wrap muted">
                  {e.question ? `Q: ${e.question} · A: ` : ""}
                  {e.text}
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void change({ action: "restore", id: e.id })}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.rendered && (
        <details className="setup-section">
          <summary className="label">What the next run reads</summary>
          <pre className="card mono setup-wrap">{view.rendered}</pre>
        </details>
      )}
    </div>
  );
}
