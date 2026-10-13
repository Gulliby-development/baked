import { useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { BUDGET_PRESETS } from "../../core/workflows/budget.js";
import {
  type ClarificationMode,
  clarificationOf,
  MAX_CONCURRENT_WRITERS,
} from "../../core/workflows/schemas.js";
import { type TestIntegrityMode, testIntegrityOf } from "../../core/workflows/test-integrity.js";
import {
  type BudgetPresetId,
  clampWriters,
  executionRequest,
  initialExecution,
  type StartRunInput,
  type WorkflowInfo,
} from "../../core/workflows/view.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { FocusTarget } from "../ui/FocusTarget.js";
import { Field, Hint, Section } from "../ui/index.js";
import {
  errorHint,
  estimateFit,
  featureSlug,
  formatDuration,
  formatTokens,
  isFeatureId,
} from "./format.js";

const FIELDS = [
  "prompt",
  "issue",
  "feature",
  "workflow",
  "budget",
  "execution",
  "writers",
  "clarification",
  "tests",
  "strict",
  "start",
] as const;
type FieldId = (typeof FIELDS)[number];
const PRESETS: BudgetPresetId[] = [...BUDGET_PRESETS];

export function NewRunForm({
  active,
  info,
  model,
  initialPrompt,
  initialWorkflow = null,
  width,
  onStart,
  onCancel,
  onEdit,
}: {
  active: boolean;
  info: WorkflowInfo | null;
  model: string | null;
  initialPrompt: string;
  /** The workflow preselected in the form; null starts on the project default. */
  initialWorkflow?: string | null;
  width: number;
  onStart: (input: StartRunInput) => Promise<void>;
  onCancel: () => void;
  /** Opens the workflow editor on the chosen definition. */
  onEdit?: (workflowId: string) => void;
}) {
  const t = useTheme();
  const [focus, setFocus] = useState<FieldId>(initialPrompt ? "feature" : "prompt");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [issue, setIssue] = useState("");
  const [feature, setFeature] = useState(initialPrompt ? featureSlug(initialPrompt) : "");
  const [featureTouched, setFeatureTouched] = useState(false);
  const [workflow, setWorkflow] = useState<string | null>(initialWorkflow);
  const [budget, setBudget] = useState<BudgetPresetId>("standard");
  // Null follows the chosen workflow's own execution mode; a toggle overrides it.
  const [worktreeOverride, setWorktreeOverride] = useState<boolean | null>(null);
  const [writers, setWriters] = useState<number | null>(null);
  // Null follows the policy; a toggle overrides it for this run.
  const [clarificationOverride, setClarification] = useState<ClarificationMode | null>(null);
  const [testsOverride, setTests] = useState<TestIntegrityMode | null>(null);
  // The run model replaces every configured route for this run (`--model-strict`).
  const [strict, setStrict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflows = info?.workflows ?? ["sdd"];
  const workflowId = workflow ?? info?.defaultWorkflow ?? "sdd";
  const definition = info?.definitions?.[workflowId];
  const modelMissing = !model || model === "none";
  const checks = info?.policy.checks ?? [];
  const initial = initialExecution(info, workflowId);
  const clarification = clarificationOverride ?? (info ? clarificationOf(info.policy) : "ask");
  const testIntegrity = testsOverride ?? (info ? testIntegrityOf(info.policy) : "block");
  const execution = {
    worktree: worktreeOverride ?? initial.worktree,
    writers: writers ?? initial.writers,
  };
  // The core's own refusal text; the start request would be refused with the same words.
  const worktreeRefusal = execution.worktree ? (definition?.worktreeRefusal ?? null) : null;
  const fromIssue = issue.trim() !== "";
  // With an issue and no feature typed, the core names the feature after the issue.
  const sentFeature = fromIssue && !featureTouched ? "" : feature;
  const problems = [
    !prompt.trim() && !fromIssue && "Describe the feature or give a GitHub issue",
    (sentFeature || !fromIssue) &&
      !isFeatureId(sentFeature) &&
      "Feature ID: letters, digits, - and _ only",
    modelMissing && "Select a model (Esc, then Ctrl+L)",
    worktreeRefusal,
  ].filter((p): p is string => typeof p === "string");
  // The writer count applies only to worktree execution, so navigation skips it otherwise.
  const fields = FIELDS.filter((f) => f !== "writers" || execution.worktree);

  const move = (delta: number): void =>
    setFocus(
      (f) => fields[(fields.indexOf(f) + delta + fields.length) % fields.length] ?? fields[0] ?? f,
    );
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
        featureId: sentFeature,
        prompt: prompt.trim(),
        ...(fromIssue ? { issue: issue.trim() } : {}),
        model: model ?? "",
        budget,
        ...executionRequest(execution),
        clarification,
        testIntegrity,
        ...(strict ? { modelStrict: true } : {}),
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
    const toggle =
      focus === "execution" || focus === "clarification" || focus === "tests" || focus === "strict";
    const choice = focus === "workflow" || focus === "budget" || toggle;
    if (
      (choice || focus === "writers") &&
      (evt.name === "left" || evt.name === "right" || (toggle && evt.name === "space"))
    ) {
      evt.preventDefault();
      const delta = evt.name === "left" ? -1 : 1;
      if (focus === "workflow") {
        setWorkflow(cycle(workflows, workflowId, delta));
        setWorktreeOverride(null);
      } else if (focus === "budget") setBudget(cycle(PRESETS, budget, delta));
      else if (focus === "execution") setWorktreeOverride(!execution.worktree);
      else if (focus === "clarification")
        setClarification(clarification === "assume" ? "ask" : "assume");
      else if (focus === "tests") setTests(testIntegrity === "warn" ? "block" : "warn");
      else if (focus === "strict") setStrict(!strict);
      else setWriters(clampWriters(execution.writers + delta));
      return;
    }
    if (focus === "workflow" && evt.name === "e" && onEdit) {
      evt.preventDefault();
      onEdit(workflowId);
      return;
    }
    if (evt.name === "return" && (choice || focus === "writers")) {
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
        <text fg={focus === "issue" ? t.brand : t.textMuted}>
          {"GitHub issue (optional; the delivered PR closes it)"}
        </text>
        <box {...box(focus === "issue")}>
          <input
            value={issue}
            onInput={setIssue}
            onSubmit={() => move(1)}
            placeholder="issue URL, owner/name#N or #N; the description above adds to it"
            focused={active && focus === "issue"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <text fg={focus === "feature" ? t.brand : t.textMuted}>
          {"Feature ID (artifacts go to specs/<id>)"}
        </text>
        <box {...box(focus === "feature")}>
          <input
            value={sentFeature}
            onInput={(value: string) => {
              setFeature(value);
              setFeatureTouched(true);
            }}
            onSubmit={() => move(1)}
            placeholder={
              fromIssue ? "issue-N-title, from the issue" : "filled from the description"
            }
            focused={active && focus === "feature"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <FocusTarget active={focus === "workflow"}>
          <Field
            label="Workflow"
            labelWidth={10}
            focused={focus === "workflow"}
            value={`‹ ${workflowId} ›${workflows.length > 1 ? `  (${workflows.length} available)` : ""}`}
            keyHint={onEdit ? "←/→ · E edit" : "←/→"}
          />
        </FocusTarget>
        {definition ? (
          <Field
            label="Stages"
            labelWidth={10}
            value={`${definition.stages.join(" → ")}${definition.writes ? "" : "  · no file will change"}`}
          />
        ) : null}
        <FocusTarget active={focus === "budget"}>
          <Field
            label="Budget"
            labelWidth={10}
            focused={focus === "budget"}
            value={`‹ ${budget} ›  ${preset ? `${preset.checkpointTokens ? `no token cap, pause every ${formatTokens(preset.checkpointTokens)}` : `${formatTokens(preset.maxTotalTokens)} tokens`} · ${preset.maxAgentCalls} calls · ${formatDuration(preset.maxActiveMs)}` : ""}`}
            keyHint="←/→"
          />
        </FocusTarget>
        <FocusTarget active={focus === "execution"}>
          <Field
            label="Mode"
            labelWidth={10}
            focused={focus === "execution"}
            value={
              worktreeRefusal
                ? `‹ worktree › refused: ${worktreeRefusal}`
                : execution.worktree
                  ? "‹ worktree ›  own branch; working copy untouched"
                  : "‹ inline ›  edits your working copy"
            }
            keyHint="←/→"
          />
        </FocusTarget>
        <FocusTarget active={focus === "writers"}>
          <Field
            label="Writers"
            labelWidth={10}
            focused={focus === "writers"}
            value={
              execution.worktree
                ? `‹ ${execution.writers} › of ${MAX_CONCURRENT_WRITERS}${execution.writers > 1 ? "  tasks at once, own worktrees" : "  one task at a time"}`
                : "1  (more needs worktree mode)"
            }
            keyHint="←/→"
          />
        </FocusTarget>
        <FocusTarget active={focus === "clarification"}>
          <Field
            label="Questions"
            labelWidth={10}
            focused={focus === "clarification"}
            value={
              clarification === "assume"
                ? "‹ assume ›  agents record defaults; you review them at approval"
                : "‹ ask ›  the run waits for your answers"
            }
            keyHint="←/→"
          />
        </FocusTarget>
        <FocusTarget active={focus === "tests"}>
          <Field
            label="Tests"
            labelWidth={10}
            focused={focus === "tests"}
            value={
              testIntegrity === "warn"
                ? "‹ warn ›  test gaming in a task is only recorded"
                : "‹ block ›  deleted, skipped or weakened tests are repaired"
            }
            keyHint="←/→"
          />
        </FocusTarget>
        <Field
          label="Model"
          labelWidth={10}
          value={modelMissing ? "none selected" : (model ?? "")}
        />
        <FocusTarget active={focus === "strict"}>
          <Field
            label="Routes"
            labelWidth={10}
            focused={focus === "strict"}
            value={
              strict
                ? "‹ run model only ›  overrides every configured route"
                : "‹ configured ›  roles and stages use their routes"
            }
            keyHint="←/→"
          />
        </FocusTarget>
        <Field
          label="Checks"
          labelWidth={10}
          value={checks.length ? checks.map((c) => c.id).join(", ") : "none configured"}
        />
        <box height={1} />
        <FocusTarget active={focus === "start"}>
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
        </FocusTarget>
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
      {worktreeRefusal ? (
        <Hint kind="warn">{`Worktree execution is refused: ${worktreeRefusal}`}</Hint>
      ) : null}
      {definition?.problems.length ? (
        <Hint kind="warn">{`This workflow cannot start: ${definition.problems.slice(0, 2).join(" · ")}`}</Hint>
      ) : null}
      <Hint>
        {definition && !definition.writes
          ? "This workflow only reads: no file in your source tree changes."
          : "Nothing in your source tree changes until you approve the plan."}
      </Hint>
    </box>
  );
}
