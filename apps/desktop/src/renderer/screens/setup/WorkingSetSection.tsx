import { type FormEvent, useState } from "react";
import { setup } from "../../client/setup.js";
import "../../styles/setup.css";
import type { SectionProps } from "../sections.js";
import {
  kb,
  WORKING_SET_FILE_MAX_BYTES,
  WORKING_SET_MAX_BYTES,
  workingSetBudget,
} from "./logic.js";
import { errorText, LoadState, Tag, useLoad } from "./shared.js";

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
    <div className="setup">
      <p className="lede">
        Files every chat and workflow agent of this project gets with its contents, stored in{" "}
        <span className="mono">baked/project.json</span>. A run captures them when it starts.
      </p>

      <section className="card setup-budget" aria-label="Budget">
        <div className="setup-row">
          <span>
            <span className="mono">{set.files.length}</span> files ·{" "}
            <span className="mono">{kb(budget.total)}</span>
          </span>
          <span className="muted mono">
            {kb(budget.used)} of {kb(WORKING_SET_MAX_BYTES)} sent with contents
          </span>
        </div>
        <div className="setup-meter" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className="muted setup-note">
          Files over {kb(WORKING_SET_FILE_MAX_BYTES)}, and files past the budget, reach agents by
          name only.
        </span>
      </section>

      <form className="setup-add" onSubmit={(e) => void add(e)}>
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

      <section aria-label="Entries" className="setup-section">
        <h2 className="label">Entries</h2>
        {set.entries.length === 0 ? (
          <div className="empty">No entries yet. Add a file, a folder or a glob.</div>
        ) : (
          <ul className="card setup-list">
            {set.entries.map((e) => (
              <li key={e} className="setup-line">
                <span className="mono setup-grow">{e}</span>
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
        <section aria-label="Files" className="setup-section">
          <h2 className="label">Files</h2>
          <div className="card setup-flush">
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
                      <td className="mono setup-wrap">{file.path}</td>
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
        <section aria-label="Skipped" className="setup-section">
          <h2 className="label">Left out</h2>
          <ul className="card setup-list">
            {set.skipped.map((s) => (
              <li key={`${s.path}:${s.reason}`} className="setup-line">
                <span className="mono setup-grow setup-wrap">{s.path}</span>
                <span className="muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
