import { useEffect, useMemo, useState } from "react";
import { api } from "../../client/api.js";
import { start } from "../../client/start.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { takeDraft } from "./drafts.js";
import {
  BudgetPicker,
  FIELD,
  FORM,
  GOAL,
  HINT,
  INLINE,
  LEGEND,
  policyFor,
  presetLimits,
  SUBMIT,
  TITLE,
  usePolicy,
  useStartRun,
} from "./form.js";
import { type BudgetPreset, stageLabel, uniqueFeatureId } from "./logic.js";
import { DoctorPanel, doctorLine, EstimatePanel, useLoad, usePreRun } from "./panels.js";

const QUICK = "quick";

async function takenFeatures(key: string): Promise<Set<string>> {
  const runs = await api.runs(key, 100);
  return new Set(runs.items.map((run) => run.featureId));
}

/** Starts the quick workflow: plan, approval, implement, checks and review of a small change. */
export function QuickTaskScreen({ project }: SectionProps) {
  const key = project.key;
  const [prompt, setPrompt] = useState(() => takeDraft("quick", key));
  const [budget, setBudget] = useState<BudgetPreset>("quick");
  const definitions = useLoad(key, "definitions", start.definitions);
  const taken = useLoad(key, "taken-features", takenFeatures);
  const policy = usePolicy(key);
  const preRun = usePreRun(key, { workflow: QUICK });
  const limits = presetLimits(budget, policy.policy, preRun.estimate);
  const launcher = useStartRun(key);

  // The quick preset scales the configured policy; without it the run takes the configured one.
  useEffect(() => {
    if (!policy.loading && !policy.policy) setBudget("standard");
  }, [policy.loading, policy.policy]);

  const definition = definitions.value?.find((d) => d.id === QUICK) ?? null;
  const feature = useMemo(
    () => uniqueFeatureId(prompt, (id) => taken.value?.has(id) ?? false),
    [prompt, taken.value],
  );
  const canStart = prompt.trim().length > 0 && feature !== "" && !launcher.starting;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canStart) return;
    const scaled = policyFor(budget, policy.policy);
    void launcher.run({
      feature,
      prompt: prompt.trim(),
      workflow: QUICK,
      ...(scaled ? { policy: scaled } : {}),
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
            className={GOAL}
            rows={3}
            value={prompt}
            placeholder="Fix the off-by-one in the usage table header"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className={`font-mono ${HINT}`}>
            {feature ? `feature ${feature}` : "The feature ID comes from the text."}
          </span>
        </div>

        {definition && (
          <ol aria-label="Stages" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {definition.stages.map((stage) => (
              <li
                key={stage}
                className="rounded-[8px] border border-[color:var(--line)] bg-raised px-3 py-[6px] text-[13px] text-muted-foreground"
              >
                {stageLabel(stage)}
              </li>
            ))}
          </ol>
        )}
        {definitions.value && !definition && (
          <Alert tone="error">This project has no quick workflow.</Alert>
        )}

        <BudgetPicker value={budget} onChange={setBudget} policy={policy} base={limits.base} />

        {launcher.error && <Alert tone="error">{launcher.error}</Alert>}
        <div className={INLINE}>
          <Button type="submit" variant="primary" size="md" className={SUBMIT} disabled={!canStart}>
            {launcher.starting ? "Starting…" : "Plan it"}
          </Button>
          <span className={HINT} aria-live="polite">
            Plans the change and waits for your approval before it writes anything.
            {preRun.doctor ? ` ${doctorLine(preRun.doctor)}.` : ""}
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
        />
        <DoctorPanel report={preRun.doctor} error={preRun.doctorError} loading={preRun.loading} />
      </div>
    </div>
  );
}
