import { useTheme } from "../../core/theme/index.js";
import type { RunGate } from "../../core/workflows/v2/line.js";
import type { StageView } from "../../core/workflows/view.js";
import { stageLabel } from "./format.js";

/** The stage whose gates the overview lists: the current one, else the last stage that has gates. */
export function gatesStage(
  stages: readonly StageView[],
  current: string | null,
  gates: Readonly<Record<string, RunGate[]>>,
): StageView | null {
  const now = stages.find((s) => s.id === current);
  if (now) return gates[now.id]?.length ? now : null;
  return stages.findLast((s) => (gates[s.id]?.length ?? 0) > 0) ?? null;
}

const OUTCOME: Record<string, string> = {
  passed: "passes",
  failed: "fails",
  changes_requested: "asks for changes",
  approved: "is approved",
  rejected: "is rejected",
};

/** Where a gate stands, in words: at the stage, or before the line moves on or goes back. */
export function gatePlace(gate: RunGate, stages: readonly StageView[], from: string): string {
  const t = gate.transition;
  if (!t) return "at this stage";
  if (t.to === "done") return "before the run finishes";
  const index = (id: string) => stages.findIndex((s) => s.id === id);
  const to = stages.find((s) => s.id === t.to);
  const name = to ? stageLabel(to.kind) : t.to;
  const outcome = OUTCOME[t.on] ?? t.on.replaceAll("_", " ");
  return index(t.to) <= index(from) && index(t.to) >= 0
    ? `when it ${outcome}, before going back to ${name}`
    : `when it ${outcome}, before ${name}`;
}

/** The last result of a gate in words. */
export function gateResultText(gate: RunGate): string {
  const last = gate.last;
  if (!last) return "not run yet";
  const tries = last.attempts > 1 ? ` after ${last.attempts} attempts` : "";
  return `${last.status}${tries}${last.flaky ? ", flaky" : ""}`;
}

export function gateGlyph(gate: RunGate): string {
  const status = gate.last?.status;
  if (!status) return "·";
  if (status === "passed") return gate.last?.flaky ? "~" : "✓";
  if (status === "failed") return gate.mode === "required" ? "✗" : "!";
  return "?";
}

const cut = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;

/** The gates of the current stage under the stage row: what each does, blocks or advises, last result. */
export function StageGates({
  stages,
  current,
  gates,
  width,
}: {
  stages: StageView[];
  current: string | null;
  gates: Readonly<Record<string, RunGate[]>>;
  width: number;
}) {
  const t = useTheme();
  const stage = gatesStage(stages, current, gates);
  if (!stage) return null;
  const list = gates[stage.id] ?? [];
  const room = Math.max(20, width - 4);
  return (
    <box flexDirection="column">
      <text fg={t.textSecondary}>{cut(`Gates of ${stageLabel(stage.kind)}`, room)}</text>
      {list.map((gate) => {
        const glyph = gateGlyph(gate);
        const fg =
          glyph === "✓"
            ? t.success
            : glyph === "✗"
              ? t.error
              : glyph === "·"
                ? t.textMuted
                : t.warning;
        const head = `${glyph} ${gate.id} · ${gate.mode === "required" ? "blocks" : "advises"} · ${gateResultText(gate)}`;
        return (
          <box key={`${gate.id}:${gate.transition?.id ?? "stage"}`} flexDirection="column">
            <text fg={fg}>{cut(head, room)}</text>
            <text fg={t.textFaint}>
              {cut(`  ${gate.does}, ${gatePlace(gate, stages, stage.id)}`, room)}
            </text>
          </box>
        );
      })}
    </box>
  );
}
