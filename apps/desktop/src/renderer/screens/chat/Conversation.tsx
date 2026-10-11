import { useId, useState } from "react";
import type {
  ChatMessage,
  ChatPlan,
  InputContextItem,
  PlanAction,
  StoredImage,
  ToolCall,
} from "../../client/chat.js";
import { storedImageUrl } from "./images.js";
import { Markdown } from "./Markdown.js";
import { type ToolDiff, toolDiff, toolTitle } from "./tools.js";
import type { Transcript, TranscriptPrompt } from "./transcript.js";

/** Tools the agent uses for its own bookkeeping; they say nothing to the person. */
const HIDDEN_TOOLS = new Set(["final_response"]);
const DIFF_PREVIEW_LINES = 14;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={`chevron${open ? " open" : ""}`}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function Status({ call }: { call: ToolCall }) {
  if (!call.result)
    return (
      <span className="spinner" role="img" aria-label="Running">
        <span />
      </span>
    );
  return call.result.success ? (
    <span className="tool-ok" role="img" aria-label="Done">
      ✓
    </span>
  ) : (
    <span className="tool-err" role="img" aria-label="Failed">
      ✕
    </span>
  );
}

function Title({ call }: { call: ToolCall }) {
  const title = toolTitle(call.name, call.args);
  return (
    <span className="tool-title">
      {title.verb}
      {title.subject && <> {title.code ? <code>{title.subject}</code> : title.subject}</>}
    </span>
  );
}

function ToolLine({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const output = call.result ? (call.result.error ?? call.result.output) : "";
  return (
    <div className="tool">
      <button
        type="button"
        className="tool-line"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        <Status call={call} />
        <Title call={call} />
      </button>
      {open && (
        <pre id={id} className="tool-output">
          {call.result ? output.trim() || "No output." : "Running…"}
        </pre>
      )}
    </div>
  );
}

function DiffCard({ call, diff }: { call: ToolCall; diff: ToolDiff }) {
  const [all, setAll] = useState(false);
  const failed = call.result && !call.result.success;
  const lines = all ? diff.lines : diff.lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = diff.lines.length - lines.length;
  return (
    <figure className="diff-card" aria-label={`Changes to ${diff.path}`}>
      <figcaption className="diff-head">
        <Status call={call} />
        <span className="mono diff-path">{diff.path}</span>
        {diff.created && <span className="muted">new file</span>}
        <span className="mono diff-add-count">+{diff.added}</span>
        <span className="mono diff-del-count">−{diff.removed}</span>
        {(hidden > 0 || all) && (
          <button
            type="button"
            className="chip small"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
          >
            {all ? "Show less" : `Show all ${diff.lines.length} lines`}
          </button>
        )}
      </figcaption>
      {failed && <p className="diff-failed">{call.result?.error ?? "The edit failed."}</p>}
      <pre className="diff-body">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          <span key={i} className={`diff-line ${line.kind}`}>
            {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </figure>
  );
}

function Tool({ call }: { call: ToolCall }) {
  if (HIDDEN_TOOLS.has(call.name)) return null;
  const diff = toolDiff(call.name, call.args);
  return diff ? <DiffCard call={call} diff={diff} /> : <ToolLine call={call} />;
}

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? "" : "s"}`;
}

function Reasoning({ text, ms, active }: { text: string; ms?: number; active: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const label = active ? "Thinking…" : ms !== undefined ? `Thought for ${seconds(ms)}` : "Thought";
  return (
    <div className="tool">
      <button
        type="button"
        className={`tool-line${active ? " thinking" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        {label}
      </button>
      {open && (
        <div id={id} className="reasoning-text">
          {text}
        </div>
      )}
    </div>
  );
}

