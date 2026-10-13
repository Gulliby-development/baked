import { useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { WorkflowLine } from "../../core/workflows/v2/line.js";
import {
  FAMILY_LABEL,
  familyOf,
  frameAt,
  lineText,
  narrate,
  SCENARIO_LABEL,
  scenariosFor,
  type WalkState,
  walkthrough,
} from "../../core/workflows/v2/walkthrough.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { PremiumPopup } from "../ui/index.js";

/** What the screen needs of each definition (`WorkflowInfo.definitions`). */
export interface WorkflowListEntry {
  id: string;
  description?: string;
  stages: string[];
  line?: WorkflowLine;
  writes: boolean;
  problems: string[];
}

const GLYPH: Record<WalkState, string> = { pending: "○", current: "●", done: "✓", failed: "✗" };

/**
 * The workflows a run can start from, each with its family and its line of stations, and a
 * step-through of a run along the selected one: everything passes, a check fails once, or the
 * review asks for changes. Static text, like `/graph`; E opens the definition editor.
 */
export function WorkflowsPopup({
  definitions,
  width,
  height,
  onBack,
  onEdit,
}: {
  definitions: WorkflowListEntry[];
  width: number;
  height: number;
  onBack: () => void;
  onEdit: (id: string) => void;
}) {
  const t = useTheme();
  const [cursor, setCursor] = useState(0);
  const [walking, setWalking] = useState(false);
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [step, setStep] = useState(0);
  const selected = definitions[Math.min(cursor, definitions.length - 1)];
  const line = useMemo<WorkflowLine>(() => selected?.line ?? { stages: [], loops: [] }, [selected]);
  const scenarios = scenariosFor(line);
  const scenario = scenarios[scenarioIndex % scenarios.length] ?? "happy";
  const walk = useMemo(() => walkthrough(line, scenario), [line, scenario]);
  const last = Math.max(0, walk.events.length - 1);

  useKeyboard((event) => {
    const key = event.name.toLowerCase();
    if (key === "escape") {
      event.preventDefault();
      if (walking) setWalking(false);
      else onBack();
      return;
    }
    if (key === "e" && selected) {
      event.preventDefault();
      onEdit(selected.id);
      return;
    }
    if (walking) {
      if (key === "left" || key === "right") {
        event.preventDefault();
        setStep((s) => Math.max(0, Math.min(last, s + (key === "left" ? -1 : 1))));
      } else if (key === "s") {
        event.preventDefault();
        setScenarioIndex((i) => (i + 1) % scenarios.length);
        setStep(0);
      } else if (key === "home" || key === "r") {
        event.preventDefault();
        setStep(0);
      }
      return;
    }
    if ((key === "up" || key === "k" || key === "down" || key === "j") && definitions.length) {
      event.preventDefault();
      const delta = key === "up" || key === "k" ? -1 : 1;
      setCursor((c) => (c + delta + definitions.length) % definitions.length);
    } else if (key === "return" && selected?.line?.stages.length) {
      event.preventDefault();
      setWalking(true);
      setScenarioIndex(0);
      setStep(0);
    }
  });

  const innerW = width - 6;
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  const idW = Math.min(16, Math.max(6, ...definitions.map((d) => d.id.length)));
  const familyW = 18;
  const rows = Math.max(3, height - 12);
  const start = Math.max(0, Math.min(cursor - rows + 1, definitions.length - rows));

  if (walking && selected) {
    const frame = frameAt(walk, step);
    const story = narrate(walk, frame.event);
    const colour = (state: WalkState) =>
      state === "current"
        ? t.brand
        : state === "done"
          ? t.success
          : state === "failed"
            ? t.error
            : t.textFaint;
    return (
      <PremiumPopup
        visible
        title="Workflow"
        blurb={`${selected.id}: ${SCENARIO_LABEL[scenario]}`}
        width={width}
        height={height}
        footerHints={[
          { key: "←→", label: "step" },
          ...(scenarios.length > 1 ? [{ key: "S", label: "scenario" }] : []),
          { key: "R", label: "restart" },
          { key: "E", label: "edit" },
          { key: "Esc", label: "back" },
        ]}
      >
        <box flexDirection="column" paddingX={1}>
          <text wrapMode="word">
            {walk.stations.map((station, i) => {
              const state = frame.states[i] ?? "pending";
              const round = frame.rounds[i] ?? 0;
              return (
                <span key={station.id} fg={colour(state)}>
                  {`${GLYPH[state]} ${station.id}${round > 1 ? ` ×${round}` : ""}`}
                  {i < walk.stations.length - 1 ? <span fg={t.textSubtle}>{" → "}</span> : null}
                </span>
              );
            })}
          </text>
          {walk.loops.length ? (
            <text fg={t.textMuted}>
              {clip(
                `Repair loops: ${walk.loops.map((l) => `${l.from} ⟲ ${l.to}`).join(", ")}`,
                innerW,
              )}
            </text>
          ) : null}
          <text> </text>
          <text fg={t.textPrimary} attributes={1}>
            {story.title}
          </text>
          <text fg={t.textSecondary} wrapMode="word">
            {story.text}
          </text>
          <text> </text>
          <text fg={t.textMuted}>
            {`Step ${step + 1} of ${walk.events.length}${scenarios.length > 1 ? ` · S: ${scenarios.map((s) => SCENARIO_LABEL[s]).join(" / ")}` : ""}`}
          </text>
        </box>
      </PremiumPopup>
    );
  }

  return (
    <PremiumPopup
      visible
      title="Workflow"
      blurb="Workflows a run can start from"
      width={width}
      height={height}
      footerHints={[
        { key: "↑↓", label: "select" },
        { key: "Enter", label: "step through" },
        { key: "E", label: "edit" },
        { key: "Esc", label: "back" },
      ]}
    >
      <box flexDirection="column" paddingX={1}>
        {definitions.length ? null : <text fg={t.textMuted}>No workflow definitions found.</text>}
        {definitions.slice(start, start + rows).map((definition, k) => {
          const index = start + k;
          const active = index === cursor;
          const family = definition.line?.stages.length
            ? FAMILY_LABEL[familyOf({ line: definition.line, writes: definition.writes })]
            : "";
          const text = lineText({
            line: definition.line ?? { stages: [], loops: [] },
            stages: definition.stages,
          });
          return (
            <text key={definition.id} fg={active ? t.textPrimary : t.textSecondary}>
              <span fg={active ? t.brand : t.textFaint}>{active ? "› " : "  "}</span>
              <span attributes={active ? 1 : 0}>{definition.id.padEnd(idW).slice(0, idW)}</span>
              <span fg={t.textMuted}>{`  ${family.padEnd(familyW).slice(0, familyW)}  `}</span>
              <span fg={definition.problems.length ? t.error : undefined}>
                {clip(
                  definition.problems.length ? `✗ ${definition.problems[0]}` : text,
                  Math.max(10, innerW - idW - familyW - 6),
                )}
              </span>
            </text>
          );
        })}
        {selected?.description ? (
          <>
            <text> </text>
            <text fg={t.textMuted} wrapMode="word">
              {selected.description}
            </text>
          </>
        ) : null}
      </box>
    </PremiumPopup>
  );
}
