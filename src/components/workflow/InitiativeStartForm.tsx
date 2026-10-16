import { useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import {
  DEFAULT_TIERED_APPROVAL,
  type InitiativeStartInput,
  parseBudgetText,
  suggestInitiativeId,
} from "../../core/workflows/initiatives/forms.js";
import { InitiativeId } from "../../core/workflows/initiatives/plan.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { FocusTarget } from "../ui/FocusTarget.js";
import { Field, Hint, Section } from "../ui/index.js";
import { errorHint } from "./format.js";

const FIELDS = ["prompt", "id", "workflow", "budget", "tiered", "start"] as const;
type FieldId = (typeof FIELDS)[number];

/** The start form of an initiative: the request, its ID, workflow, shared budget and approval. */
export function InitiativeStartForm({
  active,
  initialPrompt = "",
  model,
  workflows,
  defaultWorkflow,
  taken,
  width,
  onStart,
  onCancel,
}: {
  active: boolean;
  /** Text typed before the form rendered. */
  initialPrompt?: string;
  /** The chat tab's model; feature runs start with it. */
  model: string | null;
  workflows: string[];
  defaultWorkflow: string;
  /** IDs of the project's initiatives, so the suggested ID is free. */
  taken: string[];
  width: number;
  onStart: (input: InitiativeStartInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [focus, setFocus] = useState<FieldId>("prompt");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [id, setId] = useState(() =>
    initialPrompt.trim() ? suggestInitiativeId(initialPrompt, taken) : "",
  );
  const [idTouched, setIdTouched] = useState(false);
  const [workflow, setWorkflow] = useState(defaultWorkflow);
  const [budget, setBudget] = useState("");
  const [tiered, setTiered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelMissing = !model || model === "none";
  const list = workflows.length ? workflows : [defaultWorkflow];

  const build = (): InitiativeStartInput => {
    if (!prompt.trim()) throw new Error("Describe the large request first");
    if (!InitiativeId.safeParse(id).success)
      throw new Error("Initiative ID: lowercase letters, digits and - only, up to 40 characters");
    if (modelMissing) throw new Error("Select a model (Esc, then Ctrl+L)");
    const { maxCostUsd, ...limits } = parseBudgetText(budget);
    const set = Object.keys(limits).length;
    if (set !== 0 && set !== 3)
      throw new Error("A shared budget needs tokens, calls and time, such as 8M 400 4h");
    return {
      initiativeId: id,
      prompt: prompt.trim(),
      workflow,
      ...(model ? { model } : {}),
      ...(limits.maxTotalTokens && limits.maxAgentCalls && limits.maxActiveMs
        ? {
            budget: {
              tokens: limits.maxTotalTokens,
              calls: limits.maxAgentCalls,
              timeMs: limits.maxActiveMs,
            },
          }
        : {}),
      ...(maxCostUsd !== undefined ? { budgetUsd: maxCostUsd } : {}),
      ...(tiered ? { tieredApproval: { ...DEFAULT_TIERED_APPROVAL } } : {}),
    };
  };
  const submit = async (): Promise<void> => {
    if (submitting) return;
    let input: InitiativeStartInput;
    try {
      input = build();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onStart(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };
  const move = (delta: number): void =>
    setFocus((f) => FIELDS[(FIELDS.indexOf(f) + delta + FIELDS.length) % FIELDS.length] ?? f);

  useKeyboard((evt) => {
    if (!active) return;
    const handled = (): true => {
      evt.preventDefault();
      return true;
    };
    if (evt.name === "escape" && handled()) onCancel();
    else if (evt.ctrl && evt.name === "s" && handled()) void submit();
    else if ((evt.name === "tab" || evt.name === "down" || evt.name === "up") && handled())
      move(evt.name === "up" || (evt.name === "tab" && evt.shift) ? -1 : 1);
    else if (focus === "workflow" && (evt.name === "left" || evt.name === "right") && handled()) {
      const at = list.indexOf(workflow);
      const delta = evt.name === "left" ? -1 : 1;
      setWorkflow(list[(at + delta + list.length) % list.length] ?? workflow);
    } else if (
      focus === "tiered" &&
      (evt.name === "left" || evt.name === "right" || evt.name === "space") &&
      handled()
    )
      setTiered((v) => !v);
    else if (evt.name === "return" && (focus === "workflow" || focus === "tiered") && handled())
      move(1);
    else if (evt.name === "return" && focus === "start" && handled()) void submit();
  });

  const box = (focused: boolean) => ({
    borderStyle: "rounded" as const,
    border: true,
    borderColor: focused ? t.brand : t.brandDim,
    paddingX: 1,
    width: Math.max(20, width - 8),
    backgroundColor: t.bgPopup,
  });
  const hint = error ? errorHint(error) : null;
  return (
    <box flexDirection="column">
      <Section
        title="New initiative"
        description="A large request split into 3 to 12 features. You review and approve the split before any feature runs."
      >
        <text fg={focus === "prompt" ? t.brand : t.textMuted}>What should be built?</text>
        <box {...box(focus === "prompt")}>
          <input
            value={prompt}
            onInput={(value: string) => {
              setPrompt(value);
              if (!idTouched) setId(value.trim() ? suggestInitiativeId(value, taken) : "");
            }}
            onSubmit={() => move(1)}
            placeholder="e.g. Move billing to the new payments API"
            focused={active && focus === "prompt"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <text fg={focus === "id" ? t.brand : t.textMuted}>Initiative ID</text>
        <box {...box(focus === "id")}>
          <input
            value={id}
            onInput={(value: string) => {
              setId(value);
              setIdTouched(true);
            }}
            onSubmit={() => move(1)}
            placeholder="filled from the request"
            focused={active && focus === "id"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <FocusTarget active={focus === "workflow"}>
          <Field
            label="Workflow"
            labelWidth={10}
            focused={focus === "workflow"}
            value={`‹ ${workflow} ›  each feature runs it`}
            keyHint="←/→"
          />
        </FocusTarget>
        <text fg={focus === "budget" ? t.brand : t.textMuted}>
          {
            "Shared budget: tokens calls time and/or $dollars (empty: derived from the policy and the split)"
          }
        </text>
        <box {...box(focus === "budget")}>
          <input
            value={budget}
            onInput={setBudget}
            onSubmit={() => move(1)}
            placeholder="e.g. 8M 400 4h"
            focused={active && focus === "budget"}
            backgroundColor={t.bgPopup}
          />
        </box>
        <FocusTarget active={focus === "tiered"}>
          <Field
            label="Approval"
            labelWidth={10}
            focused={focus === "tiered"}
            value={
              tiered
                ? `‹ tiered ›  specs up to ${DEFAULT_TIERED_APPROVAL.maxTasks} tasks and ${DEFAULT_TIERED_APPROVAL.maxFiles} files are approved for you`
                : "‹ every spec ›  you approve each feature's spec"
            }
            keyHint="←/→"
          />
        </FocusTarget>
        <Field
          label="Model"
          labelWidth={10}
          value={modelMissing ? "none selected" : (model ?? "")}
        />
        <box height={1} />
        <FocusTarget active={focus === "start"}>
          <box flexDirection="row">
            <text
              fg={focus === "start" ? t.bgPopup : t.brand}
              bg={focus === "start" ? t.brand : t.bgPopup}
              attributes={1}
            >
              {submitting ? " Starting… " : " ▶ Start initiative "}
            </text>
            <text fg={t.textFaint}>{"  Ctrl+S from any field"}</text>
          </box>
        </FocusTarget>
      </Section>
      {error ? <text fg={t.error}>{`✗ ${error}`}</text> : null}
      {hint ? <Hint kind="warn">{hint}</Hint> : null}
      {modelMissing ? (
        <Hint kind="warn">
          No model selected in this tab. Press Esc twice, then Ctrl+L to choose one.
        </Hint>
      ) : null}
      <Hint>The decomposer proposes the split first; nothing in your source tree changes yet.</Hint>
    </box>
  );
}
