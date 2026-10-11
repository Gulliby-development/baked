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
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { ago } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { CHECK, LEDE, PANEL } from "../../lib/styles.js";
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
import {
  ACTIONS,
  errorText,
  FIELD_HALF,
  FL,
  FLUSH,
  FORM,
  GATE,
  GROW,
  H,
  LIST,
  LoadState,
  MARK,
  NEEDS,
  NOTE,
  PAIR,
  ROW,
  SETUP,
  SIDE,
  SPLIT,
  SPLIT_MAIN,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

const TYPE_LABEL: Record<GateEntry["type"], string> = {
  command: "command",
  human: "human",
  "ai-review": "AI review",
  "ai-acceptance": "AI acceptance",
};

const MARK_TONE = {
  ok: "text-[var(--ok)]",
  err: "text-[var(--err)]",
  warn: "text-[var(--warn)]",
  "": "text-dim-foreground",
} as const;

const RESULT_TONE = {
  ok: "text-[var(--ok)]",
  err: "text-[var(--err)]",
  "": "text-muted-foreground",
} as const;

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
      <button type="button" className={GATE} aria-pressed={selected} onClick={onSelect}>
        <span className={`font-mono ${MARK} ${MARK_TONE[m.tone]}`} role="img" aria-label={m.label}>
          {m.text}
        </span>
        <span className="font-mono text-foreground">{gate.id}</span>
        <Tag>{TYPE_LABEL[gate.type]}</Tag>
        <Tag>{gate.required ? "required" : "advisory"}</Tag>
        <Tag>{gate.scope}</Tag>
        <Tag>{gateOrigin(gate, config)}</Tag>
        <span className="ml-auto font-mono text-dim-foreground">
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
    <section className={cn(PANEL, "border-border")} aria-label="Detected checks">
      <div className={ROW}>
        <span className={GROW}>
          Detected in <span className="font-mono">{sources.join(", ")}</span>:{" "}
          {fresh.map((s, i) => (
            <span key={s.check.id}>
              {i > 0 && (i === fresh.length - 1 ? " and " : ", ")}
              <span className="font-mono">{s.reason}</span>
            </span>
          ))}
        </span>
        <Button
          variant="secondary"
          size="md"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Review and add
        </Button>
      </div>
      {open && (
        <div className={STACK}>
          {fresh.map((s) => (
            <label key={s.check.id} className={CHECK}>
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
              <span className="font-mono">{s.check.id}</span>
              <span className="font-mono text-dim-foreground">
                {joinCommand(s.check.executable, s.check.args)}
              </span>
              <span className="text-dim-foreground">
                {s.check.required ? "required" : "advisory"} · {s.source}
              </span>
            </label>
          ))}
          <div>
            <Button
              variant="primary"
              size="md"
              disabled={busy || chosen.length === 0}
              onClick={() => onAdd(chosen.map((s) => s.check))}
            >
              Add {chosen.length} to this checkout
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The latest result of a check: from this screen's run, or the backend's `lastResult`. */
function RunResult({ run, last }: { run: CheckRun | undefined; last: CheckRunResult | null }) {
  if (run?.kind === "running")
    return <span className={`text-dim-foreground ${NOTE}`}>Running…</span>;
  if (run?.kind === "error") return <Alert tone="error">{run.message}</Alert>;
  const result = run?.kind === "done" ? run.result : last;
  if (!result) return null;
  const tone = result.status === "passed" ? "ok" : result.status === "cancelled" ? "" : "err";
  return (
    <section className={STACK} aria-label="Last result">
      <span className={NOTE}>
        <span className={`font-mono ${RESULT_TONE[tone]}`}>{checkResultText(result)}</span>
        <span className="text-dim-foreground"> · {ago(result.at)}</span>
      </span>
      {result.outputTail && (
        <pre className="m-0 font-mono max-h-[260px] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-base border-2 border-border bg-[var(--bg-code)] px-3 py-[10px] text-[12px] leading-[1.5] text-soft-foreground">
          {result.outputTail}
        </pre>
      )}
      {result.truncated && (
        <span className={`text-dim-foreground ${NOTE}`}>
          Only the last lines of the output are kept.
        </span>
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
    value: draft[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  return (
    <form
      className={cn(PANEL, FORM)}
      aria-label={isNew ? "New check" : `Edit ${initial?.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <div className={ROW}>
        <h2 className={H}>{isNew ? "New check" : initial?.id}</h2>
        <Tag>command</Tag>
        <span className={`text-dim-foreground ml-auto ${NOTE}`}>{scopeNote}</span>
      </div>
      <div className={FL}>
        <label htmlFor="check-id">ID</label>
        <input {...field("id")} />
      </div>
      <div className={FL}>
        <label htmlFor="check-command">Command</label>
        <input {...field("command")} placeholder="bun run typecheck" />
      </div>
      <div className={PAIR}>
        <div className={FIELD_HALF}>
          <label htmlFor="check-cwd">Directory</label>
          <input {...field("cwd")} />
        </div>
        <div className={FIELD_HALF}>
          <label htmlFor="check-timeoutSeconds">Timeout, s</label>
          <input {...field("timeoutSeconds")} inputMode="numeric" />
        </div>
      </div>
      <div className={PAIR}>
        <div className={FIELD_HALF}>
          <span id="check-required">Required</span>
          <SegmentGroup aria-labelledby="check-required">
            {([true, false] as const).map((required) => (
              <Segment
                key={String(required)}
                aria-pressed={draft.required === required}
                onClick={() => set("required", required)}
              >
                {required ? "required" : "advisory"}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
        <div className={FIELD_HALF}>
          <span id="check-scope">Scope</span>
          <SegmentGroup aria-labelledby="check-scope">
            {(["task", "feature"] as const).map((scope) => (
              <Segment
                key={scope}
                aria-pressed={draft.scope === scope}
                onClick={() => set("scope", scope)}
              >
                {scope}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
      </div>
      <div className={FL}>
        <label htmlFor="check-envNames">Env names passed through</label>
        <input {...field("envNames")} placeholder="none" />
      </div>
      <div className={FL}>
        <label htmlFor="check-writes">Files it may write</label>
        <input {...field("writes")} placeholder="none" />
      </div>
      <div className={ACTIONS}>
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          Save
        </Button>
        {!isNew && (
          <>
            <Button
              variant="secondary"
              size="md"
              disabled={busy || !canRun || run?.kind === "running"}
              title={
                canRun
                  ? "Runs the saved check as a run would, without recording evidence"
                  : "Running one check on its own needs a newer BAKED"
              }
              onClick={onRun}
            >
              Run now
            </Button>
            <Button variant="secondary" size="md" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          </>
        )}
      </div>
      {!isNew && !canRun && (
        <span className={`text-dim-foreground ${NOTE}`}>
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
    <section className={cn(PANEL, FORM)} aria-label={`Gate ${gate.id}`}>
      <div className={ROW}>
        <h2 className={H}>{gate.id}</h2>
        <Tag>{TYPE_LABEL[gate.type]}</Tag>
      </div>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-[14px] gap-y-[6px] text-[13px] [&_dd]:m-0 [&_dd]:text-soft-foreground [&_dt]:text-dim-foreground">
        <dt>Mode</dt>
        <dd>{gate.required ? "required" : "advisory"}</dd>
        <dt>Scope</dt>
        <dd>{gate.scope}</dd>
        <dt>Defined in</dt>
        <dd className={`font-mono ${WRAP}`}>
          {gate.path ?? (gate.source === "builtin" ? "BAKED (built in)" : "workflow policy")}
        </dd>
        <dt>Version</dt>
        <dd className="font-mono">{gate.hash.slice(0, 12)}</dd>
        {gate.shadows.length > 0 && (
          <>
            <dt>Replaces</dt>
            <dd>{gate.shadows.map((s) => s.path ?? s.source).join(", ")}</dd>
          </>
        )}
      </dl>
      {gate.source === "project" && gate.confirmed === false && (
        <Alert className={STACK}>
          <span>
            This gate came with the repository. Read its definition before you confirm it; runs use
            it only after that.
          </span>
          <div>
            <Button variant="primary" size="md" disabled={busy} onClick={onConfirm}>
              Confirm
            </Button>
          </div>
        </Alert>
      )}
      <span className={`text-dim-foreground ${NOTE}`}>
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
    <div className={SETUP}>
      <div className={ROW}>
        <p className={`${LEDE} ${GROW}`}>
          A required gate must pass before a run can finish. An advisory gate reports, the run goes
          on. Shared gates live in <span className="font-mono">baked/gates/</span>; checks you add
          here go to <span className="font-mono">.baked/config.json</span>. New runs use them at
          once; started runs keep the list they froze.
        </p>
        <Button variant="primary" size="md" disabled={!canEdit} onClick={() => setCreating(true)}>
          New check
        </Button>
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
        <section
          key={gate.id}
          className={cn(PANEL, "border-border")}
          aria-label={`Confirm ${gate.id}`}
        >
          <div className={ROW}>
            <span className={GROW}>
              <span className="font-mono">{gate.id}</span> came with the repository. It runs only
              after you confirm it once.
            </span>
            <Button
              variant="primary"
              size="md"
              disabled={busy}
              onClick={() => void confirm([gate.id])}
            >
              Confirm
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setCreating(false);
                setSelected(gate.id);
              }}
            >
              Inspect
            </Button>
          </div>
        </section>
      ))}

      {gates.data.problems.length > 0 && (
        <Alert tone="error">Not used, could not be read: {gates.data.problems.join("; ")}</Alert>
      )}
      {api && !api.workflowsEnabled && (
        <Alert>
          Workflows are off in this project, so no run uses these checks yet. The list is kept in{" "}
          <span className="font-mono">.baked/config.json</span> for when you turn them on.
        </Alert>
      )}
      {checkList.state === "error" && (
        <Alert tone="error">
          The checks could not be read, so they are read-only here: {checkList.message}
        </Alert>
      )}
      {checkList.state === "missing" && config.state === "missing" && (
        <Alert className={NEEDS}>
          Editing checks needs a newer BAKED; the list below is read-only.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <div className={SPLIT}>
        <section aria-label="Gates" className={SPLIT_MAIN}>
          {list.length === 0 ? (
            <Empty>No gates yet. Add a check, or detect one from the project.</Empty>
          ) : (
            <ul className={cn(PANEL, LIST, FLUSH)}>
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
        <div className={SIDE}>
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
