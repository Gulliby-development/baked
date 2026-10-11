import "../../styles/start.css";
import { useMemo, useState } from "react";
import { type DefinitionSummary, MAX_WRITERS, start } from "../../client/start.js";
import type { SectionProps } from "../sections.js";
import { takeDraft } from "./drafts.js";
import { BudgetPicker, policyFor, presetLimits, usePolicy, useStartRun } from "./form.js";
import { type BudgetPreset, featureSlug, isFeatureId, stageLabel } from "./logic.js";
import { DoctorPanel, doctorLine, EstimatePanel, message, useLoad, usePreRun } from "./panels.js";

/** The three workflows shown as large cards, with the line the mockups give each. */
const MAIN_WORKFLOWS: [string, string][] = [
  ["quick", "small, located change"],
  ["standard", "spec, plan, review"],
  ["sdd", "full flow with research"],
];

async function loadModels(key: string): Promise<string[]> {
  const profiles = await start.profiles(key);
  return [...new Set(profiles.map((p) => p.route.model).filter(Boolean))].sort();
}

function WorkflowChoice({
  definitions,
  value,
  onChange,
}: {
  definitions: DefinitionSummary[];
  value: string;
  onChange: (definition: DefinitionSummary) => void;
}) {
  const main = MAIN_WORKFLOWS.flatMap(([id, note]) => {
    const definition = definitions.find((d) => d.id === id);
    return definition ? [{ definition, note }] : [];
  });
  const more = definitions.filter((d) => !MAIN_WORKFLOWS.some(([id]) => id === d.id));
  const chosen = definitions.find((d) => d.id === value);
  return (
    <fieldset className="start-fieldset">
      <legend className="start-legend">Workflow</legend>
      <div className="start-workflows">
        {main.map(({ definition, note }) => (
          <button
            key={definition.id}
            type="button"
            className="start-workflow"
            aria-pressed={value === definition.id}
            onClick={() => onChange(definition)}
          >
            <span className="start-workflow-id">{definition.id}</span>
            <span className="start-workflow-note">{note}</span>
          </button>
        ))}
      </div>
      {more.length > 0 && (
        <div className="start-more">
          <span>More workflows:</span>
          {more.map((definition) => (
            <button
              key={definition.id}
              type="button"
              className="seg start-chip"
              aria-pressed={value === definition.id}
              title={definition.description || undefined}
              onClick={() => onChange(definition)}
            >
              {definition.id}
              {definition.source === "project" ? " (project)" : ""}
            </button>
          ))}
        </div>
      )}
      {chosen && (
        <span className="mono start-hint">{chosen.stages.map(stageLabel).join(" → ")}</span>
      )}
      {chosen && chosen.problems.length > 0 && (
        <span className="start-hint err">{chosen.problems.join("; ")}</span>
      )}
    </fieldset>
  );
}

