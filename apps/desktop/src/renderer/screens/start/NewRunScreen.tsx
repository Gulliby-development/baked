import { useMemo, useState } from "react";
import { type DefinitionSummary, MAX_WRITERS, start } from "../../client/start.js";
import type { SectionProps } from "../sections.js";
import { takeDraft } from "./drafts.js";
import {
  BudgetPicker,
  CHIP,
  CHIPS,
  FIELD,
  FIELDSET,
  FORM,
  GOAL,
  HINT,
  HINT_ERR,
  INLINE,
  LEGEND,
  policyFor,
  presetLimits,
  SUBMIT,
  TITLE,
  usePolicy,
  useStartRun,
} from "./form.js";
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
    <fieldset className={FIELDSET}>
      <legend className={LEGEND}>Workflow</legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-[10px]">
        {main.map(({ definition, note }) => (
          <button
            key={definition.id}
            type="button"
            className="flex cursor-pointer flex-col items-start gap-1 rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-background px-[14px] py-3 text-left [font:inherit] hover:border-[color:var(--line-strong)] aria-pressed:border-[color:var(--accent)] aria-pressed:bg-hover"
            aria-pressed={value === definition.id}
            onClick={() => onChange(definition)}
          >
            <span className="font-semibold text-foreground">{definition.id}</span>
            <span className="text-[12px] text-muted-foreground">{note}</span>
          </button>
        ))}
      </div>
      {more.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-dim-foreground">
          <span>More workflows:</span>
          {more.map((definition) => (
            <button
              key={definition.id}
              type="button"
              className={CHIP}
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
        <span className={`mono ${HINT}`}>{chosen.stages.map(stageLabel).join(" → ")}</span>
      )}
      {chosen && chosen.problems.length > 0 && (
        <span className={HINT_ERR}>{chosen.problems.join("; ")}</span>
      )}
    </fieldset>
  );
}

export function NewRunScreen({ project }: SectionProps) {
  const key = project.key;
  const [prompt, setPrompt] = useState(() => takeDraft("run", key));
  const [featureEdit, setFeatureEdit] = useState<string | null>(null);
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
  const feature = featureEdit ?? featureSlug(prompt);
  const featureValid = isFeatureId(feature);
  const canStart = prompt.trim().length > 0 && featureValid && !launcher.starting;

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
      feature,
      prompt: prompt.trim(),
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
    <div className="flex flex-wrap items-start gap-[22px]">
      <form
        className={`${FORM} flex-[999_1_460px]`}
        onSubmit={submit}
        aria-labelledby="new-run-title"
      >
        <h2 id="new-run-title" className={TITLE}>
          New workflow run
        </h2>
        <div className={FIELD}>
          <label htmlFor="new-run-goal" className={LEGEND}>
            Goal
          </label>
          <textarea
            id="new-run-goal"
            className={GOAL}
            rows={3}
            value={prompt}
            placeholder="Describe what should change and how you will know it works."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className={FIELD}>
          <label htmlFor="new-run-feature" className={LEGEND}>
            Feature ID
          </label>
          <input
            id="new-run-feature"
            type="text"
            className="mono max-w-[520px] aria-[invalid=true]:border-[color:var(--err)]"
            value={feature}
            placeholder="derived from the goal"
            aria-invalid={feature !== "" && !featureValid}
            aria-describedby="new-run-feature-hint"
            onChange={(e) => setFeatureEdit(e.target.value)}
          />
          <span id="new-run-feature-hint" className={HINT}>
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
          <p className={HINT}>Loading workflows…</p>
        )}

        <div className="flex flex-wrap gap-7 [&>fieldset]:flex-[1_1_240px]">
          <BudgetPicker value={budget} onChange={setBudget} policy={policy} base={limits.base} />
          <fieldset className={FIELDSET}>
            <legend className={LEGEND}>Mode and writers</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={worktree}
                disabled={worktreeRefusal !== null}
                onChange={(e) => toggleWorktree(e.target.checked)}
              />
              Run in a Git worktree
            </label>
            <fieldset className={`${CHIPS} m-0 min-w-0 border-0 p-0`} aria-label="Writers">
              {Array.from({ length: MAX_WRITERS }, (_, i) => i + 1).map((count) => (
                <button
                  key={count}
                  type="button"
                  className={CHIP}
                  aria-pressed={writers === count}
                  aria-label={`${count} writer${count === 1 ? "" : "s"}`}
                  disabled={count > 1 && worktreeRefusal !== null}
                  onClick={() => pickWriters(count)}
                >
                  {count}
                </button>
              ))}
            </fieldset>
            <span className={HINT}>
              {worktreeRefusal ??
                (writers > 1
                  ? `${writers} tasks at once, each in its own worktree`
                  : worktree
                    ? "one task at a time, in a worktree of the project"
                    : "one task at a time, in place")}
            </span>
          </fieldset>
        </div>

        <fieldset className={FIELDSET}>
          <legend className={LEGEND}>Open questions</legend>
          <label className="check">
            <input type="checkbox" checked={assume} onChange={(e) => setAssume(e.target.checked)} />
            Settle them with recorded assumptions
          </label>
          <span className={HINT}>
            {assume
              ? "The agents pick conventional defaults and list them at approval; only questions without a safe default wait for you."
              : "The run waits for your answers to blocking questions."}
          </span>
        </fieldset>

        <div className={INLINE}>
          <label htmlFor="new-run-model" className={LEGEND}>
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
        <div className={INLINE}>
          <button type="submit" className={SUBMIT} disabled={!canStart}>
            {launcher.starting ? "Starting…" : "Start run"}
          </button>
          <span className={HINT} aria-live="polite">
            {preRun.doctor ? doctorLine(preRun.doctor) : preRun.loading ? "Checking…" : ""}
          </span>
        </div>
      </form>

      <aside className="flex min-w-0 flex-[1_1_420px] flex-col gap-4" aria-label="Before the run">
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
