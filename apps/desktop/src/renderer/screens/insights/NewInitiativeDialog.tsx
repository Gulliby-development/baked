import { useCallback, useId, useState } from "react";
import { chat } from "../../client/chat.js";
import { insights } from "../../client/insights.js";
import { start } from "../../client/start.js";
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
  const [tiered, setTiered] = useState<{ maxTasks: string; maxFiles: string } | null>(null);
  const definitions = useLoad(projectKey, start.definitions);
  const loadModels = useCallback(() => chat.models(projectKey), [projectKey]);
  const models = useModelCatalog(loadModels);
  const initiativeId = idEdit ?? suggestInitiativeId(prompt);
  const parsed = startBody({ prompt, initiativeId, workflow, model, budget, tiered });
  return (
    <FormDialog
      title="New initiative"
      description="BAKED splits a large request into 3 to 12 features with contracts and dependencies. You approve the split before any feature run starts."
      submitLabel="Start initiative"
      problem={parsed.ok ? null : parsed.error}
      onSubmit={async () => {
        if (!parsed.ok) return;
        const view = await insights.startInitiative(projectKey, parsed.body);
        window.location.hash = projectHref(projectKey, "initiatives", view.initiativeId);
      }}
      onClose={onClose}
    >
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
        <span className="text-sm font-heading leading-none">Workflow of each feature</span>
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
            The policy's per-run limits times the number of features plus one.
          </span>
        )}
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
    </FormDialog>
  );
}
