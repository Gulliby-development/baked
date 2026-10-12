import { useMemo, useState } from "react";
import { api } from "../../client/api.js";
import { type DefinitionSummary, start } from "../../client/start.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { projectHref } from "../../router.js";
import { lineOf } from "../runs/line-model.js";
import type { SectionProps } from "../sections.js";
import { takeDraft } from "./drafts.js";
import {
  BudgetPicker,
  budgetField,
  FIELD,
  FORM,
  GOAL,
  HINT,
  INLINE,
  LEGEND,
  presetLimits,
  SUBMIT,
  TITLE,
  usePolicy,
  useStartRun,
} from "./form.js";
import {
  type BudgetPreset,
  isFeatureId,
  quickBlocker,
  stageLabel,
  uniqueFeatureId,
} from "./logic.js";
import { DoctorPanel, doctorLine, EstimatePanel, useLoad, usePreRun } from "./panels.js";

const QUICK = "quick";

async function takenFeatures(key: string): Promise<Set<string>> {
  const runs = await api.runs(key, 100);
  return new Set(runs.items.map((run) => run.featureId));
}

/** The stages of the quick workflow as a read-only flow; stages a person handles get a dot. */
function StageFlow({ definition }: { definition: DefinitionSummary }) {
  const line = lineOf(definition.stages, definition.line);
  const human = line.stages.find((stage) => stage.human);
  return (
    <div className={FIELD}>
      <span className={LEGEND}>How it runs</span>
      <ol
        aria-label="Stages"
        className="m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-2 p-0"
      >
        {line.stages.map((stage, i) => (
          <li key={stage.id} className="flex items-center gap-1 text-[14px] text-soft-foreground">
            {i > 0 && <Icon name="chevron-right" size={13} className="text-dim-foreground" />}
            {stage.human && (
              <span
                className="size-[9px] flex-none rounded-full border-2 border-border bg-fill-warn"
                aria-hidden="true"
              />
            )}
            <span className={stage.human ? "font-semibold text-foreground" : ""}>
              {stageLabel(stage.id)}
              {stage.human && <span className="sr-only"> (you)</span>}
            </span>
          </li>
        ))}
      </ol>
      {human && (
        <span className={HINT}>
          {stageLabel(human.id)} is where you check the plan; nothing in the project changes before
          you approve it.
        </span>
      )}
    </div>
  );
}

/** Starts the quick workflow: plan, approval, implement, checks and review of a small change. */
export function QuickTaskScreen({ project }: SectionProps) {
  const key = project.key;
  const [prompt, setPrompt] = useState(() => takeDraft("quick", key));
  const [featureEdit, setFeatureEdit] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetPreset>("quick");
  const definitions = useLoad(key, "definitions", start.definitions);
  const taken = useLoad(key, "taken-features", takenFeatures);
  const policy = usePolicy(key);
  const preRun = usePreRun(key, { workflow: QUICK });
  const limits = presetLimits(budget, policy.policy, preRun.estimate);
  const launcher = useStartRun(key);

  const definition = definitions.value?.find((d) => d.id === QUICK) ?? null;
  const derived = useMemo(
    () => uniqueFeatureId(prompt, (id) => taken.value?.has(id) ?? false),
    [prompt, taken.value],
  );
  const feature = featureEdit ?? derived;
  const hasText = prompt.trim().length > 0;
  const blocker = quickBlocker({
    prompt,
    feature,
    hasWorkflow: definitions.value ? definition !== null : null,
  });
  const canStart = blocker === null && !launcher.starting;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canStart) return;
    void launcher.run({
      feature,
      prompt: prompt.trim(),
      workflow: QUICK,
      ...budgetField(budget),
    });
  };

  return (
    <div className="flex w-full min-w-0 max-w-[900px] flex-col gap-5">
      <form className={`${FORM} flex-none`} onSubmit={submit} aria-labelledby="quick-title">
        <div className={INLINE}>
          <span className="rounded-[6px] bg-selected px-2 py-[3px] font-mono text-[12px] text-[color:var(--accent-soft)]">
            quick
          </span>
          <h2 id="quick-title" className={TITLE}>
            Quick task
          </h2>
          <a className="ml-auto text-[13px]" href={projectHref(key, "runs", "new")}>
            Switch to a full run
          </a>
        </div>
        <div className={FIELD}>
          <label htmlFor="quick-goal" className={LEGEND}>
            What should change?
          </label>
          <textarea
            id="quick-goal"
            className={`${GOAL} placeholder:text-dim-foreground placeholder:italic`}
            rows={3}
            value={prompt}
            placeholder="e.g. Fix the off-by-one in the usage table header"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        {hasText && (
          <div className={FIELD}>
            <label htmlFor="quick-feature" className={LEGEND}>
              Feature ID
            </label>
            <Input
              id="quick-feature"
              className="max-w-[420px] font-mono"
              value={feature}
              aria-invalid={!isFeatureId(feature)}
              aria-describedby="quick-feature-hint"
              onChange={(e) => setFeatureEdit(e.target.value)}
            />
            <span id="quick-feature-hint" className={HINT}>
              {featureEdit === null
                ? "Taken from the text; names the run. Edit it if you like."
                : "Names the run."}
            </span>
          </div>
        )}

        {definition && <StageFlow definition={definition} />}
        {definitions.value && !definition && (
          <Alert tone="error">This project has no quick workflow.</Alert>
        )}

        <BudgetPicker value={budget} onChange={setBudget} policy={policy} base={limits.base} />

        {launcher.error && <Alert tone="error">{launcher.error}</Alert>}
        <div className={INLINE}>
          <Button
            type="submit"
            variant="primary"
            size="md"
            className={SUBMIT}
            disabled={!canStart}
            aria-describedby="quick-start-hint"
          >
            {launcher.starting ? "Starting…" : "Plan it"}
          </Button>
          <span id="quick-start-hint" className={HINT} aria-live="polite">
            {blocker ??
              `Plans the change and waits for your approval before it writes anything.${
                preRun.doctor ? ` ${doctorLine(preRun.doctor)}.` : ""
              }`}
          </span>
        </div>
      </form>

      <div className="flex min-w-0 flex-col gap-4">
        <EstimatePanel
          estimate={preRun.estimate}
          error={preRun.estimateError}
          loading={preRun.loading}
          cap={limits.cap}
          checkpoint={limits.checkpoint}
          stagesFolded
        />
        <DoctorPanel report={preRun.doctor} error={preRun.doctorError} loading={preRun.loading} />
      </div>
    </div>
  );
}
