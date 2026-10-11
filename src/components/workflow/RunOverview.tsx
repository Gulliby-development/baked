import { useTheme } from "../../core/theme/index.js";
import type { RunSnapshot, WorkflowEvent } from "../../core/workflows/schemas.js";
import type { FindingRow, TaskRow } from "../../core/workflows/store.js";
import type { BudgetView, EstimateView, RunDetails, StageView } from "../../core/workflows/view.js";
import { Hint, ProgressBar } from "../ui/index.js";
import {
  clockTime,
  errorHint,
  estimateLines,
  eventText,
  formatDuration,
  formatTokens,
  headline,
  lastModel,
  stageGlyph,
  stageText,
} from "./format.js";

const ACTIVITY_ROWS = 8;

export function StagePipeline({
  stages,
  current,
  status,
}: {
  stages: StageView[];
  current: string | null;
  status: RunSnapshot["status"];
}) {
  const t = useTheme();
  return (
    <text wrapMode="word">
      {stages.map((stage, i) => {
        const isCurrent = stage.id === current;
        const glyph = stageGlyph(stage, isCurrent, status);
        const fg =
          stage.status === "failed"
            ? t.error
            : glyph === "⚑"
              ? t.warning
              : isCurrent
                ? t.brand
                : stage.status === "completed" || stage.status === "skipped"
                  ? t.success
                  : t.textFaint;
        return (
          <span key={stage.id} fg={fg}>
            {stageText(stage, isCurrent, glyph)}
            {i < stages.length - 1 ? <span fg={t.textSubtle}>{" › "}</span> : null}
          </span>
        );
      })}
    </text>
  );
}

export function RunOverview({
  snapshot,
  details,
  stages,
  budget,
  estimate,
  events,
  tasks,
  findings,
  checks,
  driving,
  driveError,
  width,
}: {
  snapshot: RunSnapshot;
  details: RunDetails | null;
  stages: StageView[];
  budget: BudgetView | null;
  estimate: EstimateView | null;
  events: WorkflowEvent[];
  tasks: TaskRow[];
  findings: FindingRow[];
  checks: { check_id: string; status: string; validity: string }[];
  driving: boolean;
  driveError: string | null;
  width: number;
}) {
  const t = useTheme();
  const { now, next } = headline(snapshot, stages, driving, budget);
  const liveTasks = tasks.filter((task) => task.status !== "invalidated");
  const done = liveTasks.filter((task) => ["implemented", "verified"].includes(task.status)).length;
  const criteria = details?.criteria ?? [];
  const passed = criteria.filter((c) => c.verdict === "pass").length;
  const openFindings = findings.filter((f) => ["open", "confirmed"].includes(f.status)).length;
  const latestChecks = new Map(checks.map((c) => [c.check_id, c]));
  const failedChecks = [...latestChecks.values()].filter((c) => c.status !== "passed").length;
  const model = lastModel(events);
  const activity = events
    .map((event) => ({ event, text: eventText(event, stages) }))
    .filter((row): row is { event: WorkflowEvent; text: string } => row.text !== null)
    .slice(-ACTIVITY_ROWS)
    .reverse();
  const barW = Math.max(30, Math.min(width - 4, 90));
  const pct = (a: number, b: number): number => (b > 0 ? (a / b) * 100 : 0);
  return (
    <box flexDirection="column">
      {details?.title ? (
        <text fg={t.textPrimary} attributes={1}>
          {details.title}
        </text>
      ) : (
        <text fg={t.textMuted}>{details?.prompt.split("\n")[0]?.slice(0, width - 4) ?? ""}</text>
      )}
      <text fg={snapshot.pendingRequestIds.length ? t.warning : t.textPrimary}>{now}</text>
      {next ? <text fg={t.brand}>{`→ ${next}`}</text> : null}
      {details?.autoApproval ? (
        <text fg={t.textMuted}>{`Approved automatically within: ${details.autoApproval}`}</text>
      ) : null}
      {!driveError && details?.lastError && ["blocked", "failed"].includes(snapshot.status) ? (
        <text fg={t.error}>{`✗ Last error: ${details.lastError}`}</text>
      ) : null}
      {driveError ? (
        <>
          <text fg={t.error}>{`✗ ${driveError}`}</text>
          {errorHint(driveError) ? <Hint kind="warn">{errorHint(driveError)}</Hint> : null}
        </>
      ) : null}
      <box height={1} />
      <StagePipeline stages={stages} current={snapshot.stageId} status={snapshot.status} />
      <box height={1} />
      {budget ? (
        <>
          <ProgressBar
            label="Tokens"
            labelWidth={12}
            width={barW}
            pct={pct(
              budget.tokens + budget.heldTokens + budget.inFlightTokens,
              budget.nextCheckpoint ?? budget.maxTokens,
            )}
            value={`${formatTokens(budget.tokens)} used${budget.heldTokens ? ` + ${formatTokens(budget.heldTokens)} held` : ""}${budget.inFlightTokens ? ` + ${formatTokens(budget.inFlightTokens)} in flight` : ""} / ${budget.nextCheckpoint ? `next checkpoint ${formatTokens(budget.nextCheckpoint)}` : formatTokens(budget.maxTokens)}`}
          />
          {budget.heldTokens ? (
            <Hint>
              Held: a failed or interrupted agent call has unknown usage, so its reservation still
              counts against the limit.
            </Hint>
          ) : null}
          <ProgressBar
            label="Agent calls"
            labelWidth={12}
            width={barW}
            pct={pct(budget.calls, budget.maxCalls)}
            value={`${budget.calls} / ${budget.maxCalls}`}
          />
          <ProgressBar
            label="Active time"
            labelWidth={12}
            width={barW}
            pct={pct(budget.activeMs, budget.maxActiveMs)}
            value={`${formatDuration(budget.activeMs)} / ${formatDuration(budget.maxActiveMs)}`}
          />
        </>
      ) : null}
      {estimateLines(estimate, stages).map((line) => (
        <text key={line.text} fg={line.tone === "warn" ? t.warning : t.textMuted}>
          {line.text}
        </text>
      ))}
      <text fg={t.textMuted}>
        {[
          `Tasks ${done}/${liveTasks.length}`,
          `Criteria ${passed}/${criteria.length}`,
          `Checks ${latestChecks.size ? `${latestChecks.size - failedChecks}/${latestChecks.size} passing` : "not run"}`,
          `Findings ${openFindings} open`,
          `Verification ${snapshot.verificationState.replace("_", " ")}`,
        ].join("  ·  ")}
      </text>
      {model ? <text fg={t.textFaint}>{`Model: ${model}`}</text> : null}
      <box height={1} />
      <text fg={t.textSecondary} attributes={1}>
        Activity
      </text>
      {activity.length ? (
        activity.map(({ event, text }) => (
          <text key={event.eventId} fg={event.type === "request.created" ? t.warning : t.textMuted}>
            <span fg={t.textFaint}>{`${clockTime(event.at)}  `}</span>
            {text}
          </text>
        ))
      ) : (
        <text fg={t.textFaint}>No activity yet.</text>
      )}
      <box height={1} />
      <text fg={t.textFaint}>{`Run ${snapshot.runId} · revision ${snapshot.revision}`}</text>
    </box>
  );
}
