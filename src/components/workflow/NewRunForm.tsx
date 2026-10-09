import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { BUDGET_PRESETS } from "../../core/workflows/budget.js";
import type { BudgetPresetId, StartRunInput, WorkflowInfo } from "../../core/workflows/view.js";
import { Field, Hint, Section } from "../ui/index.js";
import {
  errorHint,
  estimateFit,
  featureSlug,
  formatDuration,
  formatTokens,
  isFeatureId,
} from "./format.js";

const FIELDS = ["prompt", "feature", "workflow", "budget", "start"] as const;
type FieldId = (typeof FIELDS)[number];
const PRESETS: BudgetPresetId[] = [...BUDGET_PRESETS];

export function NewRunForm({
  active,
  info,
  model,
  initialPrompt,
  width,
  onStart,
  onCancel,
}: {
  active: boolean;
  info: WorkflowInfo | null;
  model: string | null;
  initialPrompt: string;
  width: number;
  onStart: (input: StartRunInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [focus, setFocus] = useState<FieldId>(initialPrompt ? "feature" : "prompt");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [feature, setFeature] = useState(initialPrompt ? featureSlug(initialPrompt) : "");
  const [featureTouched, setFeatureTouched] = useState(false);
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetPresetId>("standard");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflows = info?.workflows ?? ["sdd"];
  const workflowId = workflow ?? info?.defaultWorkflow ?? "sdd";
  const modelMissing = !model || model === "none";
  const checks = info?.policy.checks ?? [];
  const problems = [
    !prompt.trim() && "Describe the feature",
    !isFeatureId(feature) && "Feature ID: letters, digits, - and _ only",
    modelMissing && "Select a model (Esc, then Ctrl+L)",
  ].filter((p): p is string => typeof p === "string");

  const move = (delta: number): void =>
    setFocus((f) => FIELDS[(FIELDS.indexOf(f) + delta + FIELDS.length) % FIELDS.length] ?? f);
  const submit = async (): Promise<void> => {
    if (submitting) return;
    if (problems.length) {
      setError(problems[0] ?? null);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onStart({
        workflowId,
        featureId: feature,
        prompt: prompt.trim(),
        model: model ?? "",
        budget,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };
  const cycle = <T,>(list: T[], value: T, delta: number): T =>
    list[(list.indexOf(value) + delta + list.length) % list.length] ?? value;

  useKeyboard((evt) => {
    if (!active) return;
    if (evt.name === "escape") {
      evt.preventDefault();
      onCancel();
      return;
    }
    if (evt.ctrl && evt.name === "s") {
      evt.preventDefault();
      void submit();
      return;
    }
    if (evt.name === "tab" || evt.name === "down" || evt.name === "up") {
      evt.preventDefault();
      move(evt.name === "up" || (evt.name === "tab" && evt.shift) ? -1 : 1);
      return;
    }
    if (
      (focus === "workflow" || focus === "budget") &&
      (evt.name === "left" || evt.name === "right")
    ) {
      evt.preventDefault();
      const delta = evt.name === "left" ? -1 : 1;
      if (focus === "workflow") setWorkflow(cycle(workflows, workflowId, delta));
      else setBudget(cycle(PRESETS, budget, delta));
      return;
    }
    if (evt.name === "return" && (focus === "workflow" || focus === "budget")) {
      evt.preventDefault();
      move(1);
      return;
    }
    if (evt.name === "return" && focus === "start") {
      evt.preventDefault();
      void submit();
    }
  });

  const preset = info?.presets[budget];
  const fit = info?.estimate ? estimateFit(info.estimate, preset) : null;
  const inputW = Math.max(20, width - 8);
  const box = (focused: boolean) => ({
    borderStyle: "rounded" as const,
    border: true,
    borderColor: focused ? t.brand : t.brandDim,
    paddingX: 1,
    width: inputW,
    backgroundColor: t.bgPopup,
  });
  const shownError = error;
  const hint = shownError ? errorHint(shownError) : null;
  return (
    <box flexDirection="column">
      <Section
        title="New workflow run"
        description="Describe the outcome; the agents research, specify and plan it for your approval."
      >
        <text fg={focus === "prompt" ? t.brand : t.textMuted}>
          What should be built or changed?
        </text>
        <box {...box(focus === "prompt")}>
          <input
            value={prompt}
            onInput={(value: string) => {
              setPrompt(value);
              if (!featureTouched) setFeature(value.trim() ? featureSlug(value) : "");
            }}
            onSubmit={() => move(1)}
            placeholder="e.g. Add a --json flag to `baked workflow status`"
            focused={active && focus === "prompt"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <text fg={focus === "feature" ? t.brand : t.textMuted}>
          {"Feature ID (artifacts go to specs/<id>)"}
        </text>
        <box {...box(focus === "feature")}>
          <input
            value={feature}
            onInput={(value: string) => {
              setFeature(value);
              setFeatureTouched(true);
            }}
            onSubmit={() => move(1)}
            placeholder="filled from the description"
            focused={active && focus === "feature"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <Field
          label="Workflow"
          labelWidth={10}
          focused={focus === "workflow"}
          value={`‹ ${workflowId} ›${workflows.length > 1 ? `  (${workflows.length} available)` : ""}`}
          keyHint="←/→"
        />
        <Field
          label="Budget"
          labelWidth={10}
          focused={focus === "budget"}
          value={`‹ ${budget} ›  ${preset ? `${preset.checkpointTokens ? `no token cap, pause every ${formatTokens(preset.checkpointTokens)}` : `${formatTokens(preset.maxTotalTokens)} tokens`} · ${preset.maxAgentCalls} calls · ${formatDuration(preset.maxActiveMs)}` : ""}`}
          keyHint="←/→"
        />
        <Field
          label="Model"
          labelWidth={10}
          value={modelMissing ? "none selected" : (model ?? "")}
        />
        <Field
          label="Checks"
          labelWidth={10}
          value={checks.length ? checks.map((c) => c.id).join(", ") : "none configured"}
        />
        <box height={1} />
        <box flexDirection="row">
          <text
            fg={focus === "start" ? t.bgPopup : t.brand}
            bg={focus === "start" ? t.brand : t.bgPopup}
            attributes={1}
          >
            {submitting ? " Starting… " : " ▶ Start run "}
          </text>
          <text fg={t.textFaint}>{"  Ctrl+S from any field"}</text>
        </box>
      </Section>
      {shownError ? <text fg={t.error}>{`✗ ${shownError}`}</text> : null}
      {hint ? <Hint kind="warn">{hint}</Hint> : null}
      {!shownError && problems.length && focus === "start" ? (
        <Hint kind="warn">{problems.join(" · ")}</Hint>
      ) : null}
      {modelMissing ? (
        <Hint kind="warn">
          No model selected in this tab. Press Esc twice, then Ctrl+L to choose one.
        </Hint>
      ) : null}
      {info?.estimate ? (
        <Hint kind={fit?.warn ? "warn" : "tip"}>{fit?.text ?? info.estimate.label}</Hint>
      ) : null}
      {!checks.length ? (
        <Hint kind="warn">
          No checks configured. Approval will be refused for automated criteria until checks exist.
        </Hint>
      ) : null}
      <Hint>Nothing in your source tree changes until you approve the plan.</Hint>
    </box>
  );
}
