import { useEffect, useMemo, useState } from "react";
import {
  type DefinitionSummary,
  MAX_WRITERS,
  start,
  type WorkflowProposal,
} from "../../client/start.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { CHECK } from "../../lib/styles.js";
import { lineOf } from "../runs/line-model.js";
import type { SectionProps } from "../sections.js";
import { takeDraft } from "./drafts.js";
import {
  BudgetPicker,
  budgetField,
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
  presetLimits,
  RunStarting,
  SUBMIT,
  TITLE,
  usePolicy,
  useStartRun,
} from "./form.js";
import {
  type BudgetPreset,
  FIT_TEXT,
  featureSlug,
  fitOf,
  isFeatureId,
  proposalText,
  rangeText,
  stageLabel,
} from "./logic.js";
import {
  DoctorPanel,
  doctorLine,
  EstimatePanel,
  message,
  RoutePanel,
  useLoad,
  usePreRun,
  useRoute,
} from "./panels.js";
import { routeModels, routeRows } from "./route-logic.js";

/** The workflows offered first, with the line each card gives. */
const MAIN_WORKFLOWS: [string, string][] = [
  ["quick", "Small, located change: plan, approve, build, check."],
  ["standard", "Research and a spec first, then build, check and review."],
  ["sdd", "The full flow, with analysis, convergence and learning."],
];

const STEP_HEAD = "m-0 flex items-center gap-2 text-[15px] font-bold";
const STEP_NUM =
  "inline-grid size-6 place-items-center rounded-full border-2 border-border bg-main font-mono text-[12px] text-main-foreground";

async function loadModels(key: string): Promise<string[]> {
  const profiles = await start.profiles(key);
  return [...new Set(profiles.map((p) => p.route.model).filter(Boolean))].sort();
}

/** A workflow's stations as a row of small blocks; approvals a person gives are round. */
function MiniLine({ definition }: { definition: DefinitionSummary }) {
  const line = lineOf(definition.stages, definition.line);
  return (
    <span className="flex items-center" aria-hidden="true">
      {line.stages.map((stage, i) => (
        <span key={stage.id} className="flex flex-1 items-center last:flex-none">
          <span
            title={stageLabel(stage.id)}
            className={cn(
              "size-3 flex-none border-2 border-border",
              stage.human ? "rounded-full bg-fill-warn" : "rounded-[3px] bg-raised",
            )}
          />
          {i < line.stages.length - 1 && <span className="h-[2px] min-w-1 flex-1 bg-border" />}
        </span>
      ))}
    </span>
  );
}

function RecipeCard({
  definition,
  note,
  chosen,
  onChange,
}: {
  definition: DefinitionSummary;
  note: string;
  chosen: boolean;
  onChange: (definition: DefinitionSummary) => void;
}) {
  return (
    <button
      type="button"
      className="flex cursor-pointer flex-col gap-2 rounded-base border-2 border-border bg-background px-3 py-[10px] text-left [font:inherit] text-foreground shadow-sm-hard transition-transform duration-75 hover:-translate-y-px motion-reduce:transition-none aria-pressed:bg-main aria-pressed:text-main-foreground aria-pressed:shadow-shadow"
      aria-pressed={chosen}
      onClick={() => onChange(definition)}
    >
      <span className="font-mono text-[13px] font-bold">
        {definition.id}
        {definition.source === "project" ? " (project)" : ""}
      </span>
      <MiniLine definition={definition} />
      <span className={cn("text-[12px]", chosen ? "" : "text-muted-foreground")}>{note}</span>
    </button>
  );
}

