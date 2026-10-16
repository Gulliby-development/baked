import { useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { approvalReviewText } from "../../core/workflows/auto-approval.js";
import { type PlanCost, planCostText } from "../../core/workflows/plan-cost.js";
import type { ApprovalReview, Decision } from "../../core/workflows/schemas.js";
import { activeTimeText, type SizingReport } from "../../core/workflows/sizing.js";
import type { RequestRow } from "../../core/workflows/store.js";
import type { Check } from "../../core/workflows/types.js";
import type { RunDetails } from "../../core/workflows/view.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { HardShadow } from "../ui/BrutalBox.js";
import { FocusTarget } from "../ui/FocusTarget.js";
import { Hint, Section } from "../ui/index.js";
import { formatTokens } from "./format.js";

interface ApprovalBody {
  writes?: { path: string; action: string }[];
  checks?: Check[];
  deferredCriteria?: string[];
  assumptions?: string[];
  /** Required checks that failed on the code the run starts from, before any task ran. */
  baselineFailures?: string[];
  /** Plan-time sizing's active-time estimate against the active-time cap. */
  activeTime?: SizingReport["activeTime"];
  /** What planning cost so far, by model, next to what the planned tasks should cost. */
  planCost?: PlanCost;
  /** Present when the plan and its reserve need more than the token ceiling: where it should stop. */
  budgetWarning?: string;
  requestCoverage?: RequestCoverageRow[];
  executionMode?: "inline" | "worktree";
  sandbox?: "auto" | "required";
  worktree?: { path: string; branch: string; baseHead: string; userChangesInScope: string[] };
  /** Why auto approval left the package to you, with the approval reviewer's verdict. */
  autoApproval?: { declined?: string[]; review?: ApprovalReview; reviewError?: string };
}
/** A deliverable of the request and what in the spec covers it (`request-coverage.ts`). */
interface RequestCoverageRow {
  deliverable: string;
  requirementIds: string[];
  criterionIds: string[];
  outOfScope: string | null;
  mapped: boolean;
}
interface ClarificationBody {
  questions?: { id?: string; question: string; blocking?: boolean }[];
  findings?: {
    id?: string;
    kind?: string;
    description?: string;
    refs?: string[];
    blocking?: boolean;
  }[];
}
/** One question the user can answer, normalized from research, spec or analysis requests. */
export interface ClarificationItem {
  key: string;
  label: string;
  text: string;
  blocking: boolean;
  refs: string[];
}
interface EvidenceBody {
  criterionId?: string;
  question?: string;
}
interface CheckpointBody {
  boundary?: number;
  interval?: number;
  projectedTokens?: number;
  usedTokens?: number;
  heldTokens?: number;
  calls?: number;
  stageId?: string;
}
interface ConvergenceBody {
  reason?: string;
  summary?: string;
  checksPassing?: boolean;
  criteria?: { total: number; passing: number; failing: { id: string }[] };
  findings?: {
    id: string;
    severity: string;
    file: string | null;
    symbol: string | null;
    claim: string;
  }[];
  contradictions?: { findingId: string; earlierId: string; earlierClaim: string }[];
  hostRule?: { decision: string; rules: string[]; why: string };
}
interface DeliveryBody {
  operations?: string[];
  remote?: { name: string; url: string };
  branch?: string;
  base?: { commit: string; branch: string };
  files?: string[];
  excluded?: { path: string; reason: string }[];
  userChanges?: string[];
  commitMessage?: string;
  pullRequest?: { title: string; base: string; draft: boolean } | null;
  /** A follow-up: the commit goes onto the branch and pull request of an earlier delivered run. */
  followUp?: { runId: string; pullRequest: { number: number; url: string } | null };
  /** Review threads of the followed pull request answered after the push. */
  reviewReplies?: { threads: { id: string; path: string }[]; resolve: boolean; body: string };
}
interface AcceptanceBody {
  acceptance?: {
    gateId: string;
    scenario: string;
    verdict: "passed" | "failed";
    expectations: {
      expectationId: string;
      verdict: string;
      stepIds: string[];
      explanation: string;
    }[];
    steps: { stepId: string; action: string; observation: string }[];
    testPath: string;
    testHash: string;
    testContent: string;
    assertions: { assertionId: string; expectationId: string; description: string }[];
    commandGateId: string;
    stableRuns: number;
  };
}
interface TestsFirstBody {
  testsFirst?: {
    mode: string;
    criteria: { id: string; text: string }[];
    tests: {
      taskId: string;
      title: string;
      criterionIds: string[];
      files: { path: string; content: string }[];
    }[];
  };
}
interface RecoveryBody {
  effectId?: string;
  intent?: Record<string, unknown>;
  note?: string;
}
const RESOLUTIONS = [
  { key: "1", value: "record-applied", label: "It ran and its effect is in place" },
  { key: "2", value: "record-not-applied", label: "It did not run / had no effect" },
  { key: "3", value: "retry", label: "Allow a new attempt" },
  { key: "4", value: "cancel", label: "Cancel the whole run (all its processes are stopped)" },
] as const;

function parse<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}
export function clarificationItems(body: ClarificationBody): ClarificationItem[] {
  if (body.questions?.length)
    return body.questions.map((q, i) => ({
      key: q.id ?? `Q${i + 1}`,
      label: "question",
      text: q.question,
      blocking: q.blocking === true,
      refs: [],
    }));
  if (body.findings?.length)
    return body.findings.map((f, i) => ({
      key: f.id ?? `F${i + 1}`,
      label: f.kind ?? "finding",
      text: f.description ?? JSON.stringify(f),
      blocking: f.blocking === true,
      refs: f.refs ?? [],
    }));
  return [{ key: "Q1", label: "question", text: "Clarify the request", blocking: true, refs: [] }];
}
/** Answer keys carry the question so the agents keep its meaning in the clarified prompt. */
export function clarificationAnswers(
  items: ClarificationItem[],
  answers: (string | undefined)[],
): Record<string, string> {
  return Object.fromEntries(
    items.flatMap((item, i) => {
      const answer = answers[i]?.trim();
      return answer ? [[`${item.key}: ${item.text.slice(0, 160)}`, answer]] : [];
    }),
  );
}
const flatten = (value: string): string => value.split(/\s+/).filter(Boolean).join(" ");
const MAX_REFS = 4;

