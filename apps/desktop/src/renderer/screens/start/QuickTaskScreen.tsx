import "../../styles/start.css";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../client/api.js";
import { start } from "../../client/start.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { takeDraft } from "./drafts.js";
import { BudgetPicker, policyFor, presetLimits, usePolicy, useStartRun } from "./form.js";
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
  const definitions = useLoad(key, start.definitions);
  const taken = useLoad(key, takenFeatures);
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
    <div className="start-quick">
      <form className="start-form" onSubmit={submit} aria-labelledby="quick-title">
        <div className="start-inline">
          <span className="mono start-tag">quick</span>
          <h2 id="quick-title" className="start-title">
            Quick task
          </h2>
          <a className="start-switch" href={projectHref(key, "runs", "new")}>
            Switch to a full run
          </a>
        </div>
        <div className="start-field">
          <label htmlFor="quick-goal" className="start-legend">
            What should change?
          </label>
          <textarea
            id="quick-goal"
            className="start-goal"
            rows={3}
            value={prompt}
            placeholder="Fix the off-by-one in the usage table header"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className="mono start-hint">
            {feature ? `feature ${feature}` : "The feature ID comes from the text."}
          </span>
        </div>

        {definition && (
          <ol aria-label="Stages" className="start-stages">
            {definition.stages.map((stage) => (
              <li key={stage} className="start-stage">
                {stageLabel(stage)}
              </li>
            ))}
          </ol>
        )}
        {definitions.value && !definition && (
          <div className="banner error">This project has no quick workflow.</div>
        )}

        <BudgetPicker value={budget} onChange={setBudget} policy={policy} base={limits.base} />

        {launcher.error && <div className="banner error">{launcher.error}</div>}
        <div className="start-inline">
          <button type="submit" className="btn-primary start-submit" disabled={!canStart}>
            {launcher.starting ? "Starting…" : "Plan it"}
          </button>
          <span className="start-hint" aria-live="polite">
            Plans the change and waits for your approval before it writes anything.
            {preRun.doctor ? ` ${doctorLine(preRun.doctor)}.` : ""}
          </span>
        </div>
      </form>

      <div className="start-quick-panels">
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
