import { useTheme } from "../../core/theme/index.js";
import type { CheckDetail } from "../../core/workflows/view.js";
import { formatDuration } from "./format.js";

export function ChecksView({
  checks,
  configured,
}: {
  checks: CheckDetail[];
  configured: string[];
}) {
  const t = useTheme();
  const seen = new Set(checks.map((c) => c.checkId));
  const notRun = configured.filter((id) => !seen.has(id));
  if (!checks.length && !notRun.length)
    return <text fg={t.textMuted}>No checks configured for this run.</text>;
  return (
    <box flexDirection="column">
      {checks.map((check) => {
        const passed = check.status === "passed";
        const stale = check.validity !== "current";
        const color = passed
          ? stale
            ? t.warning
            : t.success
          : check.status === "failed"
            ? t.error
            : t.warning;
        return (
          <box key={check.checkId} flexDirection="column" marginBottom={1}>
            <text fg={color} attributes={1}>
              {`${passed ? "✓" : check.status === "failed" ? "✗" : "?"} ${check.checkId}: ${check.status}`}
              <span fg={t.textFaint}>
                {`  ${formatDuration(check.durationMs)}${check.exitCode !== null ? ` · exit ${check.exitCode}` : ""}${check.runs > 1 ? ` · run ${check.runs} times` : ""}`}
              </span>
            </text>
            {stale ? (
              <text
                fg={t.warning}
              >{`  Evidence is ${check.validity}: files changed after this check ran.`}</text>
            ) : null}
            {!passed && check.reason && check.reason !== "exit" ? (
              <text fg={t.textMuted}>{`  Reason: ${check.reason.replaceAll("_", " ")}`}</text>
            ) : null}
            {check.outputTail ? (
              <box flexDirection="column" paddingLeft={2}>
                <text fg={t.textFaint}>Last output lines:</text>
                <text fg={t.textMuted}>{check.outputTail}</text>
              </box>
            ) : null}
          </box>
        );
      })}
      {notRun.map((id) => (
        <text key={id} fg={t.textFaint}>{`· ${id}: not run yet`}</text>
      ))}
    </box>
  );
}
