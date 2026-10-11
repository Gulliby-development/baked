import { useId, useState } from "react";
import type { ChatMessage, InputContextItem, ToolCall } from "../../client/chat.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import { INLINE_CODE, Markdown } from "./Markdown.js";
import { CHIP_SMALL } from "./Popover.js";
import { type ToolDiff, toolDiff, toolTitle } from "./tools.js";
import type { Transcript, TranscriptPrompt } from "./transcript.js";

/** Tools the agent uses for its own bookkeeping; they say nothing to the person. */
const HIDDEN_TOOLS = new Set(["final_response"]);
const DIFF_PREVIEW_LINES = 14;

const TOOL_LINE =
  "flex items-center gap-[10px] min-h-[34px] w-full px-3 py-0 rounded-base border-2 border-border bg-sidebar text-muted-foreground font-mono leading-[inherit] text-[12.5px] text-left cursor-pointer hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground aria-expanded:shadow-sm-hard";
const TOOL_BODY =
  "m-[0_0_0_34px] py-[10px] px-3 border-l-[3px] border-l-border text-muted-foreground leading-[1.6] whitespace-pre-wrap wrap-anywhere max-h-[320px] overflow-y-auto";
const NOTICE = "m-0 px-3 py-0 text-[13px]";
const DIFF_LINE: Record<ToolDiff["lines"][number]["kind"], string> = {
  add: "bg-[var(--diff-add)] text-[var(--ok)]",
  del: "bg-[var(--diff-del)] text-[var(--err)]",
  hunk: "text-dim-foreground",
  ctx: "",
};
const PROMPT_CARD =
  "border-2 border-border rounded-base shadow-shadow px-4 py-[14px] flex flex-col";
const PROMPT_TITLE = "m-0 font-bold text-main-foreground";
const ROW = "flex flex-wrap gap-2";
const SPINNER = "size-3 flex-none inline-flex";
const SPINNER_RING =
  "w-full h-full rounded-[50%] border-2 border-[var(--line-strong)] border-t-[var(--accent)] animate-spin [animation-duration:0.8s] motion-reduce:animate-none";
const OUTCOME_TONE: Record<string, string> = {
  approved: "text-[var(--ok)]",
  denied: "text-[var(--err)]",
};

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
      className={`flex-none [transition:transform_0.12s] motion-reduce:[transition:none]${open ? " [transform:rotate(90deg)]" : ""}`}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function Status({ call }: { call: ToolCall }) {
  if (!call.result)
    return (
      <span className={SPINNER} role="img" aria-label="Running">
        <span className={SPINNER_RING} />
      </span>
    );
  return call.result.success ? (
    <span className="text-[var(--ok)]" role="img" aria-label="Done">
      ✓
    </span>
  ) : (
    <span className="text-[var(--err)]" role="img" aria-label="Failed">
      ✕
    </span>
  );
}

function Title({ call }: { call: ToolCall }) {
  const title = toolTitle(call.name, call.args);
  return (
    <span className="min-w-0 truncate">
      {title.verb}
      {title.subject && (
        <> {title.code ? <code className={INLINE_CODE}>{title.subject}</code> : title.subject}</>
      )}
    </span>
  );
}