export function NewRunScreen({ project }: SectionProps) {
  const key = project.key;
  const [prompt, setPrompt] = useState(() => takeDraft("run", key));
  const [featureEdit, setFeatureEdit] = useState<string | null>(null);
  const [issue, setIssue] = useState("");
  const [workflow, setWorkflow] = useState("sdd");
  const [budget, setBudget] = useState<BudgetPreset>("standard");
  const [worktree, setWorktree] = useState(false);
  const [writers, setWriters] = useState(1);
  // Null follows the configured policy; the checkbox overrides it for this run.
  const [assumeOverride, setAssume] = useState<boolean | null>(null);
  const [model, setModel] = useState("");

  const definitions = useLoad(key, start.definitions);
  const models = useLoad(key, loadModels);
  const policy = usePolicy(key);
  const preRun = usePreRun(key, {
    workflow,
    ...(model ? { model } : {}),
    worktree,
    writers,
  });
  const limits = presetLimits(
    budget,
    policy.policy,
    preRun.estimate ?? preRun.doctor?.estimate ?? null,
  );
  const launcher = useStartRun(key);
  const assume = assumeOverride ?? policy.policy?.clarification === "assume";

  const definition = useMemo(
    () => definitions.value?.find((d) => d.id === workflow) ?? null,
    [definitions.value, workflow],
  );
  const worktreeRefusal = definition?.worktreeRefusal ?? null;
  const fromIssue = issue.trim() !== "";
  // With an issue and no feature typed, the core names the feature after the issue.
  const feature = featureEdit ?? (fromIssue ? "" : featureSlug(prompt));
  const featureValid = isFeatureId(feature) || (fromIssue && feature === "");
  const canStart = (prompt.trim().length > 0 || fromIssue) && featureValid && !launcher.starting;

  const pickWorkflow = (next: DefinitionSummary): void => {
    setWorkflow(next.id);
    if (next.worktreeRefusal) {
      setWorktree(false);
      setWriters(1);
    } else if (next.execution === "worktree") setWorktree(true);
  };
  const pickWriters = (count: number): void => {
    setWriters(count);
    if (count > 1) setWorktree(true);
  };
  const toggleWorktree = (on: boolean): void => {
    setWorktree(on);
    if (!on) setWriters(1);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canStart) return;
    const scaled = policyFor(budget, policy.policy);
    void launcher.run({
      ...(feature ? { feature } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(fromIssue ? { issue: issue.trim() } : {}),
      workflow,
      ...(scaled ? { policy: scaled } : {}),
      ...(model ? { model } : {}),
      ...(worktree ? { worktree: true } : {}),
      ...(writers > 1 ? { writers } : {}),
      // Sent only when changed here, so a backend without the field still starts the run.
      ...(assumeOverride !== null ? { clarification: assume ? "assume" : "ask" } : {}),
    });
  };

  return (
    <div className="start-layout">
      <form className="start-form" onSubmit={submit} aria-labelledby="new-run-title">
        <h2 id="new-run-title" className="start-title">
          New workflow run
        </h2>
        <div className="start-field">
          <label htmlFor="new-run-goal" className="start-legend">
            Goal
          </label>
          <textarea
            id="new-run-goal"
            className="start-goal"
            rows={3}
            value={prompt}
            placeholder="Describe what should change and how you will know it works."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="start-field">
          <label htmlFor="new-run-issue" className="start-legend">
            GitHub issue
          </label>
          <input
            id="new-run-issue"
            type="text"
            className="mono start-input"
            value={issue}
            placeholder="optional: issue URL, owner/name#N or #N"
            aria-describedby="new-run-issue-hint"
            onChange={(e) => setIssue(e.target.value)}
          />
          <span id="new-run-issue-hint" className="start-hint">
            {fromIssue
              ? "The issue's title and body are the goal; text above adds instructions. The delivered pull request closes the issue."
              : "Start from an issue instead of typing the goal."}
          </span>
        </div>
        <div className="start-field">
          <label htmlFor="new-run-feature" className="start-legend">
            Feature ID
          </label>
          <input
            id="new-run-feature"
            type="text"
            className="mono start-input"
            value={feature}
            placeholder={fromIssue ? "issue-N-title, from the issue" : "derived from the goal"}
            aria-invalid={feature !== "" && !featureValid}
            aria-describedby="new-run-feature-hint"
            onChange={(e) => setFeatureEdit(e.target.value)}
          />
          <span id="new-run-feature-hint" className="start-hint">
            {feature !== "" && !featureValid
              ? "Letters, digits, - and _; starts with a letter or digit; at most 96 characters."
              : "Names the run and its folder under specs/."}
          </span>
        </div>

        {definitions.error ? (
          <div className="banner error">Workflows: {message(definitions.error)}</div>
        ) : definitions.value ? (
          <WorkflowChoice
            definitions={definitions.value}
            value={workflow}
            onChange={pickWorkflow}
          />
        ) : (
          <p className="start-hint">Loading workflows…</p>
        )}

        <div className="start-row">
          <BudgetPicker value={budget} onChange={setBudget} policy={policy} base={limits.base} />
          <fieldset className="start-fieldset">
            <legend className="start-legend">Mode and writers</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={worktree}
                disabled={worktreeRefusal !== null}
                onChange={(e) => toggleWorktree(e.target.checked)}
              />
              Run in a Git worktree
            </label>
            <fieldset className="start-chips start-bare" aria-label="Writers">
              {Array.from({ length: MAX_WRITERS }, (_, i) => i + 1).map((count) => (
                <button
                  key={count}
                  type="button"
                  className="seg start-chip"
                  aria-pressed={writers === count}
                  aria-label={`${count} writer${count === 1 ? "" : "s"}`}
                  disabled={count > 1 && worktreeRefusal !== null}
                  onClick={() => pickWriters(count)}
                >
                  {count}
                </button>
              ))}
            </fieldset>
            <span className="start-hint">
              {worktreeRefusal ??
                (writers > 1
                  ? `${writers} tasks at once, each in its own worktree`
                  : worktree
                    ? "one task at a time, in a worktree of the project"
                    : "one task at a time, in place")}
            </span>
          </fieldset>
        </div>

        <fieldset className="start-fieldset">
          <legend className="start-legend">Open questions</legend>
          <label className="check">
            <input type="checkbox" checked={assume} onChange={(e) => setAssume(e.target.checked)} />
            Settle them with recorded assumptions
          </label>
          <span className="start-hint">
            {assume
              ? "The agents pick conventional defaults and list them at approval; only questions without a safe default wait for you."
              : "The run waits for your answers to blocking questions."}
          </span>
        </fieldset>

        <div className="start-inline">
          <label htmlFor="new-run-model" className="start-legend">
            Run model
          </label>
          <select id="new-run-model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">
              Configured default{preRun.doctor?.runModel ? ` (${preRun.doctor.runModel})` : ""}
            </option>
            {(models.value ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {launcher.error && <div className="banner error">{launcher.error}</div>}
        <div className="start-inline">
          <button type="submit" className="btn-primary start-submit" disabled={!canStart}>
            {launcher.starting ? "Starting…" : "Start run"}
          </button>
          <span className="start-hint" aria-live="polite">
            {preRun.doctor ? doctorLine(preRun.doctor) : preRun.loading ? "Checking…" : ""}
          </span>
        </div>
      </form>

      <aside className="start-aside" aria-label="Before the run">
        <DoctorPanel report={preRun.doctor} error={preRun.doctorError} loading={preRun.loading} />
        <EstimatePanel
          estimate={preRun.estimate}
          error={preRun.estimateError}
          loading={preRun.loading}
          cap={limits.cap}
          checkpoint={limits.checkpoint}
        />
      </aside>
    </div>
  );
}
