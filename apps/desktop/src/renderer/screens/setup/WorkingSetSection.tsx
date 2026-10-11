import { type FormEvent, useState } from "react";
import { setup } from "../../client/setup.js";
import type { SectionProps } from "../sections.js";
import {
  kb,
  WORKING_SET_FILE_MAX_BYTES,
  WORKING_SET_MAX_BYTES,
  workingSetBudget,
} from "./logic.js";
import {
  ADD,
  errorText,
  FLUSH,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  ROW,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

const FIT_LABEL = {
  included: null,
  "too-large": `over ${kb(WORKING_SET_FILE_MAX_BYTES)}: listed by name`,
  "over-budget": "over budget: listed by name",
} as const;

export function WorkingSetSection({ project }: SectionProps) {
  const [summary, , setSummary] = useLoad(() => setup.project(project.key), [project.key]);
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (body: { add?: string[]; remove?: string[] }): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setSummary(await setup.changeWorkingSet(project.key, body));
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
    const value = entry.trim();
    if (value && (await change({ add: [value] }))) setEntry("");
  };

  if (summary.state !== "ready") return <LoadState value={summary} what="the working set" />;
  const set = summary.data.workingSet;
  const budget = workingSetBudget(set.files);
  const percent = Math.min(100, Math.round((budget.used / WORKING_SET_MAX_BYTES) * 100));

  return (
    <div className={SETUP}>
      <p className="lede">
        Files every chat and workflow agent of this project gets with its contents, stored in{" "}
        <span className="mono">baked/project.json</span>. A run captures them when it starts.
      </p>

      <section className="card flex flex-col gap-2" aria-label="Budget">
        <div className={ROW}>
          <span>
            <span className="mono">{set.files.length}</span> files ·{" "}
            <span className="mono">{kb(budget.total)}</span>
          </span>
          <span className="muted mono">
            {kb(budget.used)} of {kb(WORKING_SET_MAX_BYTES)} sent with contents
          </span>
        </div>
        <div className="h-[6px] overflow-hidden rounded-[3px] bg-hover" aria-hidden="true">
          <span className="block h-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
        </div>
        <span className={`muted ${NOTE}`}>
          Files over {kb(WORKING_SET_FILE_MAX_BYTES)}, and files past the budget, reach agents by
          name only.
        </span>
      </section>

      <form className={ADD} onSubmit={(e) => void add(e)}>
        <label htmlFor="ws-entry" className="sr-only">
          Path or glob
        </label>
        <input
          id="ws-entry"
          type="text"
          className="mono"
          placeholder="src/core/api/*.ts or docs/guide.md"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn-primary" disabled={busy || !entry.trim()}>
          Add
        </button>
      </form>
      {error && <div className="banner error">{error}</div>}

      <section aria-label="Entries" className={STACK}>
        <h2 className="label">Entries</h2>
        {set.entries.length === 0 ? (
          <div className="empty">No entries yet. Add a file, a folder or a glob.</div>
        ) : (
          <ul className={`card ${LIST}`}>
            {set.entries.map((e) => (
              <li key={e} className={LINE}>
                <span className={`mono ${GROW}`}>{e}</span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void change({ remove: [e] })}
                  aria-label={`Remove ${e}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {set.files.length > 0 && (
        <section aria-label="Files" className={STACK}>
          <h2 className="label">Files</h2>
          <div className={`card ${FLUSH}`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Size</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {set.files.map((file, i) => {
                  const fit = budget.fit[i] ?? "included";
                  return (
                    <tr key={file.path}>
                      <td className={`mono ${WRAP}`}>{file.path}</td>
                      <td className="mono">{kb(file.bytes)}</td>
                      <td>
                        {fit === "included" ? (
                          <span className="muted">contents</span>
                        ) : (
                          <Tag tone="warn">{FIT_LABEL[fit]}</Tag>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {set.skipped.length > 0 && (
        <section aria-label="Skipped" className={STACK}>
          <h2 className="label">Left out</h2>
          <ul className={`card ${LIST}`}>
            {set.skipped.map((s) => (
              <li key={`${s.path}:${s.reason}`} className={LINE}>
                <span className={`mono ${GROW} ${WRAP}`}>{s.path}</span>
                <span className="muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
