import { type FormEvent, useState } from "react";
import { setup } from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL, TABLE } from "../../lib/styles.js";
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

/** The Files tab of the Agent context screen: the working set's entries and the files they match. */
export function WorkingSetPane({ project }: Pick<SectionProps, "project">) {
  const [summary, , setSummary] = useLoad(
    () => setup.project(project.key),
    [project.key, "project"],
  );
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

  return (
    <div className={SETUP}>
      <p className={LEDE}>
        Files agents get with their contents, stored in{" "}
        <span className="font-mono">baked/project.json</span>. Files over{" "}
        {kb(WORKING_SET_FILE_MAX_BYTES)}, and files past the {kb(WORKING_SET_MAX_BYTES)} budget,
        reach agents by name only.
      </p>

      <form className={ADD} onSubmit={(e) => void add(e)}>
        <label htmlFor="ws-entry" className="sr-only">
          Path or glob
        </label>
        <input
          id="ws-entry"
          type="text"
          placeholder="src/core/api/*.ts or docs/guide.md"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          disabled={busy}
        />
        <Button type="submit" variant="primary" size="md" disabled={busy || !entry.trim()}>
          Add
        </Button>
      </form>
      {error && <Alert tone="error">{error}</Alert>}

      <section aria-label="Entries" className={STACK}>
        <h2 className={LABEL}>Entries</h2>
        {set.entries.length === 0 ? (
          <Empty>No entries yet. Add a file, a folder or a glob.</Empty>
        ) : (
          <ul className={cn(PANEL, LIST)}>
            {set.entries.map((e) => (
              <li key={e} className={LINE}>
                <span className={`font-mono ${GROW}`}>{e}</span>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={busy}
                  onClick={() => void change({ remove: [e] })}
                  aria-label={`Remove ${e}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {set.files.length > 0 && (
        <section aria-label="Files" className={STACK}>
          <h2 className={LABEL}>
            Files · {set.files.length} · {kb(budget.total)}
          </h2>
          <div className={cn(PANEL, FLUSH)}>
            <table className={TABLE}>
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
                      <td className={`font-mono ${WRAP}`}>{file.path}</td>
                      <td className="font-mono">{kb(file.bytes)}</td>
                      <td>
                        {fit === "included" ? (
                          <span className="text-dim-foreground">contents</span>
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
          <h2 className={LABEL}>Left out</h2>
          <ul className={cn(PANEL, LIST)}>
            {set.skipped.map((s) => (
              <li key={`${s.path}:${s.reason}`} className={LINE}>
                <span className={`font-mono ${GROW} ${WRAP}`}>{s.path}</span>
                <span className="text-dim-foreground">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
