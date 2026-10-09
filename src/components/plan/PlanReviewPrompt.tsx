import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import type { Plan } from "../../types/index.js";
import { KeyCaps } from "../ui/index.js";

interface Props {
  onAccept: () => void;
  onClearAndImplement: () => void;
  onRevise: (feedback: string) => void;
  onCancel: () => void;
  isActive: boolean;
  plan: Plan;
  planFile: string;
}

interface Option {
  id: string;
  label: string;
  icon: string;
  color: string;
}

export function PlanReviewPrompt({
  onAccept,
  onClearAndImplement,
  onRevise,
  onCancel,
  isActive,
  plan,
  planFile,
}: Props) {
  const t = useTheme();
  const ACCENT = t.info;
  const STEP_COLOR = t.brandAlt;
  const CANCEL_COLOR = t.brandSecondary;
  const allOptions: Option[] = useMemo(
    () => [
      { id: "implement", label: "Implement", icon: "\u23CE", color: ACCENT },
      { id: "clear_implement", label: "Clear & Implement", icon: "\u21BB", color: t.warning },
      { id: "revise", label: "Revise", icon: "\uF040", color: STEP_COLOR },
      { id: "cancel", label: "Cancel", icon: "\uF00D", color: CANCEL_COLOR },
    ],
    [ACCENT, STEP_COLOR, CANCEL_COLOR, t.warning],
  );
  const options = useMemo(() => {
    if (plan.depth === "light") {
      return allOptions.filter((o) => o.id !== "clear_implement");
    }
    return allOptions;
  }, [plan.depth, allOptions]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [reviseInput, setReviseInput] = useState("");
  const [typing, setTyping] = useState(false);

  useKeyboard((evt) => {
    if (!isActive) return;

    if (typing) {
      if (evt.name === "escape") {
        setTyping(false);
        evt.stopPropagation();
        evt.preventDefault();
      }
      return;
    }

    if (evt.name === "escape") {
      onCancel();
      evt.stopPropagation();
      evt.preventDefault();
      return;
    }

    if (evt.name === "up" || evt.name === "left") {
      setSelectedIdx((prev) => (prev > 0 ? prev - 1 : options.length - 1));
      evt.stopPropagation();
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || evt.name === "right" || evt.name === "tab") {
      setSelectedIdx((prev) => (prev + 1) % options.length);
      evt.stopPropagation();
      evt.preventDefault();
      return;
    }

    if (evt.name === "return") {
      const opt = options[selectedIdx];
      if (!opt) return;
      evt.stopPropagation();
      evt.preventDefault();
      switch (opt.id) {
        case "implement":
          onAccept();
          break;
        case "clear_implement":
          onClearAndImplement();
          break;
        case "revise":
          setTyping(true);
          setReviseInput("");
          break;
        case "cancel":
          onCancel();
          break;
      }
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor={ACCENT}
      paddingX={1}
      width="100%"
    >
      <box gap={1} flexDirection="row">
        <text fg={ACCENT} attributes={TextAttributes.BOLD}>
          {icon("plan")} {plan.title}
        </text>
        <text fg={t.textFaint}>{"\u2502"}</text>
        <text fg={t.textDim}>{String(plan.steps.length)} steps</text>
        <text fg={t.textFaint}>{"\u2502"}</text>
        <text fg={t.textDim}>{planFile}</text>
      </box>

      {plan.steps.length <= 5 ? (
        <box flexDirection="column">
          {plan.steps.map((step) => (
            <box key={step.id} height={1} flexShrink={0}>
              <text truncate>
                <span fg={t.textMuted}> ○ </span>
                <span fg={t.textSecondary}>{step.label}</span>
              </text>
            </box>
          ))}
        </box>
      ) : (
        <box flexDirection="row" width="100%">
          <box flexDirection="column" flexGrow={1} flexBasis={0}>
            {plan.steps.slice(0, Math.ceil(plan.steps.length / 2)).map((step) => (
              <box key={step.id} height={1} flexShrink={0}>
                <text truncate>
                  <span fg={t.textMuted}> ○ </span>
                  <span fg={t.textSecondary}>{step.label}</span>
                </text>
              </box>
            ))}
          </box>
          <text fg={t.textSubtle}> │ </text>
          <box flexDirection="column" flexGrow={1} flexBasis={0}>
            {plan.steps.slice(Math.ceil(plan.steps.length / 2)).map((step) => (
              <box key={step.id} height={1} flexShrink={0}>
                <text truncate>
                  <span fg={t.textMuted}> ○ </span>
                  <span fg={t.textSecondary}>{step.label}</span>
                </text>
              </box>
            ))}
          </box>
        </box>
      )}

      <box height={1} flexShrink={0} />

      {typing ? (
        <box flexDirection="row" gap={1}>
          <text fg={STEP_COLOR}>{" \u203A"}</text>
          <input
            value={reviseInput}
            onInput={setReviseInput}
            onSubmit={() => {
              if (reviseInput.trim()) {
                onRevise(reviseInput.trim());
                setReviseInput("");
              }
            }}
            focused={isActive}
            flexGrow={1}
            placeholder="what should change..."
          />
          <text fg={t.textMuted}>
            <span fg={t.brandSecondary} attributes={1}>
              ⏎
            </span>{" "}
            submit
            <span fg={t.textFaint}> │ </span>
            <span fg={t.brandSecondary} attributes={1}>
              esc
            </span>{" "}
            back
          </text>
        </box>
      ) : (
        <box flexDirection="column">
          {options.map((opt, i) => {
            const selected = i === selectedIdx;
            return (
              <text key={opt.id}>
                <span fg={selected ? opt.color : t.textMuted}>{selected ? " › " : "   "}</span>
                <span
                  fg={selected ? t.textPrimary : t.textSecondary}
                  attributes={selected ? TextAttributes.BOLD : undefined}
                >
                  {opt.icon} {opt.label}
                </span>
              </text>
            );
          })}
          <box paddingLeft={1}>
            <KeyCaps
              hints={[
                { key: "↑↓", label: "select" },
                { key: "Enter", label: "confirm" },
                { key: "Esc", label: "cancel" },
              ]}
            />
          </box>
        </box>
      )}
    </box>
  );
}