function ToolLine({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const output = call.result ? (call.result.error ?? call.result.output) : "";
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className={TOOL_LINE}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        <Status call={call} />
        <Title call={call} />
      </button>
      {open && (
        <pre id={id} className={`${TOOL_BODY} font-mono text-[12px]`}>
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
    <figure
      className="m-0 border-2 border-border rounded-base overflow-hidden bg-background shadow-shadow"
      aria-label={`Changes to ${diff.path}`}
    >
      <figcaption className="flex items-center gap-[10px] px-3 py-[10px] text-[13px] font-semibold text-muted-foreground border-b-2 border-b-border">
        <Status call={call} />
        <span className="font-mono text-soft-foreground min-w-0 truncate">{diff.path}</span>
        {diff.created && <span className="text-dim-foreground">new file</span>}
        <span className="font-mono ml-auto text-[var(--ok)]">+{diff.added}</span>
        <span className="font-mono text-[var(--err)]">−{diff.removed}</span>
        {(hidden > 0 || all) && (
          <button
            type="button"
            className={CHIP_SMALL}
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
          >
            {all ? "Show less" : `Show all ${diff.lines.length} lines`}
          </button>
        )}
      </figcaption>
      {failed && (
        <p className="m-0 px-[14px] py-2 text-[var(--err)] text-[13px]">
          {call.result?.error ?? "The edit failed."}
        </p>
      )}
      <pre className="m-0 py-[6px] px-0 bg-[var(--bg-code)] font-mono text-[13px] leading-[1.7] text-muted-foreground overflow-x-auto">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          <span key={i} className={`block px-4 py-0 whitespace-pre ${DIFF_LINE[line.kind]}`}>
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
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className={TOOL_LINE}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} />
        {label}
      </button>
      {open && (
        <div id={id} className={`${TOOL_BODY} text-[13px]`}>
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
    <div className="flex flex-col gap-3 min-w-0">
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

const FORK_ROW =
  "m-0 flex flex-wrap items-center gap-2 border-0 p-0 text-[13px] text-dim-foreground";
const FORK_LINK =
  "cursor-pointer border-0 bg-transparent p-0 [font-family:inherit] [font-size:inherit] leading-[inherit] text-dim-foreground underline hover:text-foreground disabled:cursor-default disabled:opacity-50";

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
      <div
        className={cn(
          FORK_ROW,
          "opacity-0 transition-opacity duration-[120ms] group-hover/turn:opacity-100 focus-within:opacity-100",
        )}
      >
        <button
          type="button"
          className={FORK_LINK}
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
    <fieldset className={FORK_ROW} aria-label="Fork from here">
      <span>Continue in a new chat from this point. Roll the files back too?</span>
      <Button variant="secondary" size="md" onClick={() => pick(false)}>
        Chat only
      </Button>
      <Button variant="primary" size="md" onClick={() => pick(true)}>
        Chat and files
      </Button>
      <button type="button" className={FORK_LINK} onClick={() => setOpen(false)}>
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
    <div
      className={`self-end max-w-[640px] bg-main text-main-foreground border-2 border-border rounded-base shadow-shadow px-4 py-3 leading-[1.6] text-[15px] whitespace-pre-wrap wrap-anywhere flex flex-col gap-[2px]${note === "Sending…" ? " opacity-[0.65]" : ""}`}
    >
      {note && (
        <span className="font-mono text-[11px] font-bold text-main-foreground opacity-75 uppercase tracking-[0.06em]">
          {note}
        </span>
      )}
      {text}
      {context && context.length > 0 && (
        <ul
          className="list-none m-[8px_0_0] p-[8px_0_0] border-t-2 border-t-border flex flex-col gap-1 text-[13px]"
          aria-label="Attached context"
        >
          {context.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items keep their order
            <li key={i} className={item.ok ? undefined : "opacity-70 line-through"}>
              <span className="font-mono">
                {item.kind === "command" ? "!" : "@"}
                {item.ref}
              </span>{" "}
              <span className="opacity-80">{item.summary}</span>
              {item.output && (
                <pre className="m-[4px_0_0] px-2 py-[6px] max-h-[200px] overflow-auto font-mono text-[12px] rounded-base bg-background text-foreground border-2 border-border whitespace-pre">
                  {item.output}
                </pre>
              )}
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
      <p className="m-0 px-3 py-0 flex gap-2 text-[13px] text-dim-foreground min-w-0">
        <span className={`flex-none font-medium ${OUTCOME_TONE[outcome] ?? ""}`}>
          {OUTCOMES[outcome]}
        </span>
        <span className="truncate">{subject}</span>
      </p>
    );
  }
  if (prompt.kind === "question") {
    return (
      <section
        className={`${PROMPT_CARD} gap-[6px] bg-fill-info text-soft-foreground`}
        aria-label="Question"
      >
        <p className={PROMPT_TITLE}>{prompt.question}</p>
        {prompt.options.length > 0 && (
          <div className={ROW}>
            {prompt.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="min-h-9 px-[14px] py-0 rounded-[999px] border-2 border-border bg-raised text-foreground shadow-sm-hard font-[inherit] leading-[inherit] text-[13px] font-semibold cursor-pointer hover:bg-main hover:text-main-foreground disabled:opacity-50 disabled:cursor-default"
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
          className={ROW}
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
            className="flex-1 min-w-[200px]"
            placeholder={prompt.options.length > 0 ? "Or write an answer" : "Your answer"}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || !text.trim()}>
            Answer
          </Button>
          {prompt.allowSkip && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => onAnswer(prompt.id, "")}
            >
              Skip
            </Button>
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
    <section
      className={`${PROMPT_CARD} gap-[10px] bg-fill-warn text-main-foreground`}
      aria-label={APPROVAL_TITLES[prompt.kind]}
    >
      <p className={PROMPT_TITLE}>{APPROVAL_TITLES[prompt.kind]}</p>
      <pre className="m-0 px-[10px] py-2 border-2 border-border rounded-base bg-[var(--bg-code)] font-mono text-[13px] text-soft-foreground whitespace-pre-wrap wrap-anywhere">
        {detail}
      </pre>
      <div className={ROW}>
        <Button
          variant="primary"
          size="md"
          disabled={busy}
          onClick={() => onApprove(prompt.id, true)}
        >
          Allow
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => onApprove(prompt.id, false)}
        >
          Deny
        </Button>
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
}: {
  transcript: Transcript;
  deciding: ReadonlySet<string>;
  onApprove: (id: string, approve: boolean) => void;
  onAnswer: (id: string, answer: string) => void;
  forking?: boolean;
  /** Forks the session after `messageId`; absent while the session cannot be forked. */
  onFork?: (messageId: string, rollbackFiles: boolean) => void;
}) {
  const { messages, live, prompts, pending, notice, thoughtMs } = transcript;
  const running = transcript.turnId !== null;
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
          <div key={message.id} className="group/turn flex min-w-0 flex-col gap-1.5">
            <Assistant message={message} thoughtMs={thoughtMs[message.id]} thinking={false} />
            {onFork && !running && (
              <ForkAction
                disabled={forking === true}
                onFork={(rollbackFiles) => onFork(message.id, rollbackFiles)}
              />
            )}
          </div>
        ) : null,
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
      {pending.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pending texts can repeat
        <UserBubble key={`pending-${i}`} text={text} note="Sending…" />
      ))}
      {running && !waiting && lastLive?.type !== "reasoning" && (
        <p
          className={`${NOTICE} flex items-center gap-[10px] text-dim-foreground`}
          aria-live="polite"
        >
          <span className={SPINNER} aria-hidden="true">
            <span className={SPINNER_RING} />
          </span>
          Working…
        </p>
      )}
      {notice && (
        <p
          className={`${NOTICE} ${notice.kind === "error" ? "text-[var(--err)]" : "text-dim-foreground"}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.kind === "error" ? "Error: " : ""}
          {notice.text}
        </p>
      )}
    </>
  );
}
