import { type ChangeEvent, useState } from "react";
import { ApiError } from "../../client/api.js";
import {
  type Check,
  type CheckList,
  type CheckRunResult,
  type CheckSuggestion,
  type ConfigView,
  type GateEntry,
  isMissingEndpoint,
  setup,
} from "../../client/setup.js";
import { ago } from "../../format.js";
import "../../styles/setup.css";
import type { SectionProps } from "../sections.js";
import {
  type CheckDraft,
  checkDraft,
  checkResultText,
  checkScope,
  draftToCheck,
  effectiveChecks,
  gateMark,
  gateOrigin,
  joinCommand,
  plainCheck,
  upsertCheck,
  workflowsWithChecks,
} from "./logic.js";
import { errorText, LoadState, Tag, useLoad } from "./shared.js";

const TYPE_LABEL: Record<GateEntry["type"], string> = {
  command: "command",
  human: "human",
  "ai-review": "AI review",
  "ai-acceptance": "AI acceptance",
};

/** An on-demand run of one check from this screen. */
type CheckRun =
  | { kind: "running" }
  | { kind: "done"; result: CheckRunResult }
  | { kind: "error"; message: string };

function runError(error: unknown, id: string): string {
  if (error instanceof ApiError && error.code === "WORKSPACE_BUSY")
    return "A workflow run holds the workspace. Run the check again when that run finishes or pauses.";
  if (isMissingEndpoint(error)) return `The backend has no check ${id}; save it first.`;
  return errorText(error);
}

