import { useTheme } from "../../core/theme/index.js";
import type { Check } from "../../core/workflows/types.js";
import { Hint, Section } from "../ui/index.js";

export function Onboarding({ checks, model }: { checks: Check[]; model: string | null }) {
  const t = useTheme();
  const modelMissing = !model || model === "none";
  return (
    <box flexDirection="column">
      <Section
        title="Workflows are off for this project"
        description="Spec-driven runs: research → spec → plan → your approval → code → checks → review."
      >
        <text fg={t.textPrimary}>
          Press E to enable them. This adds a "workflows" block to .baked/config.json:
        </text>
        <text fg={t.textMuted}>{"  · enabled: true, default workflow: sdd"}</text>
        <text fg={t.textMuted}>
          {"  · budget: 400k tokens, 80 agent calls, 60 min active time per run"}
        </text>
        {checks.length ? (
          <text fg={t.textMuted}>
            {`  · checks found in this project: ${checks.map((c) => `${c.executable} ${c.args.join(" ")}`).join(", ")}`}
          </text>
        ) : (
          <text fg={t.warning}>
            {"  · no test or lint commands found — press G to add checks before approving a run"}
          </text>
        )}
      </Section>
      {modelMissing ? (
        <Hint kind="warn">No model is selected in this tab. Close the panel and press Ctrl+L.</Hint>
      ) : (
        <Hint>{`Runs started here use this tab's model: ${model}`}</Hint>
      )}
      <Hint>
        Other settings in .baked/config.json are kept. Press G to edit the checks (gates) later.
      </Hint>
    </box>
  );
}