export function DecisionPrompt({
  request,
  details,
  active,
  width = 80,
  onBack,
  onDecision,
}: {
  request: RequestRow;
  details: RunDetails | null;
  active: boolean;
  width?: number;
  onBack: () => void;
  onDecision: (decision: Decision) => void;
}) {
  const t = useTheme();
  const [text, setText] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [answers, setAnswers] = useState<string[]>([]);
  const [question, setQuestion] = useState(0);
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]["value"] | null>(null);
  const [passed, setPassed] = useState(true);
  const [confirmSend, setConfirmSend] = useState(false);

  const items =
    request.kind === "clarification" ? clarificationItems(parse(request.body_json)) : [];
  // The text being typed belongs to the current question until the user moves away from it.
  const currentAnswers = (): string[] => {
    const next = [...answers];
    next[question] = text;
    return next;
  };
  const goTo = (index: number): void => {
    const next = currentAnswers();
    setAnswers(next);
    setQuestion(index);
    setText(next[index] ?? "");
    setConfirmSend(false);
  };
  const sendAnswers = (all: string[]): void => {
    const filled = clarificationAnswers(items, all);
    if (!Object.keys(filled).length) return;
    const missingBlocking = items.filter((item, i) => item.blocking && !all[i]?.trim()).length;
    if (missingBlocking && !confirmSend) {
      setAnswers(all);
      setConfirmSend(true);
      return;
    }
    onDecision({ kind: "answer", requestId: request.id, answers: filled });
  };
  const inputFocused =
    active &&
    (rejecting ||
      request.kind === "clarification" ||
      request.kind === "manual_evidence" ||
      (request.kind === "recovery" && resolution !== null));

  useKeyboard((evt) => {
    if (!active) return;
    const key = evt.name.toLowerCase();
    if (key === "escape") {
      evt.preventDefault();
      if (rejecting) {
        setRejecting(false);
        setText("");
      } else onBack();
      return;
    }
    if (request.kind === "checkpoint") {
      if (key === "c" || key === "return") {
        evt.preventDefault();
        onDecision({ kind: "continue", requestId: request.id });
      } else if (key === "x") {
        evt.preventDefault();
        onDecision({
          kind: "reject",
          requestId: request.id,
          explanation: "Stopped at the token checkpoint",
        });
      }
      return;
    }
    if (request.kind === "convergence") {
      if (key === "a") {
        evt.preventDefault();
        onDecision({ kind: "accept", requestId: request.id });
      } else if (key === "c" || key === "return") {
        evt.preventDefault();
        onDecision({ kind: "continue", requestId: request.id });
      } else if (key === "x") {
        evt.preventDefault();
        onDecision({
          kind: "reject",
          requestId: request.id,
          explanation: "Stopped at the convergence decision",
        });
      }
      return;
    }
    if ((request.kind === "approval" || request.kind === "delivery") && !rejecting) {
      if (key === "a") {
        evt.preventDefault();
        // The prompt names the files whose uncommitted changes the worktree leaves out.
        const excluded =
          request.kind === "approval" &&
          (parse<ApprovalBody>(request.body_json).worktree?.userChangesInScope.length ?? 0) > 0;
        onDecision({
          kind: "approve",
          requestId: request.id,
          digest: request.digest,
          ...(excluded ? { userChanges: "exclude" as const } : {}),
        });
      }
      if (key === "x") {
        evt.preventDefault();
        setRejecting(true);
      }
      return;
    }
    if (request.kind === "clarification" && items.length > 1 && (key === "up" || key === "down")) {
      evt.preventDefault();
      goTo((question + (key === "up" ? items.length - 1 : 1)) % items.length);
      return;
    }
    if (request.kind === "clarification" && evt.ctrl && key === "s") {
      evt.preventDefault();
      sendAnswers(currentAnswers());
      return;
    }
    if (request.kind === "manual_evidence" && evt.ctrl && key === "t") {
      evt.preventDefault();
      setPassed((p) => !p);
      return;
    }
    if (request.kind === "recovery" && resolution === null) {
      const choice = RESOLUTIONS.find((r) => r.key === evt.name);
      if (choice) {
        evt.preventDefault();
        setResolution(choice.value);
      }
    }
  });

  const submit = (): void => {
    const value = text.trim();
    if (rejecting) {
      if (!value) return;
      onDecision({ kind: "reject", requestId: request.id, explanation: value });
      setRejecting(false);
      setText("");
      return;
    }
    if (request.kind === "clarification") {
      if (question + 1 < items.length) {
        goTo(question + 1);
        return;
      }
      sendAnswers(currentAnswers());
      return;
    }
    if (request.kind === "manual_evidence") {
      const body = parse<EvidenceBody>(request.body_json);
      if (body.criterionId && value)
        onDecision({
          kind: "manual-evidence",
          requestId: request.id,
          criterionId: body.criterionId,
          evidence: value,
          accepted: passed,
        });
      return;
    }
    if (request.kind === "recovery" && resolution && value) {
      const body = parse<RecoveryBody>(request.body_json);
      if (body.effectId)
        onDecision({
          kind: "recovery",
          requestId: request.id,
          effectId: body.effectId,
          resolution,
          evidence: value,
        });
    }
  };
  // FocusTarget scrolls the popup so the focused input stays visible in small terminals.
  const input = (placeholder: string) => (
    <FocusTarget active={inputFocused}>
      <HardShadow width="100%">
        <box
          borderStyle="heavy"
          border
          borderColor={t.brand}
          paddingX={1}
          backgroundColor={t.bgPopup}
        >
          <input
            value={text}
            onInput={setText}
            onSubmit={submit}
            placeholder={placeholder}
            focused={inputFocused}
            backgroundColor={t.bgPopup}
          />
        </box>
      </HardShadow>
    </FocusTarget>
  );

  const acceptance =
    request.kind === "approval" ? parse<AcceptanceBody>(request.body_json).acceptance : undefined;
  if (acceptance) {
    const lines = acceptance.testContent.split("\n");
    return (
      <box flexDirection="column">
        <Section
          title={`Promote the test of the AI walk-through ${acceptance.gateId}?`}
          description={`Accepting writes ${acceptance.testPath} and the command gate ${acceptance.commandGateId}, which then runs without a model. The walk-through itself stays advisory.`}
        >
          <text fg={t.textPrimary} attributes={1}>
            {`${acceptance.scenario} · walk-through ${acceptance.verdict} · stable in ${acceptance.stableRuns} runs`}
          </text>
          <text fg={t.textSecondary} attributes={1}>
            Expectations and assertions
          </text>
          {acceptance.expectations.map((e) => (
            <text key={e.expectationId} fg={e.verdict === "fail" ? t.error : t.textMuted}>
              {`  ${e.expectationId} ${e.verdict} (steps ${e.stepIds.join(", ") || "none"}) → ${
                acceptance.assertions
                  .filter((a) => a.expectationId === e.expectationId)
                  .map((a) => a.assertionId)
                  .join(", ") || "no assertion"
              }: ${flatten(e.explanation)}`}
            </text>
          ))}
          <text fg={t.textSecondary} attributes={1}>
            Evidence steps
          </text>
          {acceptance.steps.map((step) => (
            <text key={step.stepId} fg={t.textMuted}>
              {`  ${step.stepId} ${flatten(step.action)} → ${flatten(step.observation)}`}
            </text>
          ))}
          <text fg={t.textSecondary} attributes={1}>
            {`${acceptance.testPath} (${lines.length} lines)`}
          </text>
          {lines.slice(0, 80).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
            <text key={i} fg={t.textFaint}>{`  ${line}`}</text>
          ))}
        </Section>
        {rejecting ? (
          input("Why is the test rejected? Enter to discard it (Esc keeps the request)")
        ) : (
          <text>
            <span fg={t.success} attributes={1}>
              {" A "}
            </span>
            <span fg={t.textMuted}>accept and promote </span>
            <span fg={t.error} attributes={1}>
              {" X "}
            </span>
            <span fg={t.textMuted}>discard with a note </span>
          </text>
        )}
        <Hint>{`Test ${acceptance.testHash.slice(0, 12)}… — the promoted gate fails if the file changes.`}</Hint>
      </box>
    );
  }
  const testsFirst =
    request.kind === "approval" ? parse<TestsFirstBody>(request.body_json).testsFirst : undefined;
  if (testsFirst) {
    const files = testsFirst.tests.flatMap((test) => test.files);
    return (
      <box flexDirection="column">
        <Section
          title="Approve the tests written first"
          description="These tests fail on the current code. Approving makes them read-only and lets the agents write the code until they pass."
        >
          <text fg={t.textSecondary} attributes={1}>
            {`Criteria (${testsFirst.criteria.length})`}
          </text>
          {testsFirst.criteria.map((c) => (
            <text key={c.id} fg={t.textMuted}>{`  ${c.id} ${flatten(c.text)}`}</text>
          ))}
          {testsFirst.tests.map((test) => (
            <text key={test.taskId} fg={t.textPrimary}>
              {`${test.taskId} ${flatten(test.title)} · ${test.criterionIds.join(", ")}`}
            </text>
          ))}
          {files.map((file) => {
            const lines = file.content.split("\n");
            return (
              <box key={file.path} flexDirection="column">
                <text fg={t.textSecondary} attributes={1}>
                  {`${file.path} (${lines.length} lines)`}
                </text>
                {lines.slice(0, 60).map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
                  <text key={i} fg={t.textFaint}>{`  ${line}`}</text>
                ))}
              </box>
            );
          })}
        </Section>
        {rejecting ? (
          input(
            "What should the tests check instead? Enter to write them again (Esc keeps the request)",
          )
        ) : (
          <text>
            <span fg={t.success} attributes={1}>
              {" A "}
            </span>
            <span fg={t.textMuted}>approve the tests </span>
            <span fg={t.error} attributes={1}>
              {" X "}
            </span>
            <span fg={t.textMuted}>write them again with a note </span>
          </text>
        )}
      </box>
    );
  }
  if (request.kind === "approval") {
    const body = parse<ApprovalBody>(request.body_json);
    const writes = body.writes ?? [];
    const uniqueWrites = [...new Map(writes.map((w) => [`${w.action} ${w.path}`, w])).values()];
    const criteria = details?.criteria ?? [];
    return (
      <box flexDirection="column">
        <Section
          title="Approve the plan before code changes"
          description="Approving lets the agents edit exactly the files below and run these checks."
        >
          {details?.title ? (
            <text fg={t.textPrimary} attributes={1}>
              {details.title}
            </text>
          ) : null}
          <text
            fg={t.textSecondary}
            attributes={1}
          >{`Acceptance criteria (${criteria.length})`}</text>
          {criteria.map((c) => (
            <text key={c.id} fg={t.textMuted}>
              {`  ${c.id} [${c.method}] ${c.text}`}
            </text>
          ))}
          {body.autoApproval?.declined?.length ? (
            <text fg={t.textMuted}>
              {`Auto approval left this to you: ${body.autoApproval.declined.join("; ")}`}
            </text>
          ) : null}
          {body.autoApproval && approvalReviewText(body.autoApproval) ? (
            <text fg={t.warning}>{approvalReviewText(body.autoApproval)}</text>
          ) : null}
          {body.requestCoverage?.length ? (
            <>
              <text
                fg={body.requestCoverage.every((r) => r.mapped) ? t.textSecondary : t.warning}
                attributes={1}
              >{`Request coverage (${body.requestCoverage.length})`}</text>
              {body.requestCoverage.map((r) => (
                <text key={r.deliverable} fg={r.mapped ? t.textMuted : t.warning}>
                  {`  ${r.mapped ? "\u2713" : "!"} ${flatten(r.deliverable)} \u2192 ${
                    r.requirementIds.length
                      ? [...r.requirementIds, ...r.criterionIds].join(", ")
                      : r.outOfScope
                        ? `out of scope: ${flatten(r.outOfScope)}`
                        : "not covered"
                  }`}
                </text>
              ))}
            </>
          ) : null}
          {body.budgetWarning ? (
            <text fg={t.warning} attributes={1}>{`! ${flatten(body.budgetWarning)}`}</text>
          ) : null}
          {body.assumptions?.length ? (
            <>
              <text
                fg={t.warning}
                attributes={1}
              >{`Assumptions the agents made instead of asking (${body.assumptions.length})`}</text>
              {body.assumptions.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: assumptions may repeat
                <text key={i} fg={t.textMuted}>
                  {`  • ${flatten(a)}`}
                </text>
              ))}
            </>
          ) : null}
          {body.autoApproval?.declined?.length ? (
            <>
              <text fg={t.textSecondary} attributes={1}>
                Why this waits for you
              </text>
              {body.autoApproval.declined.map((reason, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: reasons may repeat
                <text key={i} fg={t.textMuted}>
                  {`  • ${flatten(reason)}`}
                </text>
              ))}
            </>
          ) : null}
          <text
            fg={t.textSecondary}
            attributes={1}
          >{`Files in scope (${uniqueWrites.length})`}</text>
          {uniqueWrites.map((w) => (
            <text
              key={`${w.action}-${w.path}`}
              fg={w.action === "delete" ? t.error : w.action === "create" ? t.success : t.textMuted}
            >
              {`  ${w.action === "create" ? "+" : w.action === "delete" ? "-" : "~"} ${w.path}`}
            </text>
          ))}
          <text fg={t.textSecondary} attributes={1}>
            Checks
          </text>
          <text fg={body.checks?.length ? t.textMuted : t.warning}>
            {body.checks?.length
              ? `  ${body.checks.map((c) => `${c.id} (${c.executable} ${c.args.join(" ")})`).join(", ")}`
              : "  none configured"}
          </text>
          {body.baselineFailures?.length ? (
            <text fg={t.warning}>
              {`  Required checks that fail before any change: ${body.baselineFailures.join(", ")}. One that still fails the same way after the tasks stops the run.`}
            </text>
          ) : null}
          {body.deferredCriteria?.length ? (
            <text
              fg={t.warning}
            >{`  Deferred to post-release: ${body.deferredCriteria.join(", ")}`}</text>
          ) : null}
          {body.activeTime ? (
            <text
              fg={body.activeTime.estimatedMs > body.activeTime.after ? t.warning : t.textMuted}
            >{`  ${activeTimeText(body.activeTime)}.`}</text>
          ) : null}
          {body.planCost ? (
            <text fg={t.textMuted}>{`  ${planCostText(body.planCost)}.`}</text>
          ) : null}
          <text fg={t.textMuted}>
            {body.sandbox
              ? `  Checks, fixes and acceptance apps run in the OS sandbox (${body.sandbox}).`
              : "  Checks, fixes and acceptance apps run without OS sandbox."}
          </text>
          {body.worktree ? (
            <text fg={t.textMuted}>
              {`  Runs in worktree ${body.worktree.path} on branch ${body.worktree.branch}; your working copy is not changed.`}
            </text>
          ) : null}
          {body.worktree?.userChangesInScope.length ? (
            <text fg={t.warning}>
              {`  Uncommitted changes in your working copy are left out of the worktree: ${body.worktree.userChangesInScope.join(", ")}. Approving accepts this; to keep them, reject, commit them and start a new run.`}
            </text>
          ) : null}
        </Section>
        {rejecting ? (
          <>
            <text fg={t.warning}>
              What should change? The agents revise the spec and plan using your note.
            </text>
            {input("Reason for rejection, then Enter (Esc keeps the request)")}
          </>
        ) : (
          <text>
            <span fg={t.success} attributes={1}>
              {" A "}
            </span>
            <span fg={t.textMuted}>approve and continue </span>
            <span fg={t.error} attributes={1}>
              {" X "}
            </span>
            <span fg={t.textMuted}>reject with a note </span>
          </text>
        )}
        <Hint>Spec, Plan and Tasks tabs show the full documents.</Hint>
        <Hint>{`Digest ${request.digest.slice(0, 12)}… — approval is bound to exactly this version.`}</Hint>
      </box>
    );
  }
  if (request.kind === "clarification") {
    const current = items[question];
    const all = currentAnswers();
    const answered = all.filter((a) => a?.trim()).length;
    const blocking = items.filter((item) => item.blocking).length;
    const missingBlocking = items.filter((item, i) => item.blocking && !all[i]?.trim()).length;
    const fit = (value: string, room: number): string => {
      const flat = flatten(value);
      const max = Math.max(12, room);
      return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    };
    // Current question, its answer field and the hint come first so they stay in view.
    return (
      <box flexDirection="column">
        <text fg={t.textPrimary} attributes={1}>
          The agents need answers
        </text>
        <text fg={t.textMuted}>
          {`${items.length} question${items.length === 1 ? "" : "s"}${blocking ? ` · ${blocking} blocking` : ""} · ${answered} answered`}
        </text>
        <box height={1} />
        {current ? (
          <>
            <text fg={t.textSecondary} attributes={1}>
              {`Question ${question + 1} of ${items.length}`}
              {current.blocking ? <span fg={t.warning}>{" · blocking"}</span> : null}
              <span fg={t.textFaint}>{` · ${current.label}`}</span>
            </text>
            <text fg={t.textPrimary}>{flatten(current.text)}</text>
          </>
        ) : null}
        {input(
          question + 1 < items.length
            ? "Your answer, Enter for the next question (empty skips)"
            : "Your answer, Enter to send all answers",
        )}
        {confirmSend ? (
          <Hint kind="warn">
            {`${missingBlocking} blocking question${missingBlocking === 1 ? " has" : "s have"} no answer; the agents may ask again. Press Enter or Ctrl+S again to send anyway.`}
          </Hint>
        ) : (
          <Hint>↑/↓ switch questions · Enter save and next · Ctrl+S send now</Hint>
        )}
        {current?.refs.length ? (
          <box flexDirection="column">
            <box height={1} />
            <text fg={t.textMuted}>References</text>
            {current.refs.slice(0, MAX_REFS).map((ref) => (
              <text key={ref} fg={t.textFaint}>
                {`  ↳ ${fit(ref, width - 6)}`}
              </text>
            ))}
            {current.refs.length > MAX_REFS ? (
              <text fg={t.textFaint}>
                {`  ↳ +${current.refs.length - MAX_REFS} more references`}
              </text>
            ) : null}
          </box>
        ) : null}
        {items.length > 1 ? (
          <box flexDirection="column">
            <box height={1} />
            <text fg={t.textMuted}>All questions</text>
            {items.map((item, i) => {
              const isCurrent = i === question;
              const done = !!all[i]?.trim();
              const prefix = `${isCurrent ? "▸" : done ? "✓" : " "} ${i + 1}. ${item.blocking ? "! " : ""}`;
              return (
                <text
                  key={item.key}
                  fg={isCurrent ? t.brand : done ? t.success : t.textMuted}
                  bg={isCurrent ? t.bgPopupHighlight : t.bgPopup}
                  attributes={isCurrent ? 1 : 0}
                >
                  {prefix}
                  {fit(item.text, width - prefix.length - 2)}
                </text>
              );
            })}
            {blocking ? <Hint>! marks a blocking question</Hint> : null}
          </box>
        ) : null}
      </box>
    );
  }
  if (request.kind === "manual_evidence") {
    const body = parse<EvidenceBody>(request.body_json);
    return (
      <box flexDirection="column">
        <Section
          title={`Manual check: ${body.criterionId ?? "criterion"}`}
          description={
            body.question ?? "Describe what you observed when you verified this criterion."
          }
        >
          <text fg={passed ? t.success : t.error}>
            {`Verdict: ${passed ? "PASSES" : "FAILS"}  (Ctrl+T toggles)`}
          </text>
        </Section>
        {input("What you observed, then Enter")}
      </box>
    );
  }
  if (request.kind === "delivery") {
    const body = parse<DeliveryBody>(request.body_json);
    const operations = body.operations ?? [];
    const follow = body.followUp;
    const local = operations.includes("advance");
    return (
      <box flexDirection="column">
        <Section
          title={
            follow
              ? "Approve the follow-up commit"
              : local
                ? "Approve the local delivery"
                : "Approve the Git delivery"
          }
          description={
            follow
              ? "Approving lets BAKED commit exactly these files on top of the branch below and push it as a fast-forward. No new pull request is opened. Nothing is force-pushed or merged."
              : local
                ? "Approving lets BAKED commit exactly these files on top of the checked-out branch, move that branch to the commit and write the files into your working copy. Nothing is pushed."
                : "Approving lets BAKED commit exactly these files, push the branch and open the pull request below. Nothing is force-pushed or merged."
          }
        >
          <text fg={t.textPrimary}>
            {local
              ? `${operations.join(", ")} into ${body.base?.branch ?? "?"}, no remote`
              : `${operations.join(", ")} to ${body.remote?.name ?? "?"} (${body.remote?.url ?? "?"})`}
          </text>
          <text fg={t.textMuted}>
            {follow
              ? `Adds to branch ${body.branch ?? "?"} at ${(body.base?.commit ?? "").slice(0, 12)}, delivered by run ${follow.runId}`
              : local
                ? `${body.base?.branch ?? "?"} moves from ${(body.base?.commit ?? "").slice(0, 12)}; the commit is also kept on ${body.branch ?? "?"}`
                : `Branch ${body.branch ?? "?"} from ${body.base?.branch ?? "?"} at ${(body.base?.commit ?? "").slice(0, 12)}`}
          </text>
          {follow?.pullRequest ? (
            <text fg={t.textMuted}>{`Pull request: ${follow.pullRequest.url}`}</text>
          ) : null}
          {body.reviewReplies ? (
            <text fg={t.textMuted}>
              {`Then replies "${body.reviewReplies.body}" to ${body.reviewReplies.threads.length} review thread(s)${body.reviewReplies.resolve ? " and resolves them" : ""}: ${body.reviewReplies.threads.map((r) => r.path || r.id).join(", ")}`}
            </text>
          ) : null}
          <text fg={t.textSecondary} attributes={1}>{`Files (${body.files?.length ?? 0})`}</text>
          {(body.files ?? []).map((f) => (
            <text key={f} fg={t.textMuted}>{`  ${f}`}</text>
          ))}
          {body.excluded?.length ? (
            <text fg={t.warning}>
              {`  Not delivered: ${body.excluded.map((e) => `${e.path} (${e.reason})`).join(", ")}`}
            </text>
          ) : null}
          {body.userChanges?.length ? (
            <text fg={t.textMuted}>
              {`  Your other changes stay as they are: ${body.userChanges.join(", ")}`}
            </text>
          ) : null}
          <text fg={t.textSecondary} attributes={1}>
            Commit message
          </text>
          <text fg={t.textMuted}>{body.commitMessage ?? ""}</text>
          {body.pullRequest ? (
            <text fg={t.textMuted}>
              {`Pull request${body.pullRequest.draft ? " (draft)" : ""} into ${body.pullRequest.base}: ${body.pullRequest.title}`}
            </text>
          ) : null}
        </Section>
        {rejecting ? (
          input("Reason for rejecting, then Enter")
        ) : (
          <Hint>
            A approves this exact plan; then run `baked workflow deliver RUN_ID --execute`. X
            rejects it.
          </Hint>
        )}
      </box>
    );
  }
  if (request.kind === "checkpoint") {
    const body = parse<CheckpointBody>(request.body_json);
    const next = Math.max(body.boundary ?? 0, body.projectedTokens ?? 0) + (body.interval ?? 0);
    return (
      <box flexDirection="column">
        <Section
          title="Token checkpoint"
          description="The run paused before its next step because that step could pass the checkpoint. Nothing more is spent until you decide."
        >
          <text fg={t.textPrimary}>
            {`Used so far: ${formatTokens(body.usedTokens ?? 0)} tokens${body.heldTokens ? ` (+${formatTokens(body.heldTokens)} held by interrupted calls)` : ""} · ${body.calls ?? 0} agent calls`}
          </text>
          <text fg={t.textMuted}>
            {`Checkpoint: ${formatTokens(body.boundary ?? 0)} · next one: ${formatTokens(next)}`}
          </text>
        </Section>
        <Hint>
          C continues up to the next checkpoint. X stops the run here; it can be resumed later.
        </Hint>
      </box>
    );
  }
  if (request.kind === "convergence") {
    const body = parse<ConvergenceBody>(request.body_json);
    const criteria = body.criteria;
    return (
      <box flexDirection="column">
        <Section
          title="Repairs stopped with findings still open"
          description={body.summary ?? "Convergence cannot start another repair round."}
        >
          {criteria ? (
            <text fg={t.textPrimary}>
              {`${criteria.passing} of ${criteria.total} criteria pass${criteria.failing.length ? `; failing: ${criteria.failing.map((c) => c.id).join(", ")}` : ""}. Required checks ${body.checksPassing ? "pass" : "do not all pass"}.`}
            </text>
          ) : null}
          {(body.findings ?? []).map((f) => (
            <text key={f.id} fg={t.textSecondary}>
              {`  ${f.id} ${f.severity}: ${flatten(f.claim)}${f.file ? ` (${f.file}${f.symbol ? `:${f.symbol}` : ""})` : ""}`}
            </text>
          ))}
          {(body.contradictions ?? []).map((c) => (
            <text key={c.findingId} fg={t.warning}>
              {`  ${c.findingId} repeats ${c.earlierId}, which a correction already addressed: ${flatten(c.earlierClaim)}`}
            </text>
          ))}
          {body.hostRule ? (
            <text fg={t.textSecondary}>
              {`Under assume the host would ${body.hostRule.decision === "ask" ? "ask" : body.hostRule.decision}: ${flatten(body.hostRule.why)} Rules: ${body.hostRule.rules.map(flatten).join(" ")}`}
            </text>
          ) : null}
        </Section>
        <Hint>
          A accepts these findings as known limitations (listed in the run report) and goes on to
          acceptance. C repairs once more. X stops the run here; it can be resumed later.
        </Hint>
      </box>
    );
  }
  const body = parse<RecoveryBody>(request.body_json);
  return (
    <box flexDirection="column">
      <Section
        title="A command was interrupted"
        description="BAKED cannot tell whether it finished. Nothing is replayed automatically."
      >
        <text
          fg={t.textMuted}
        >{`Effect ${body.effectId ?? "?"}: ${JSON.stringify(body.intent ?? {})}`}</text>
        {body.note ? <text fg={t.textSecondary}>{body.note}</text> : null}
        {RESOLUTIONS.map((r) => (
          <text key={r.value} fg={resolution === r.value ? t.brand : t.textSecondary}>
            {`${resolution === r.value ? "▸" : " "} ${r.key}  ${r.label}`}
          </text>
        ))}
      </Section>
      {resolution ? (
        input("Describe what you checked (process stopped, files observed), then Enter")
      ) : (
        <Hint>Press 1–4 to choose an outcome.</Hint>
      )}
    </box>
  );
}