function Assistant({
  message,
  thoughtMs,
  thinking,
}: {
  message: ChatMessage;
  thoughtMs: number[] | undefined;
  thinking: boolean;
}) {
  const calls = new Map((message.toolCalls ?? []).map((c) => [c.id, c]));
  const segments = message.segments ?? [
    { type: "text" as const, content: message.content },
    { type: "tools" as const, toolCallIds: [...calls.keys()] },
  ];
  let reasoningIndex = 0;
  return (
    <div className="assistant">
      {segments.map((segment, i) => {
        const key = `${segment.type}-${i}`;
        if (segment.type === "text")
          return segment.content.trim() ? <Markdown key={key} text={segment.content} /> : null;
        if (segment.type === "reasoning") {
          const ms = thoughtMs?.[reasoningIndex++];
          return (
            <Reasoning
              key={key}
              text={segment.content}
              {...(ms !== undefined ? { ms } : {})}
              active={thinking && i === segments.length - 1}
            />
          );
        }
        return segment.toolCallIds.map((id) => {
          const call = calls.get(id);
          return call ? <Tool key={id} call={call} /> : null;
        });
      })}
    </div>
  );
}

function ForkAction({
  disabled,
  onFork,
}: {
  disabled: boolean;
  onFork: (rollbackFiles: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <div className="fork-row">
        <button
          type="button"
          className="fork-link"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Fork from here
        </button>
      </div>
    );
  const pick = (rollbackFiles: boolean) => {
    setOpen(false);
    onFork(rollbackFiles);
  };
  return (
    <fieldset className="fork-row fork-confirm" aria-label="Fork from here">
      <span>Continue in a new chat from this point. Roll the files back too?</span>
      <button type="button" className="btn" onClick={() => pick(false)}>
        Chat only
      </button>
      <button type="button" className="btn-primary" onClick={() => pick(true)}>
        Chat and files
      </button>
      <button type="button" className="fork-link" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </fieldset>
  );
}

/** Thumbnails of a message's images; a click opens the image at full size. */
function BubbleImages({ images }: { images: StoredImage[] }) {
  const [open, setOpen] = useState<StoredImage | null>(null);
  return (
    <>
      <ul className="bubble-images" aria-label="Attached images">
        {images.map((image) => (
          <li key={image.label}>
            <button
              type="button"
              className="bubble-image"
              aria-label={`Open ${image.label}`}
              onClick={() => setOpen(image)}
            >
              <img src={storedImageUrl(image)} alt={image.label} />
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <dialog
          open
          className="image-viewer"
          aria-label={open.label}
          onClick={() => setOpen(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(null);
            }
          }}
        >
          <img src={storedImageUrl(open)} alt={open.label} />
          <button type="button" className="btn" ref={(el) => el?.focus()}>
            Close
          </button>
        </dialog>
      )}
    </>
  );
}

function UserBubble({
  text,
  note,
  context,
  images,
}: {
  text: string;
  note?: string;
  context?: InputContextItem[];
  images?: StoredImage[];
}) {
  return (
    <div className={`user-bubble${note === "Sending…" ? " pending" : ""}`}>
      {note && <span className="bubble-note">{note}</span>}
      {text}
      {images && images.length > 0 && <BubbleImages images={images} />}
      {context && context.length > 0 && (
        <ul className="input-context" aria-label="Attached context">
          {context.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items keep their order
            <li key={i} className={item.ok ? "ok" : "failed"}>
              <span className="mono">
                {item.kind === "command" ? "!" : "@"}
                {item.ref}
              </span>{" "}
              <span className="input-context-summary">{item.summary}</span>
              {item.output && <pre className="input-context-output">{item.output}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const APPROVAL_TITLES = {
  "outside-cwd": "Allow access outside the project?",
  destructive: "Run a destructive command?",
  "web-search": "Search the web?",
  "fetch-page": "Fetch this page?",
} as const;

const OUTCOMES = {
  approved: "Allowed",
  denied: "Denied",
  answered: "Answered",
  skipped: "Skipped",
} as const;

const PLAN_OUTCOMES: Record<PlanAction, string> = {
  execute: "Plan accepted",
  "clear-execute": "Plan accepted with a fresh context",
  revise: "Changes asked",
  cancel: "Plan cancelled",
};

export interface PlanReview {
  action: PlanAction;
  feedback?: string;
}

/** A plan the agent proposed in plan mode, with the terminal UI's review choices. */
function PlanReviewCard({
  prompt,
  busy,
  onReview,
}: {
  prompt: Extract<TranscriptPrompt["prompt"], { kind: "plan-review" }>;
  busy: boolean;
  onReview: (id: string, review: PlanReview) => void;
}) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const inputId = useId();
  return (
    <section className="prompt-card plan-review" aria-label="Review the plan">
      <p className="prompt-title">Review the plan</p>
      <p className="plan-meta muted">
        {prompt.steps.length} {prompt.steps.length === 1 ? "step" : "steps"} ·{" "}
        {prompt.depth === "full" ? "full plan with edits" : "light plan"} ·{" "}
        <span className="mono">{prompt.planFile}</span>
      </p>
      <div className="plan-body">
        <Markdown text={prompt.content} />
      </div>
      {revising ? (
        <form
          className="prompt-answer"
          onSubmit={(event) => {
            event.preventDefault();
            if (feedback.trim())
              onReview(prompt.id, { action: "revise", feedback: feedback.trim() });
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            What should change
          </label>
          <input
            id={inputId}
            type="text"
            placeholder="What should change?"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy || !feedback.trim()}>
            Send
          </button>
          <button type="button" className="btn" onClick={() => setRevising(false)}>
            Back
          </button>
        </form>
      ) : (
        <div className="prompt-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => onReview(prompt.id, { action: "execute" })}
          >
            Execute
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Drops the conversation so far; the plan carries what the work needs."
            onClick={() => onReview(prompt.id, { action: "clear-execute" })}
          >
            Clear context and execute
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setRevising(true)}>
            Revise
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onReview(prompt.id, { action: "cancel" })}
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

const STEP_MARKS = { pending: "○", active: "◐", done: "✓", skipped: "–" } as const;

/** The checklist of a plan being carried out. */
function PlanChecklist({ plan }: { plan: ChatPlan }) {
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <section className="plan-checklist" aria-label="Plan">
      <p className="plan-checklist-title">
        {plan.title}{" "}
        <span className="muted">
          {done}/{plan.steps.length}
        </span>
      </p>
      <ol>
        {plan.steps.map((step) => (
          <li key={step.id} className={`plan-step ${step.status}`}>
            <span className="plan-step-mark" aria-hidden="true">
              {STEP_MARKS[step.status]}
            </span>
            <span className="sr-only">{step.status}: </span>
            {step.label}
          </li>
        ))}
      </ol>
    </section>
  );
}

function PromptCard({
  entry,
  busy,
  onApprove,
  onAnswer,
  onReviewPlan,
}: {
  entry: TranscriptPrompt;
  busy: boolean;
  onApprove: (id: string, approve: boolean) => void;
  onAnswer: (id: string, answer: string) => void;
  onReviewPlan?: (id: string, review: PlanReview) => void;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const { prompt, outcome } = entry;
  if (outcome) {
    if (prompt.kind === "plan-review")
      return (
        <p className={`prompt-resolved ${outcome}`}>
          <span className="prompt-resolved-outcome">
            {entry.action ? PLAN_OUTCOMES[entry.action] : OUTCOMES[outcome]}
          </span>
          <span className="prompt-resolved-subject">{prompt.title}</span>
        </p>
      );
    const subject =
      prompt.kind === "question"
        ? prompt.question
        : prompt.kind === "outside-cwd"
          ? prompt.path
          : prompt.kind === "destructive"
            ? prompt.description
            : prompt.kind === "web-search"
              ? prompt.query
              : prompt.url;
    return (
      <p className={`prompt-resolved ${outcome}`}>
        <span className="prompt-resolved-outcome">{OUTCOMES[outcome]}</span>
        <span className="prompt-resolved-subject">{subject}</span>
      </p>
    );
  }
  if (prompt.kind === "plan-review") {
    if (!onReviewPlan) return null;
    return <PlanReviewCard prompt={prompt} busy={busy} onReview={onReviewPlan} />;
  }
  if (prompt.kind === "question") {
    return (
      <section className="prompt-card question" aria-label="Question">
        <p className="prompt-title">{prompt.question}</p>
        {prompt.options.length > 0 && (
          <div className="suggestions">
            {prompt.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="suggestion"
                disabled={busy}
                title={option.description}
                onClick={() => onAnswer(prompt.id, option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        <form
          className="prompt-answer"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) onAnswer(prompt.id, text.trim());
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Your answer
          </label>
          <input
            id={inputId}
            type="text"
            placeholder={prompt.options.length > 0 ? "Or write an answer" : "Your answer"}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
            Answer
          </button>
          {prompt.allowSkip && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onAnswer(prompt.id, "")}
            >
              Skip
            </button>
          )}
        </form>
      </section>
    );
  }
  const detail =
    prompt.kind === "outside-cwd"
      ? `${prompt.tool} · ${prompt.path}`
      : prompt.kind === "destructive"
        ? prompt.description
        : prompt.kind === "web-search"
          ? prompt.query
          : prompt.url;
  return (
    <section className="prompt-card" aria-label={APPROVAL_TITLES[prompt.kind]}>
      <p className="prompt-title">{APPROVAL_TITLES[prompt.kind]}</p>
      <pre className="prompt-detail">{detail}</pre>
      <div className="prompt-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => onApprove(prompt.id, true)}
        >
          Allow
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => onApprove(prompt.id, false)}
        >
          Deny
        </button>
      </div>
    </section>
  );
}

export function Conversation({
  transcript,
  deciding,
  onApprove,
  onAnswer,
  onReviewPlan,
  forking,
  onFork,
}: {
  transcript: Transcript;
  deciding: ReadonlySet<string>;
  onApprove: (id: string, approve: boolean) => void;
  onAnswer: (id: string, answer: string) => void;
  /** Answers a plan review; without it plan reviews are not shown. */
  onReviewPlan?: (id: string, review: PlanReview) => void;
  forking?: boolean;
  /** Forks the session after `messageId`; absent while the session cannot be forked. */
  onFork?: (messageId: string, rollbackFiles: boolean) => void;
}) {
  const { messages, live, prompts, pending, notice, thoughtMs } = transcript;
  const running = transcript.turnId !== null;
  const waiting = prompts.some((p) => p.outcome === undefined);
  const lastLive = live?.segments?.at(-1);
  // The review card shows a proposed plan; the checklist follows one being carried out.
  const reviewing = prompts.some((p) => p.prompt.kind === "plan-review");
  const plan = transcript.plan && !reviewing ? transcript.plan : null;
  return (
    <>
      {messages.map((message) =>
        message.role === "user" ? (
          <UserBubble
            key={message.id}
            text={message.content}
            {...(message.isSteering ? { note: "Sent while working" } : {})}
            {...(message.inputContext ? { context: message.inputContext } : {})}
            {...(message.images ? { images: message.images } : {})}
          />
        ) : message.role === "assistant" ? (
          <div key={message.id} className="assistant-turn">
            <Assistant message={message} thoughtMs={thoughtMs[message.id]} thinking={false} />
            {onFork && !running && (
              <ForkAction
                disabled={forking === true}
                onFork={(rollbackFiles) => onFork(message.id, rollbackFiles)}
              />
            )}
          </div>
        ) : (
          <p key={message.id} className="chat-note">
            {message.content}
          </p>
        ),
      )}
      {plan && <PlanChecklist plan={plan} />}
      {live && (
        <Assistant
          message={live}
          thoughtMs={thoughtMs[live.id]}
          thinking={transcript.thinkingSince !== null}
        />
      )}
      {prompts.map((entry) => (
        <PromptCard
          key={entry.prompt.id}
          entry={entry}
          busy={deciding.has(entry.prompt.id)}
          onApprove={onApprove}
          onAnswer={onAnswer}
          {...(onReviewPlan ? { onReviewPlan } : {})}
        />
      ))}
      {pending.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pending texts can repeat
        <UserBubble key={`pending-${i}`} text={text} note="Sending…" />
      ))}
      {running && !waiting && lastLive?.type !== "reasoning" && (
        <p className="working" aria-live="polite">
          <span className="spinner" aria-hidden="true">
            <span />
          </span>
          Working…
        </p>
      )}
      {transcript.compacting && (
        <p className="working" aria-live="polite">
          <span className="spinner" aria-hidden="true">
            <span />
          </span>
          Compacting the conversation…
        </p>
      )}
      {notice && (
        <p className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.kind === "error" ? "Error: " : ""}
          {notice.text}
        </p>
      )}
    </>
  );
}