function GateRow({
  gate,
  config,
  result,
  selected,
  onSelect,
}: {
  gate: GateEntry;
  config: ConfigView | null;
  result: CheckRunResult | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const m = gateMark(gate, result);
  return (
    <li>
      <button type="button" className="setup-gate" aria-pressed={selected} onClick={onSelect}>
        <span className={`mono setup-mark ${m.tone}`} role="img" aria-label={m.label}>
          {m.text}
        </span>
        <span className="mono setup-gate-id">{gate.id}</span>
        <Tag>{TYPE_LABEL[gate.type]}</Tag>
        <Tag>{gate.required ? "required" : "advisory"}</Tag>
        <Tag>{gate.scope}</Tag>
        <Tag>{gateOrigin(gate, config)}</Tag>
        <span className="mono muted setup-push">
          {gate.source === "project" && gate.confirmed === false
            ? "not confirmed"
            : result
              ? checkResultText(result)
              : gate.source === "policy"
                ? "not run here"
                : ""}
        </span>
      </button>
    </li>
  );
}

function Suggestions({
  suggestions,
  existing,
  onAdd,
  busy,
}: {
  suggestions: CheckSuggestion[];
  existing: Set<string>;
  onAdd: (checks: Check[]) => void;
  busy: boolean;
}) {
  const fresh = suggestions.filter((s) => !existing.has(s.check.id));
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(fresh.filter((s) => s.preselected).map((s) => s.check.id)),
  );
  if (fresh.length === 0) return null;
  const chosen = fresh.filter((s) => picked.has(s.check.id));
  const sources = [...new Set(fresh.map((s) => s.source.split(" ")[0] ?? s.source))];
  return (
    <section className="card setup-callout" aria-label="Detected checks">
      <div className="setup-row">
        <span className="setup-grow">
          Detected in <span className="mono">{sources.join(", ")}</span>:{" "}
          {fresh.map((s, i) => (
            <span key={s.check.id}>
              {i > 0 && (i === fresh.length - 1 ? " and " : ", ")}
              <span className="mono">{s.reason}</span>
            </span>
          ))}
        </span>
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Review and add
        </button>
      </div>
      {open && (
        <div className="setup-stack">
          {fresh.map((s) => (
            <label key={s.check.id} className="check">
              <input
                type="checkbox"
                checked={picked.has(s.check.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(s.check.id);
                  else next.delete(s.check.id);
                  setPicked(next);
                }}
              />
              <span className="mono">{s.check.id}</span>
              <span className="mono muted">{joinCommand(s.check.executable, s.check.args)}</span>
              <span className="muted">
                {s.check.required ? "required" : "advisory"} · {s.source}
              </span>
            </label>
          ))}
          <div>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || chosen.length === 0}
              onClick={() => onAdd(chosen.map((s) => s.check))}
            >
              Add {chosen.length} to this checkout
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The latest result of a check: from this screen's run, or the backend's `lastResult`. */
function RunResult({ run, last }: { run: CheckRun | undefined; last: CheckRunResult | null }) {
  if (run?.kind === "running") return <span className="muted setup-note">Running…</span>;
  if (run?.kind === "error") return <div className="banner error">{run.message}</div>;
  const result = run?.kind === "done" ? run.result : last;
  if (!result) return null;
  const tone = result.status === "passed" ? "ok" : result.status === "cancelled" ? "" : "err";
  return (
    <section className="setup-stack" aria-label="Last result">
      <span className="setup-note">
        <span className={`mono setup-result ${tone}`}>{checkResultText(result)}</span>
        <span className="muted"> · {ago(result.at)}</span>
      </span>
      {result.outputTail && <pre className="setup-output mono">{result.outputTail}</pre>}
      {result.truncated && (
        <span className="muted setup-note">Only the last lines of the output are kept.</span>
      )}
    </section>
  );
}

function CheckForm({
  initial,
  isNew,
  scopeNote,
  busy,
  onSave,
  onDelete,
  onRun,
  canRun,
  run,
  last,
}: {
  initial: Check | null;
  isNew: boolean;
  scopeNote: string;
  busy: boolean;
  onSave: (draft: CheckDraft) => void;
  onDelete: () => void;
  onRun: () => void;
  canRun: boolean;
  run: CheckRun | undefined;
  last: CheckRunResult | null;
}) {
  const [draft, setDraft] = useState(() => checkDraft(initial));
  const set = <K extends keyof CheckDraft>(key: K, value: CheckDraft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));
  const field = (key: "id" | "command" | "cwd" | "timeoutSeconds" | "envNames" | "writes") => ({
    id: `check-${key}`,
    type: "text" as const,
    className: "mono",
    value: draft[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  return (
    <form
      className="card setup-form"
      aria-label={isNew ? "New check" : `Edit ${initial?.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <div className="setup-row">
        <h2 className="setup-h">{isNew ? "New check" : initial?.id}</h2>
        <Tag>command</Tag>
        <span className="muted setup-push setup-note">{scopeNote}</span>
      </div>
      <div className="setup-fl">
        <label htmlFor="check-id">ID</label>
        <input {...field("id")} />
      </div>
      <div className="setup-fl">
        <label htmlFor="check-command">Command</label>
        <input {...field("command")} placeholder="bun run typecheck" />
      </div>
      <div className="setup-pair">
        <div className="setup-fl">
          <label htmlFor="check-cwd">Directory</label>
          <input {...field("cwd")} />
        </div>
        <div className="setup-fl">
          <label htmlFor="check-timeoutSeconds">Timeout, s</label>
          <input {...field("timeoutSeconds")} inputMode="numeric" />
        </div>
      </div>
      <div className="setup-pair">
        <div className="setup-fl">
          <span id="check-required">Required</span>
          <fieldset className="seg-group" aria-labelledby="check-required">
            {([true, false] as const).map((required) => (
              <button
                key={String(required)}
                type="button"
                className="seg"
                aria-pressed={draft.required === required}
                onClick={() => set("required", required)}
              >
                {required ? "required" : "advisory"}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="setup-fl">
          <span id="check-scope">Scope</span>
          <fieldset className="seg-group" aria-labelledby="check-scope">
            {(["task", "feature"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                className="seg"
                aria-pressed={draft.scope === scope}
                onClick={() => set("scope", scope)}
              >
                {scope}
              </button>
            ))}
          </fieldset>
        </div>
      </div>
      <div className="setup-fl">
        <label htmlFor="check-envNames">Env names passed through</label>
        <input {...field("envNames")} placeholder="none" />
      </div>
      <div className="setup-fl">
        <label htmlFor="check-writes">Files it may write</label>
        <input {...field("writes")} placeholder="none" />
      </div>
      <div className="setup-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          Save
        </button>
        {!isNew && (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy || !canRun || run?.kind === "running"}
              title={
                canRun
                  ? "Runs the saved check as a run would, without recording evidence"
                  : "Running one check on its own needs a newer BAKED"
              }
              onClick={onRun}
            >
              Run now
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>
      {!isNew && !canRun && (
        <span className="muted setup-note">
          Running one check on its own needs a newer BAKED; it runs as part of every workflow run.
        </span>
      )}
      {!isNew && <RunResult run={run} last={last} />}
    </form>
  );
}

function GateDetails({
  gate,
  onConfirm,
  busy,
}: {
  gate: GateEntry;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <section className="card setup-form" aria-label={`Gate ${gate.id}`}>
      <div className="setup-row">
        <h2 className="setup-h">{gate.id}</h2>
        <Tag>{TYPE_LABEL[gate.type]}</Tag>
      </div>
      <dl className="setup-dl">
        <dt>Mode</dt>
        <dd>{gate.required ? "required" : "advisory"}</dd>
        <dt>Scope</dt>
        <dd>{gate.scope}</dd>
        <dt>Defined in</dt>
        <dd className="mono setup-wrap">
          {gate.path ?? (gate.source === "builtin" ? "BAKED (built in)" : "workflow policy")}
        </dd>
        <dt>Version</dt>
        <dd className="mono">{gate.hash.slice(0, 12)}</dd>
        {gate.shadows.length > 0 && (
          <>
            <dt>Replaces</dt>
            <dd>{gate.shadows.map((s) => s.path ?? s.source).join(", ")}</dd>
          </>
        )}
      </dl>
      {gate.source === "project" && gate.confirmed === false && (
        <div className="banner setup-stack">
          <span>
            This gate came with the repository. Read its definition before you confirm it; runs use
            it only after that.
          </span>
          <div>
            <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>
              Confirm
            </button>
          </div>
        </div>
      )}
      <span className="muted setup-note">
        {gate.source === "builtin"
          ? "Built into BAKED. Review profiles and severities come from the workflow policy."
          : "Edit this file in your editor. A changed project gate needs your confirmation again."}
      </span>
    </section>
  );
}

export function GatesSection({ project }: SectionProps) {
  const key = project.key;
  const [gates, reloadGates] = useLoad(() => setup.gates(key), [key]);
  const [config, reloadConfig, setConfig] = useLoad(() => setup.config(key), [key]);
  // `missing` means an older backend: checks are then read from and written to the config.
  const [checkList, , setCheckList] = useLoad(() => setup.checks(key), [key]);
  const [suggestions, reloadSuggestions] = useLoad(() => setup.checkSuggestions(key), [key]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, CheckRun>>({});

  if (gates.state !== "ready") return <LoadState value={gates} what="gates and checks" />;
  if (checkList.state === "loading") return <LoadState value={checkList} what="checks" />;
  const api: CheckList | null = checkList.state === "ready" ? checkList.data : null;
  const configView = config.state === "ready" ? config.data : null;
  const checks: Check[] = api ? api.checks.map(plainCheck) : effectiveChecks(configView);
  const lastResult = (id: string): CheckRunResult | null => {
    const run = runs[id];
    if (run?.kind === "done") return run.result;
    return api?.checks.find((c) => c.id === id)?.lastResult ?? null;
  };
  const list = gates.data.gates;
  const current = list.find((g) => g.id === selected) ?? list[0] ?? null;
  const currentCheck = current ? (checks.find((c) => c.id === current.id) ?? null) : null;
  const unconfirmed = list.filter((g) => g.source === "project" && g.confirmed === false);
  // A server error on the checks endpoint leaves the list read-only rather than guessing.
  const canEdit = api !== null || (checkList.state === "missing" && configView !== null);

  const act = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveChecks = (next: Check[]) =>
    act(async () => {
      if (api) {
        setCheckList(await setup.saveChecks(key, next.map(plainCheck)));
        reloadConfig();
      } else {
        if (!configView) throw new Error("The project config could not be read.");
        const workflows = workflowsWithChecks(configView, next);
        if (!workflows)
          throw new Error(
            "Workflows are not set up in this project. Run `baked workflow init` once, then add checks here.",
          );
        setConfig(await setup.patchConfig(key, "project", { set: { workflows } }));
      }
      reloadGates();
      reloadSuggestions();
    });
  const confirm = (ids: string[]) =>
    act(async () => {
      await setup.confirmGates(key, ids);
      reloadGates();
    });
  const runNow = async (id: string): Promise<void> => {
    setRuns((r) => ({ ...r, [id]: { kind: "running" } }));
    try {
      const result = await setup.runCheck(key, id);
      setRuns((r) => ({ ...r, [id]: { kind: "done", result } }));
    } catch (e) {
      setRuns((r) => ({ ...r, [id]: { kind: "error", message: runError(e, id) } }));
    }
  };

  const editable = canEdit && (creating || currentCheck !== null);
  const formKey = creating ? "new" : (current?.id ?? "none");
  const scopeNote = creating
    ? "saved in .baked/config.json"
    : current && checkScope(current.id, configView) === "global"
      ? "from ~/.baked/config.json; saving copies the list to this checkout"
      : "saved in .baked/config.json";

  return (
    <div className="setup setup-gates">
      <div className="setup-row">
        <p className="lede setup-grow">
          A required gate must pass before a run can finish. An advisory gate reports, the run goes
          on. Shared gates live in <span className="mono">baked/gates/</span>; checks you add here
          go to <span className="mono">.baked/config.json</span>. New runs use them at once; started
          runs keep the list they froze.
        </p>
        <button
          type="button"
          className="btn-primary"
          disabled={!canEdit}
          onClick={() => setCreating(true)}
        >
          New check
        </button>
      </div>

      {canEdit && suggestions.state === "ready" && (
        <Suggestions
          suggestions={suggestions.data.suggestions}
          existing={new Set(list.map((g) => g.id))}
          busy={busy}
          onAdd={(added) => void saveChecks([...checks, ...added])}
        />
      )}

      {unconfirmed.map((gate) => (
        <section key={gate.id} className="card setup-callout" aria-label={`Confirm ${gate.id}`}>
          <div className="setup-row">
            <span className="setup-grow">
              <span className="mono">{gate.id}</span> came with the repository. It runs only after
              you confirm it once.
            </span>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void confirm([gate.id])}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreating(false);
                setSelected(gate.id);
              }}
            >
              Inspect
            </button>
          </div>
        </section>
      ))}

      {gates.data.problems.length > 0 && (
        <div className="banner error">
          Not used, could not be read: {gates.data.problems.join("; ")}
        </div>
      )}
      {api && !api.workflowsEnabled && (
        <div className="banner">
          Workflows are off in this project, so no run uses these checks yet. The list is kept in{" "}
          <span className="mono">.baked/config.json</span> for when you turn them on.
        </div>
      )}
      {checkList.state === "error" && (
        <div className="banner error">
          The checks could not be read, so they are read-only here: {checkList.message}
        </div>
      )}
      {checkList.state === "missing" && config.state === "missing" && (
        <div className="banner setup-needs">
          Editing checks needs a newer BAKED; the list below is read-only.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="setup-split">
        <section aria-label="Gates" className="setup-section">
          {list.length === 0 ? (
            <div className="empty">No gates yet. Add a check, or detect one from the project.</div>
          ) : (
            <ul className="card setup-list setup-flush">
              {list.map((gate) => (
                <GateRow
                  key={gate.id}
                  gate={gate}
                  config={configView}
                  result={gate.source === "policy" ? lastResult(gate.id) : null}
                  selected={!creating && gate.id === current?.id}
                  onSelect={() => {
                    setCreating(false);
                    setSelected(gate.id);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
        <div className="setup-side">
          {editable ? (
            <CheckForm
              key={formKey}
              initial={creating ? null : currentCheck}
              isNew={creating}
              scopeNote={scopeNote}
              busy={busy}
              canRun={api !== null}
              {...(currentCheck && !creating
                ? { run: runs[currentCheck.id], last: lastResult(currentCheck.id) }
                : { run: undefined, last: null })}
              onRun={() => currentCheck && void runNow(currentCheck.id)}
              onDelete={() => {
                if (!currentCheck) return;
                void saveChecks(checks.filter((c) => c.id !== currentCheck.id)).then(
                  (saved) => saved && setSelected(null),
                );
              }}
              onSave={(draft) => {
                const parsed = draftToCheck(draft);
                if ("error" in parsed) {
                  setError(parsed.error);
                  return;
                }
                const previous = creating ? null : (currentCheck?.id ?? null);
                if (parsed.check.id !== previous && list.some((g) => g.id === parsed.check.id)) {
                  setError(`A gate named ${parsed.check.id} exists already.`);
                  return;
                }
                void saveChecks(upsertCheck(checks, parsed.check, previous)).then((saved) => {
                  if (!saved) return;
                  setCreating(false);
                  setSelected(parsed.check.id);
                });
              }}
            />
          ) : current ? (
            <GateDetails gate={current} busy={busy} onConfirm={() => void confirm([current.id])} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
