import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { Decision } from "../../core/workflows/schemas.js";
import type { RequestRow } from "../../core/workflows/store.js";
import type { Check } from "../../core/workflows/types.js";
import type { RunDetails } from "../../core/workflows/view.js";
import { FocusTarget } from "../ui/FocusTarget.js";
import { Hint, Section } from "../ui/index.js";

interface ApprovalBody {
  writes?: { path: string; action: string }[];
  checks?: Check[];
  deferredCriteria?: string[];
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
interface RecoveryBody {
  effectId?: string;
  intent?: Record<string, unknown>;
}
const RESOLUTIONS = [
  { key: "1", value: "record-applied", label: "It ran and its effect is in place" },
  { key: "2", value: "record-not-applied", label: "It did not run / had no effect" },
  { key: "3", value: "retry", label: "Allow a new attempt" },
  { key: "4", value: "cancel", label: "Abandon it (all its processes are stopped)" },
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
    if (request.kind === "approval" && !rejecting) {
      if (key === "a") {
        evt.preventDefault();
        onDecision({ kind: "approve", requestId: request.id, digest: request.digest });
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
      <box
        borderStyle="rounded"
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
    </FocusTarget>
  );

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
          {body.deferredCriteria?.length ? (
            <text
              fg={t.warning}
            >{`  Deferred to post-release: ${body.deferredCriteria.join(", ")}`}</text>
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
