import { useId, useState } from "react";
import { chat } from "../../client/chat.js";
import { insights } from "../../client/insights.js";
import { start } from "../../client/start.js";
import { GitInitDialog, needsGit } from "../../components/GitInitDialog.js";
import { Alert } from "../../components/ui/alert.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { ModelPicker, useModelCatalog } from "../../components/ui/model-picker.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { projectHref } from "../../router.js";
import { HINT, HINT_ERR } from "../start/form.js";
import { RecipeChoice } from "../start/NewRunScreen.js";
import { message, useLoad } from "../start/panels.js";
import { BudgetInputs, FormDialog } from "./InitiativeDialogs.js";
import { type BudgetFields, startBody, suggestInitiativeId } from "./initiative-model.js";

const FIELD = "flex min-w-0 flex-col gap-1.5";

/**
 * Starts an initiative: the core splits the request into features and waits for the split to be
 * approved. On success the new initiative opens.
 */
export function NewInitiativeDialog({
  projectKey,
  onClose,
}: {
  projectKey: string;
  onClose: (done: boolean) => void;
}) {
  const ids = useId();
  const [prompt, setPrompt] = useState("");
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState("sdd");
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState<BudgetFields | null>(null);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [tiered, setTiered] = useState<{ maxTasks: string; maxFiles: string } | null>(null);
  const [forecastStop, setForecastStop] = useState(false);
  const [keepFeatures, setKeepFeatures] = useState(false);
  const [splitCriticalPath, setSplitCriticalPath] = useState(false);
  const [askGit, setAskGit] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const definitions = useLoad(projectKey, "definitions", start.definitions);
  const models = useModelCatalog(projectKey, chat.models);
  const initiativeId = idEdit ?? suggestInitiativeId(prompt);
  const parsed = startBody({
    prompt,
    initiativeId,
    workflow,
    model,
    budget,
    budgetUsd,
    tiered,
    forecastStop,
    keepFeatures,
    splitCriticalPath,
  });
  return (
    <FormDialog
      title="New initiative"
      description="BAKED splits a large request into 3 to 12 features with contracts and dependencies, and picks the workflow and size of each. You approve the split before any feature run starts."
      submitLabel="Start initiative"
      problem={parsed.ok ? null : parsed.error}
      onSubmit={async () => {
        if (!parsed.ok) return;
        try {
          const view = await insights.startInitiative(projectKey, parsed.body);
          window.location.hash = projectHref(projectKey, "initiatives", view.initiativeId);
        } catch (e) {
          // Feature runs in worktrees need Git: offer to initialize it, then start again.
          if (needsGit(e)) setAskGit(true);
          throw e;
        }
      }}
      onClose={onClose}
    >
      <GitInitDialog
        projectKey={projectKey}
        open={askGit}
        why="This initiative runs its features in worktrees, which need Git with a first commit, and this folder has none."
        onDone={() => {
          setAskGit(false);
          if (!parsed.ok) return;
          setRetryError(null);
          insights.startInitiative(projectKey, parsed.body).then(
            (view) => {
              window.location.hash = projectHref(projectKey, "initiatives", view.initiativeId);
              onClose(true);
            },
            (e: unknown) => setRetryError(message(e)),
          );
        }}
        onClose={() => setAskGit(false)}
      />
      {retryError && <Alert tone="error">{retryError}</Alert>}
      <div className={FIELD}>
        <Label htmlFor={`${ids}-prompt`}>Request</Label>
        <Textarea
          id={`${ids}-prompt`}
          rows={4}
          value={prompt}
          placeholder="Describe the outcome and how you will know it works."
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      <div className={FIELD}>
        <Label htmlFor={`${ids}-id`}>Initiative ID</Label>
        <Input
          id={`${ids}-id`}
          className="font-mono"
          value={initiativeId}
          placeholder="derived from the request"
          onChange={(e) => setIdEdit(e.target.value)}
        />
        <span className={HINT}>Lowercase letters, digits and -, at most 40 characters.</span>
      </div>
      <div className={FIELD}>
        <span className="text-sm font-heading leading-none">Default workflow</span>
        <span className={HINT}>
          Each feature gets the workflow that fits it; a feature that names none uses this one.
        </span>
        {definitions.error ? (
          <span className={HINT_ERR}>Workflows: {message(definitions.error)}</span>
        ) : definitions.value ? (
          <RecipeChoice
            definitions={definitions.value}
            value={workflow}
            onChange={(d) => setWorkflow(d.id)}
          />
        ) : (
          <span className={HINT}>Loading workflows…</span>
        )}
      </div>
      <div className={FIELD}>
        <Label htmlFor={`${ids}-model`}>Model</Label>
        <ModelPicker
          id={`${ids}-model`}
          value={model}
          onChange={setModel}
          catalog={models.catalog}
          error={models.error}
          placeholder="project default"
        />
        <span className={HINT}>Empty uses the project's default model.</span>
      </div>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-sm font-heading leading-none">Shared budget</legend>
        <SegmentGroup aria-label="Shared budget">
          <Segment aria-pressed={budget === null} onClick={() => setBudget(null)}>
            Auto
          </Segment>
          <Segment
            aria-pressed={budget !== null}
            onClick={() => setBudget(budget ?? { tokens: "", calls: "", minutes: "" })}
          >
            Set limits
          </Segment>
        </SegmentGroup>
        {budget ? (
          <BudgetInputs value={budget} onChange={setBudget} idPrefix={`${ids}-budget`} />
        ) : (
          <span className={HINT}>
            The policy's per-run limits for each medium feature (half for a small one, double for a
            large one), plus one more. Each feature's share follows its size.
          </span>
        )}
        <div className={FIELD}>
          <Label htmlFor={`${ids}-usd`} className="text-[12px]">
            Dollar cap
          </Label>
          <Input
            id={`${ids}-usd`}
            inputMode="decimal"
            className="font-mono"
            value={budgetUsd}
            placeholder="like 40; empty sets none"
            onChange={(e) => setBudgetUsd(e.target.value)}
          />
          <span className={HINT}>
            Feature runs share it like the tokens. Once a feature is accepted, no feature starts
            while the projected total is above it.
          </span>
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Switch
            id={`${ids}-tiered`}
            checked={tiered !== null}
            onCheckedChange={(on) => setTiered(on ? { maxTasks: "5", maxFiles: "10" } : null)}
          />
          <Label htmlFor={`${ids}-tiered`}>Tiered approval</Label>
        </div>
        {tiered ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
            <div className={FIELD}>
              <Label htmlFor={`${ids}-tasks`} className="text-[12px]">
                Max tasks
              </Label>
              <Input
                id={`${ids}-tasks`}
                inputMode="numeric"
                className="font-mono"
                value={tiered.maxTasks}
                onChange={(e) => setTiered({ ...tiered, maxTasks: e.target.value })}
              />
            </div>
            <div className={FIELD}>
              <Label htmlFor={`${ids}-files`} className="text-[12px]">
                Max files
              </Label>
              <Input
                id={`${ids}-files`}
                inputMode="numeric"
                className="font-mono"
                value={tiered.maxFiles}
                onChange={(e) => setTiered({ ...tiered, maxFiles: e.target.value })}
              />
            </div>
          </div>
        ) : null}
        <span className={HINT}>
          {tiered
            ? "Feature plans within these limits that write only inside the feature's paths are approved without you; others wait. Needs a schema 1 workflow such as sdd."
            : "Every feature plan waits for your approval."}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Switch id={`${ids}-forecast`} checked={forecastStop} onCheckedChange={setForecastStop} />
          <Label htmlFor={`${ids}-forecast`}>Stop when the forecast is over the budget</Label>
        </div>
        <span className={HINT}>
          {forecastStop
            ? "No new feature starts while the low end of the re-forecast is above the shared budget; raise the budget or trim the split to go on."
            : "The forecast is shown; features start until the shared budget is used."}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Switch id={`${ids}-keep`} checked={keepFeatures} onCheckedChange={setKeepFeatures} />
          <Label htmlFor={`${ids}-keep`}>Keep small features apart</Label>
        </div>
        <span className={HINT}>
          {keepFeatures
            ? "Every feature the split proposes runs on its own, with the workflow it was given."
            : "Sibling features of one or two files with the same dependencies share one run, since each run pays its own research, spec, plan and review; a small feature nothing depends on runs quick."}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Switch
            id={`${ids}-path`}
            checked={splitCriticalPath}
            onCheckedChange={setSplitCriticalPath}
          />
          <Label htmlFor={`${ids}-path`}>Split the critical path</Label>
        </div>
        <span className={HINT}>
          {splitCriticalPath
            ? "A feature that holds more than a third of the longest chain of dependencies is split into parts that run side by side, unless the decomposer says why it stays whole. Each extra feature pays its own fixed stages."
            : "Features keep the boundaries the decomposer gave them, however long their chain."}
        </span>
      </div>
    </FormDialog>
  );
}
