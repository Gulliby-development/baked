import { useId, useState } from "react";
import type { ChatMessage, InputContextItem, ToolCall } from "../../client/chat.js";
import { Markdown } from "./Markdown.js";
import { turnIndexes } from "./rewind.js";
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

interface TurnAction {
  label: string;
  question: string;
  run: (rollbackFiles: boolean) => void;
}

/** "Fork from here" and "Rewind to here" under an answer, each asking about the files first. */
function TurnActions({ disabled, actions }: { disabled: boolean; actions: TurnAction[] }) {
  const [open, setOpen] = useState<TurnAction | null>(null);
  if (!open)
    return (
      <div className="fork-row">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="fork-link"
            disabled={disabled}
            onClick={() => setOpen(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    );
  const pick = (rollbackFiles: boolean) => {
    setOpen(null);
    open.run(rollbackFiles);
  };
  return (
    <fieldset className="fork-row fork-confirm" aria-label={open.label}>
      <span>{open.question}</span>
      <button type="button" className="btn" onClick={() => pick(false)}>
        Chat only
      </button>
      <button type="button" className="btn-primary" onClick={() => pick(true)}>
        Chat and files
      </button>
      <button type="button" className="fork-link" onClick={() => setOpen(null)}>
        Cancel
      </button>
    </fieldset>
  );
}

function UserBubble({
  text,
  note,
  context,
}: {
  text: string;
  note?: string;
  context?: InputContextItem[];
}) {
  return (
    <div className={`user-bubble${note === "Sending…" ? " pending" : ""}`}>
      {note && <span className="bubble-note">{note}</span>}
      {text}
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

function PromptCard({
  entry,
  busy,
  onApprove,
  onAnswer,
}: {
  entry: TranscriptPrompt;
  busy: boolean;
  onApprove: (id: string, approve: boolean) => void;
  onAnswer: (id: string, answer: string) => void;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const { prompt, outcome } = entry;
  if (outcome) {
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
  forking,
  onFork,
  onRewind,
  redo,
}: {
  transcript: Transcript;
  deciding: ReadonlySet<string>;
  onApprove: (id: string, approve: boolean) => void;
  onAnswer: (id: string, answer: string) => void;
  forking?: boolean;
  /** Forks the session after `messageId`; absent while the session cannot be forked. */
  onFork?: (messageId: string, rollbackFiles: boolean) => void;
  /** Rewinds this session to the end of checkpoint N; absent when the server cannot. */
  onRewind?: (checkpoint: number, rollbackFiles: boolean) => void;
  /** The turns a rewind dropped and the action that brings back the oldest. */
  redo?: { prompts: string[]; run: () => void };
}) {
  const { messages, live, prompts, pending, notice, thoughtMs } = transcript;
  const running = transcript.turnId !== null;
  const turns = turnIndexes(messages);
  const lastTurn = Math.max(0, ...turns.values());
  const actionsFor = (message: ChatMessage): TurnAction[] => {
    const out: TurnAction[] = [];
    if (onFork)
      out.push({
        label: "Fork from here",
        question: "Continue in a new chat from this point. Roll the files back too?",
        run: (rollbackFiles) => onFork(message.id, rollbackFiles),
      });
    const turn = turns.get(message.id) ?? 0;
    if (onRewind && turn > 0 && turn < lastTurn)
      out.push({
        label: "Rewind to here",
        question: `Remove the ${lastTurn - turn} later turn(s) from this chat (you can redo them). Roll the files back too?`,
        run: (rollbackFiles) => onRewind(turn, rollbackFiles),
      });
    return out;
  };
  const waiting = prompts.some((p) => p.outcome === undefined);
  const lastLive = live?.segments?.at(-1);
  return (
    <>
      {messages.map((message) =>
        message.role === "user" ? (
          <UserBubble
            key={message.id}
            text={message.content}
            {...(message.isSteering ? { note: "Sent while working" } : {})}
            {...(message.inputContext ? { context: message.inputContext } : {})}
          />
        ) : message.role === "assistant" ? (
          <div key={message.id} className="assistant-turn">
            <Assistant message={message} thoughtMs={thoughtMs[message.id]} thinking={false} />
            {!running && actionsFor(message).length > 0 && (
              <TurnActions disabled={forking === true} actions={actionsFor(message)} />
            )}
          </div>
        ) : (
          <p key={message.id} className="chat-note">
            {message.content}
          </p>
        ),
      )}
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
        />
      ))}
      {redo && redo.prompts.length > 0 && !running && (
        <div className="redo-row" role="status">
          <span>
            {redo.prompts.length} rewound turn(s). Next: <q>{redo.prompts[0]}</q>
          </span>
          <button type="button" className="btn" disabled={forking === true} onClick={redo.run}>
            Redo
          </button>
        </div>
      )}
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