export function RecipeChoice({
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
  const [showMore, setShowMore] = useState(() => more.some((d) => d.id === value));
  return (
    <fieldset className={FIELDSET}>
      <legend className="sr-only">Workflow</legend>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
        {main.map(({ definition, note }) => (
          <RecipeCard
            key={definition.id}
            definition={definition}
            note={note}
            chosen={value === definition.id}
            onChange={onChange}
          />
        ))}
        {showMore &&
          more.map((definition) => (
            <RecipeCard
              key={definition.id}
              definition={definition}
              note={definition.description}
              chosen={value === definition.id}
              onChange={onChange}
            />
          ))}
      </div>
      {more.length > 0 && (
        <Button
          variant="secondary"
          size="md"
          className="self-start"
          aria-expanded={showMore}
          onClick={() => setShowMore(!showMore)}
        >
          {showMore ? "Fewer workflows" : `More workflows (${more.length})`}
        </Button>
      )}
      {chosen && (
        <span className={`font-mono ${HINT}`}>{chosen.stages.map(stageLabel).join(" → ")}</span>
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
  const [issue, setIssue] = useState("");
  const [workflow, setWorkflow] = useState("sdd");
  const [budget, setBudget] = useState<BudgetPreset>("standard");
  const [worktree, setWorktree] = useState(false);
  const [writers, setWriters] = useState(1);
  // Null follows the configured policy; the checkbox overrides it for this run.
  const [assumeOverride, setAssume] = useState<boolean | null>(null);
  const [warnOverride, setWarn] = useState<boolean | null>(null);
  const [strict, setStrict] = useState(false);
  const [model, setModel] = useState("");
  const [showReadiness, setShowReadiness] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The proposal from the request picks the recipe and budget until the person picks one.
  const [proposal, setProposal] = useState<WorkflowProposal | null>(null);
  const [workflowPicked, setWorkflowPicked] = useState(false);
  const [budgetPicked, setBudgetPicked] = useState(false);

  const definitions = useLoad(key, "definitions", start.definitions);
  const models = useLoad(key, "profile-models", loadModels);
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
  const route = useRoute(key, workflow, model);
  const launcher = useStartRun(key);
  const assume = assumeOverride ?? policy.policy?.clarification === "assume";
  const warnTests = warnOverride ?? policy.policy?.testIntegrity === "warn";

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
  // An invalid feature ID blocks the start, so the settings that hold it open.
  const featureWrong = feature !== "" && !featureValid;
  useEffect(() => {
    if (featureWrong) setSettingsOpen(true);
  }, [featureWrong]);

  // A backend without `preset-proposal` answers 404; the form then works as before.
  useEffect(() => {
    const text = prompt.trim();
    if (!text || fromIssue) {
      setProposal(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      start.propose(key, text).then(
        (next) => live && setProposal(next),
        () => live && setProposal(null),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, prompt, fromIssue]);
  // applyWorkflow only sets state; the proposal and the pick flags decide when this runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyWorkflow is recreated each render
  useEffect(() => {
    if (!proposal) return;
    const proposed = definitions.value?.find((d) => d.id === proposal.workflowId);
    if (!workflowPicked && proposed) applyWorkflow(proposed);
    if (!budgetPicked) setBudget(proposal.budget);
  }, [proposal, definitions.value, workflowPicked, budgetPicked]);

  const pickWorkflow = (next: DefinitionSummary): void => {
    setWorkflowPicked(true);
    applyWorkflow(next);
  };
  const applyWorkflow = (next: DefinitionSummary): void => {
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
    void launcher.run({
      ...(feature ? { feature } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(fromIssue ? { issue: issue.trim() } : {}),
      workflow,
      ...budgetField(budget),
      ...(model ? { model } : {}),
      ...(worktree ? { worktree: true } : {}),
      ...(writers > 1 ? { writers } : {}),
      // Sent only when changed here, so a backend without the field still starts the run.
      ...(assumeOverride !== null ? { clarification: assume ? "assume" : "ask" } : {}),
      ...(warnOverride !== null ? { testIntegrity: warnTests ? "warn" : "block" } : {}),
      ...(proposal ? { autoPreset: true } : {}),
      ...(strict ? { modelStrict: true } : {}),
    });
  };

  const ready = preRun.doctor?.ready;
  const fit = preRun.estimate ? fitOf(preRun.estimate.tokens, limits.cap) : null;
  const stageModels = route.route ? routeModels(routeRows(route.route)) : [];
  const settingsLine = [
    `${budget} budget`,
    writers > 1 ? `${writers} writers` : worktree ? "in a worktree" : "in place",
    assume ? "assumptions on" : "questions wait for you",
    ...(warnTests ? ["test guard warns only"] : []),
    model || "default model",
    ...(strict ? ["run model overrides routes"] : []),
  ].join(" · ");

  return (
    <form className={`${FORM} max-w-[980px]`} onSubmit={submit} aria-labelledby="new-run-title">
      <h2 id="new-run-title" className={TITLE}>
        New workflow run
      </h2>

      <section className={FIELD} aria-labelledby="new-run-step-1">
        <h3 id="new-run-step-1" className={STEP_HEAD}>
          <span className={STEP_NUM}>1</span>What to bake
        </h3>
        <label htmlFor="new-run-goal" className={LEGEND}>
          What should change?
        </label>
        <textarea
          id="new-run-goal"
          className={GOAL}
          rows={3}
          value={prompt}
          placeholder="Describe what should change and how you will know it works."
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="new-run-issue" className={HINT}>
            Or start from a GitHub issue
          </label>
          <input
            id="new-run-issue"
            type="text"
            className="max-w-[360px] flex-1"
            value={issue}
            placeholder="issue URL, owner/name#N or #N"
            aria-describedby="new-run-issue-hint"
            onChange={(e) => setIssue(e.target.value)}
          />
        </div>
        {fromIssue && (
          <span id="new-run-issue-hint" className={HINT}>
            The issue's title and body are the goal; text above adds instructions. The delivered
            pull request closes the issue.
          </span>
        )}
      </section>

      <section className={FIELD} aria-labelledby="new-run-step-2">
        <h3 id="new-run-step-2" className={STEP_HEAD}>
          <span className={STEP_NUM}>2</span>Recipe
        </h3>
        {definitions.error ? (
          <Alert tone="error">Workflows: {message(definitions.error)}</Alert>
        ) : definitions.value ? (
          <>
            <RecipeChoice
              definitions={definitions.value}
              value={workflow}
              onChange={pickWorkflow}
            />
            {proposal && <span className={HINT}>{proposalText(proposal, workflow)}</span>}
          </>
        ) : (
          <Skeleton lines={2} label="Loading workflows" />
        )}
      </section>

      <section className={FIELD} aria-labelledby="new-run-step-3">
        <h3 id="new-run-step-3" className={STEP_HEAD}>
          <span className={STEP_NUM}>3</span>Bake
        </h3>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-base border-2 border-border px-3 py-[10px] text-[13px]",
            ready === true
              ? "bg-fill-ok text-main-foreground"
              : ready === false
                ? "bg-fill-err text-main-foreground"
                : "bg-background text-soft-foreground",
          )}
          aria-live="polite"
        >
          <b>
            {ready === true ? "Ready to bake" : ready === false ? "Not ready yet" : "Checking…"}
          </b>
          {preRun.doctor && <span>{doctorLine(preRun.doctor)}</span>}
          {preRun.doctorError && <span>Doctor: {preRun.doctorError}</span>}
          {preRun.estimate && (
            <span>
              Estimate {rangeText(preRun.estimate.tokens)} tokens
              {fit ? `, ${limits.cap === null ? "no token cap" : FIT_TEXT[fit]}` : ""}
            </span>
          )}
          {stageModels.length > 1 && <span>{stageModels.length} models across the stages</span>}
          <Button
            variant="secondary"
            size="md"
            className="ml-auto"
            aria-expanded={showReadiness}
            aria-controls="new-run-readiness"
            onClick={() => setShowReadiness(!showReadiness)}
          >
            {showReadiness ? "Hide details" : "Details"}
          </Button>
        </div>
        {showReadiness && (
          <div
            id="new-run-readiness"
            className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-4"
          >
            <DoctorPanel
              report={preRun.doctor}
              error={preRun.doctorError}
              loading={preRun.loading}
            />
            <EstimatePanel
              estimate={preRun.estimate}
              error={preRun.estimateError}
              loading={preRun.loading}
              cap={limits.cap}
              checkpoint={limits.checkpoint}
            />
            <RoutePanel state={route} />
          </div>
        )}

        <details
          className="rounded-base border-2 border-border bg-background"
          open={settingsOpen}
          onToggle={(e) => setSettingsOpen(e.currentTarget.open)}
        >
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-[10px] font-bold">
            Oven settings
            <span className="text-[12px] font-normal text-muted-foreground">{settingsLine}</span>
          </summary>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-6 px-3 pt-1 pb-4">
            <BudgetPicker
              value={budget}
              onChange={(next) => {
                setBudgetPicked(true);
                setBudget(next);
              }}
              policy={policy}
              base={limits.base}
            />
            <fieldset className={FIELDSET}>
              <legend className={LEGEND}>Mode and writers</legend>
              <label className={CHECK}>
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
            <fieldset className={FIELDSET}>
              <legend className={LEGEND}>Open questions</legend>
              <label className={CHECK}>
                <input
                  type="checkbox"
                  checked={assume}
                  onChange={(e) => setAssume(e.target.checked)}
                />
                Settle them with recorded assumptions
              </label>
              <span className={HINT}>
                {assume
                  ? "The agents pick conventional defaults and list them at approval; only questions without a safe default wait for you."
                  : "The run waits for your answers to blocking questions."}
              </span>
            </fieldset>
            <fieldset className={FIELDSET}>
              <legend className={LEGEND}>Test integrity</legend>
              <label className={CHECK}>
                <input
                  type="checkbox"
                  checked={warnTests}
                  onChange={(e) => setWarn(e.target.checked)}
                />
                Only warn about test gaming
              </label>
              <span className={HINT}>
                {warnTests
                  ? "Deleted, skipped or weakened tests and new suppressions in a task are recorded, not repaired."
                  : "Deleted, skipped or weakened tests and new suppressions in a task are sent back for repair."}
              </span>
            </fieldset>
            <div className={FIELD}>
              <label htmlFor="new-run-feature" className={LEGEND}>
                Feature ID
              </label>
              <input
                id="new-run-feature"
                type="text"
                className="aria-[invalid=true]:border-[color:var(--err)]"
                value={feature}
                placeholder={fromIssue ? "issue-N-title, from the issue" : "derived from the goal"}
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
            <div className={FIELD}>
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
              <label className={CHECK}>
                <input
                  type="checkbox"
                  checked={strict}
                  onChange={(e) => setStrict(e.target.checked)}
                />
                Run model overrides configured routes
              </label>
              <span className={HINT}>
                {strict
                  ? "Every role and stage uses the run model, whatever Model routing says."
                  : "Roles and stages with a configured route keep it."}
              </span>
            </div>
          </div>
        </details>
      </section>

      <RunStarting projectKey={project.key} starting={launcher.starting} />
      {launcher.error && <Alert tone="error">{launcher.error}</Alert>}
      <div className={INLINE}>
        <Button type="submit" variant="primary" size="md" className={SUBMIT} disabled={!canStart}>
          {launcher.starting ? "Starting…" : "Start run"}
        </Button>
        <span className={HINT}>
          Everything in Oven settings has a default; most runs never need it.
        </span>
      </div>
    </form>
  );
}
