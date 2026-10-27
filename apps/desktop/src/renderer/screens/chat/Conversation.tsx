import { createContext, type ReactNode, useContext, useId, useState } from "react";
import type {
  ChatMessage,
  ChatPlan,
  InputContextItem,
  LaunchNote,
  PlanAction,
  StoredImage,
  ToolCall,
} from "../../client/chat.js";
import { Icon } from "../../components/Icon.js";
import { SplitFlows } from "../../components/SplitFlows.js";
import { Button } from "../../components/ui/button.js";
import { WorkflowProposal } from "../../components/WorkflowProposal.js";
import { cn } from "../../lib/cn.js";
import { LaunchNoteCard } from "../coordinator/LaunchNote.js";
import { messageSender, newestLaunchNotes } from "../coordinator/model.js";
import { storedImageUrl } from "./images.js";
import { INLINE_CODE, Markdown } from "./Markdown.js";
import { CHIP_SMALL } from "./Popover.js";
import { type ToolDiff, toolDiff, toolIcon, toolTitle, unfinishedVerb } from "./tools.js";
import { type Transcript, type TranscriptPrompt, turnEnds } from "./transcript.js";

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
const RESOLVED = "m-0 px-3 py-0 flex gap-2 text-[13px] text-dim-foreground min-w-0";

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-right"
      size={12}
      className={`flex-none [transition:transform_0.12s] motion-reduce:[transition:none]${open ? " [transform:rotate(90deg)]" : ""}`}
    />
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
    <span className="flex text-[var(--ok)]" role="img" aria-label="Done">
      <Icon name="ok" size={13} />
    </span>
  ) : (
    <span className="flex text-[var(--err)]" role="img" aria-label="Failed">
      <Icon name="failed" size={13} />
    </span>
  );
}

function Title({ call }: { call: ToolCall }) {
  const title = toolTitle(call.name, call.args);
  return (
    <span className="min-w-0 truncate">
      {call.result ? title.verb : unfinishedVerb(title.verb)}
      {title.subject && (
        <> {title.code ? <code className={INLINE_CODE}>{title.subject}</code> : title.subject}</>
      )}
    </span>
  );
}

/**
 * Opens the document a tool call wrote in the chat's preview panel; returns null for calls that
 * wrote none, or where the screen has no panel.
 */
export const PreviewOpener = createContext<((call: ToolCall) => (() => void) | null) | null>(null);

function PreviewChip({ open }: { open: () => void }) {
  return (
    <button
      type="button"
      className={cn(CHIP_SMALL, "flex-none")}
      title="Show it in the preview"
      onClick={open}
    >
      <Icon name="eye" size={12} />
      Preview
    </button>
  );
}

function ToolLine({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preview = useContext(PreviewOpener)?.(call);
  const output = call.result ? (call.result.error ?? call.result.output) : "";
  const line = (
    <button
      type="button"
      className={cn(TOOL_LINE, preview && "min-w-0 flex-1")}
      aria-expanded={open}
      aria-controls={id}
      onClick={() => setOpen((v) => !v)}
    >
      <Chevron open={open} />
      <Status call={call} />
      <Icon name={toolIcon(call.name)} size={13} className="flex-none text-dim-foreground" />
      <Title call={call} />
    </button>
  );
  return (
    <div className="flex flex-col gap-1">
      {preview ? (
        <div className="flex items-center gap-2">
          {line}
          <PreviewChip open={preview} />
        </div>
      ) : (
        line
      )}
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
  const preview = useContext(PreviewOpener)?.(call);
  const lines = all ? diff.lines : diff.lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = diff.lines.length - lines.length;
  return (
    <figure
      className="m-0 border-2 border-border rounded-base overflow-hidden bg-background shadow-shadow"
      aria-label={`Changes to ${diff.path}`}
    >
      <figcaption className="flex items-center gap-[10px] px-3 py-[10px] text-[13px] font-semibold text-muted-foreground border-b-2 border-b-border">
        <Status call={call} />
        <Icon name="edit" size={13} className="flex-none text-dim-foreground" />
        <span className="font-mono text-soft-foreground min-w-0 truncate">{diff.path}</span>
        {diff.created && <span className="text-dim-foreground">new file</span>}
        <span className="font-mono ml-auto text-[var(--ok)]">+{diff.added}</span>
        <span className="font-mono text-[var(--err)]">−{diff.removed}</span>
        {preview && <PreviewChip open={preview} />}
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

/**
 * Lets a screen draw some tool calls its own way, such as the coordinator's launched sessions as
 * live thread cards; it returns null for the calls it leaves to the ordinary tool line.
 */
export const ToolRenderer = createContext<((call: ToolCall) => ReactNode | null) | null>(null);

function Tool({ call }: { call: ToolCall }) {
  const custom = useContext(ToolRenderer)?.(call);
  if (custom) return custom;
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
  streaming = false,
}: {
  message: ChatMessage;
  thoughtMs: number[] | undefined;
  thinking: boolean;
  /** The turn is still being written, so its last text may end mid-link. */
  streaming?: boolean;
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
          return segment.content.trim() ? (
            <Markdown
              key={key}
              text={segment.content}
              streaming={streaming && i === segments.length - 1}
            />
          ) : null;
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
  "inline-flex items-center gap-1 cursor-pointer border-0 bg-transparent p-0 [font-family:inherit] [font-size:inherit] leading-[inherit] text-dim-foreground underline hover:text-foreground disabled:cursor-default disabled:opacity-50";

/** Fork from here and, at the end of an earlier turn, Rewind to here. */
function TurnActions({
  disabled,
  onFork,
  rewindTo,
}: {
  disabled: boolean;
  onFork?: ((rollbackFiles: boolean) => void) | undefined;
  /** Undoes the chat to the end of this turn; absent where a rewind cannot go. */
  rewindTo?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState<"fork" | "rewind" | null>(null);
  if (open === null)
    return (
      <div
        className={cn(
          FORK_ROW,
          "opacity-0 transition-opacity duration-[120ms] group-hover/turn:opacity-100 focus-within:opacity-100",
        )}
      >
        {onFork && (
          <button
            type="button"
            className={FORK_LINK}
            disabled={disabled}
            onClick={() => setOpen("fork")}
          >
            <Icon name="fork" size={12} />
            Fork from here
          </button>
        )}
        {rewindTo && (
          <button
            type="button"
            className={FORK_LINK}
            disabled={disabled}
            onClick={() => setOpen("rewind")}
          >
            <Icon name="rewind" size={12} />
            Rewind to here
          </button>
        )}
      </div>
    );
  if (open === "rewind")
    return (
      <fieldset className={FORK_ROW} aria-label="Rewind to here">
        <span>
          Drop the later turns from this chat and restore the files they edited? Redo brings them
          back until you send a new message.
        </span>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            setOpen(null);
            rewindTo?.();
          }}
        >
          Rewind
        </Button>
        <button type="button" className={FORK_LINK} onClick={() => setOpen(null)}>
          Cancel
        </button>
      </fieldset>
    );
  const pick = (rollbackFiles: boolean) => {
    setOpen(null);
    onFork?.(rollbackFiles);
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
      <button type="button" className={FORK_LINK} onClick={() => setOpen(null)}>
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
      <ul className="list-none m-[8px_0_0] p-0 flex flex-wrap gap-2" aria-label="Attached images">
        {images.map((image) => (
          <li key={image.label}>
            <button
              type="button"
              className="block p-0 border-2 border-border rounded-base bg-background overflow-hidden cursor-zoom-in"
              aria-label={`Open ${image.label}`}
              onClick={() => setOpen(image)}
            >
              <img
                src={storedImageUrl(image)}
                alt={image.label}
                className="block max-w-[160px] max-h-[120px] object-contain"
              />
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <dialog
          open
          className="fixed inset-0 z-50 w-full h-full max-w-none max-h-none m-0 p-8 border-none bg-overlay flex flex-col items-center justify-center gap-3"
          aria-label={open.label}
          onClick={() => setOpen(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(null);
            }
          }}
        >
          <img
            src={storedImageUrl(open)}
            alt={open.label}
            className="max-w-full max-h-[calc(100%-56px)] object-contain border-2 border-border rounded-base bg-background"
          />
          <Button variant="secondary" size="md" ref={(el) => el?.focus()}>
            Close
          </Button>
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
    <div
      className={`self-end max-w-[640px] bg-main text-main-foreground border-2 border-border rounded-base shadow-shadow px-4 py-3 leading-[1.6] text-[15px] whitespace-pre-wrap wrap-anywhere flex flex-col gap-[2px]${note === "Sending…" ? " opacity-[0.65]" : ""}`}
    >
      {note && (
        <span className="font-mono text-[11px] font-bold text-main-foreground opacity-75 uppercase tracking-[0.06em]">
          {note}
        </span>
      )}
      {text}
      {images && images.length > 0 && <BubbleImages images={images} />}
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
    <section
      className={`${PROMPT_CARD} gap-[10px] bg-fill-info text-main-foreground`}
      aria-label="Review the plan"
    >
      <p className={PROMPT_TITLE}>Review the plan</p>
      <p className="m-0 text-[12px] text-main-foreground">
        {prompt.steps.length} {prompt.steps.length === 1 ? "step" : "steps"} ·{" "}
        {prompt.depth === "full" ? "full plan with edits" : "light plan"} ·{" "}
        <span className="font-mono">{prompt.planFile}</span>
      </p>
      <div className="max-h-[420px] overflow-auto px-3 py-[10px] border-2 border-border rounded-base bg-raised text-foreground">
        <Markdown text={prompt.content} />
      </div>
      {revising ? (
        <form
          className={ROW}
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
            className="flex-1 min-w-[200px]"
            placeholder="What should change?"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || !feedback.trim()}>
            Send
          </Button>
          <Button variant="secondary" size="md" onClick={() => setRevising(false)}>
            Back
          </Button>
        </form>
      ) : (
        <div className={ROW}>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => onReview(prompt.id, { action: "execute" })}
          >
            Execute
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            title="Drops the conversation so far; the plan carries what the work needs."
            onClick={() => onReview(prompt.id, { action: "clear-execute" })}
          >
            Clear context and execute
          </Button>
          <Button variant="secondary" size="md" disabled={busy} onClick={() => setRevising(true)}>
            Revise
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => onReview(prompt.id, { action: "cancel" })}
          >
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}

const STEP_MARKS = { pending: "○", active: "◐", done: "✓", skipped: "–" } as const;
const STEP_TONE = {
  pending: undefined,
  active: "font-semibold",
  done: "text-muted-foreground",
  skipped: undefined,
} as const;

/** The checklist of a plan being carried out. */
function PlanChecklist({ plan }: { plan: ChatPlan }) {
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <section
      className="px-[14px] py-[10px] border-2 border-border rounded-base bg-raised shadow-sm-hard"
      aria-label="Plan"
    >
      <p className="m-0 mb-[6px] font-bold">
        {plan.title}{" "}
        <span className="text-dim-foreground">
          {done}/{plan.steps.length}
        </span>
      </p>
      <ol className="m-0 p-0 list-none flex flex-col gap-1 text-[13px]">
        {plan.steps.map((step) => (
          <li key={step.id} className={STEP_TONE[step.status]}>
            <span className="inline-block w-[1.4em] font-mono" aria-hidden="true">
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
  onEditSplit,
}: {
  entry: TranscriptPrompt;
  busy: boolean;
  onApprove: (id: string, approve: boolean, digest?: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onReviewPlan?: (id: string, review: PlanReview) => void;
  onEditSplit?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const { prompt, outcome } = entry;
  if (outcome) {
    if (prompt.kind === "plan-review")
      return (
        <p className={RESOLVED}>
          <span className={`flex-none font-medium ${OUTCOME_TONE[outcome] ?? ""}`}>
            {entry.action ? PLAN_OUTCOMES[entry.action] : OUTCOMES[outcome]}
          </span>
          <span className="truncate">{prompt.title}</span>
        </p>
      );
    const subject =
      prompt.kind === "question"
        ? prompt.question
        : prompt.kind === "split"
          ? prompt.title
          : prompt.kind === "workflow"
            ? `Run workflow ${prompt.workflow}`
            : prompt.kind === "outside-cwd"
              ? prompt.path
              : prompt.kind === "destructive"
                ? prompt.description
                : prompt.kind === "web-search"
                  ? prompt.query
                  : prompt.url;
    return (
      <p className={RESOLVED}>
        <span className={`flex-none font-medium ${OUTCOME_TONE[outcome] ?? ""}`}>
          {OUTCOMES[outcome]}
        </span>
        <span className="truncate">{subject}</span>
      </p>
    );
  }
  if (prompt.kind === "plan-review") {
    if (!onReviewPlan) return null;
    return <PlanReviewCard prompt={prompt} busy={busy} onReview={onReviewPlan} />;
  }
  if (prompt.kind === "split") {
    return (
      <section
        className={`${PROMPT_CARD} gap-[10px] bg-fill-info text-soft-foreground`}
        aria-label="Split proposal"
      >
        <p className={PROMPT_TITLE}>
          Split "{prompt.title}" into {prompt.flows.length}{" "}
          {prompt.mode === "runs"
            ? "parallel runs"
            : prompt.mode === "chats"
              ? "parallel chats"
              : "features of one initiative"}
          ?
        </p>
        <SplitFlows prompt={prompt} onCard />
        <div className={ROW}>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => onApprove(prompt.id, true, prompt.digest)}
          >
            Approve split
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => onApprove(prompt.id, false)}
          >
            Reject
          </Button>
          {onEditSplit && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              title="Reject this split and tell the coordinator what to change"
              onClick={() => onEditSplit(prompt.id)}
            >
              Edit
            </Button>
          )}
        </div>
      </section>
    );
  }
  if (prompt.kind === "workflow") {
    return (
      <section
        className={`${PROMPT_CARD} gap-[10px] bg-fill-info text-soft-foreground animate-rise motion-reduce:animate-none`}
        aria-label="Workflow proposal"
      >
        <p className={PROMPT_TITLE}>Run workflow {prompt.workflow}?</p>
        <WorkflowProposal prompt={prompt} onCard />
        <div className={ROW}>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => onApprove(prompt.id, true, prompt.digest)}
          >
            Run workflow
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => onApprove(prompt.id, false)}
          >
            Not now
          </Button>
        </div>
      </section>
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
  const title =
    prompt.kind === "destructive" && prompt.confirm
      ? "Approve this step?"
      : APPROVAL_TITLES[prompt.kind];
  return (
    <section
      className={`${PROMPT_CARD} gap-[10px] bg-fill-warn text-main-foreground`}
      aria-label={title}
    >
      <p className={PROMPT_TITLE}>{title}</p>
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
  onReviewPlan,
  onEditSplit,
  forking,
  onFork,
  onRewind,
  launchHref,
  launchActions,
}: {
  transcript: Transcript;
  deciding: ReadonlySet<string>;
  onApprove: (id: string, approve: boolean, digest?: string) => void;
  onAnswer: (id: string, answer: string) => void;
  /** Answers a plan review; without it plan reviews are not shown. */
  onReviewPlan?: (id: string, review: PlanReview) => void;
  /** Rejects a split card and asks for changes; without it split cards have no Edit. */
  onEditSplit?: (id: string) => void;
  forking?: boolean;
  /** Forks the session after `messageId`; absent while the session cannot be forked. */
  onFork?: (messageId: string, rollbackFiles: boolean) => void;
  /** Undoes the chat to checkpoint N; absent while the server cannot list checkpoints. */
  onRewind?: (checkpoint: number) => void;
  /** Where a coordinator's launch notice opens the item; without it the card has no Open. */
  launchHref?: (note: LaunchNote) => string;
  /** Stop or Close for a launched item, shown on the newest notice about it. */
  launchActions?: (note: LaunchNote) => ReactNode;
}) {
  const { messages, live, prompts, pending, notice, thoughtMs } = transcript;
  const running = transcript.turnId !== null;
  const waiting = prompts.some((p) => p.outcome === undefined);
  const lastLive = live?.segments?.at(-1);
  // The review card shows a proposed plan; the checklist follows one being carried out.
  const reviewing = prompts.some((p) => p.prompt.kind === "plan-review");
  const plan = transcript.plan && !reviewing ? transcript.plan : null;
  const ends = onRewind ? turnEnds(messages) : null;
  // A coordinator's wake-up on launched work is not shown; its notices are.
  const shown = messages.filter((m) => m.role !== "user" || m.showInChat !== false);
  const newestNotes = launchActions ? newestLaunchNotes(messages) : null;
  return (
    <>
      {shown.map((message) =>
        message.role === "user" ? (
          <UserBubble
            key={message.id}
            text={messageSender(message.content)?.text ?? message.content}
            {...(messageSender(message.content)
              ? { note: `From ${messageSender(message.content)?.from}` }
              : message.isSteering
                ? { note: "Sent while working" }
                : {})}
            {...(message.inputContext ? { context: message.inputContext } : {})}
            {...(message.images ? { images: message.images } : {})}
          />
        ) : message.role === "assistant" ? (
          <div key={message.id} className="group/turn flex min-w-0 flex-col gap-1.5">
            <Assistant message={message} thoughtMs={thoughtMs[message.id]} thinking={false} />
            {(onFork || ends?.has(message.id)) && !running && (
              <TurnActions
                disabled={forking === true}
                onFork={onFork && ((rollbackFiles) => onFork(message.id, rollbackFiles))}
                rewindTo={
                  onRewind && ends?.has(message.id)
                    ? () => onRewind(ends.get(message.id) ?? 0)
                    : undefined
                }
              />
            )}
          </div>
        ) : message.launch ? (
          <LaunchNoteCard
            key={message.id}
            note={message.launch}
            {...(launchHref ? { href: launchHref(message.launch) } : {})}
            {...(launchActions && newestNotes?.has(message.id)
              ? { actions: launchActions(message.launch) }
              : {})}
          />
        ) : (
          <p
            key={message.id}
            className="self-center m-0 px-3 py-1 border-2 border-dashed border-border rounded-base text-[12px] text-muted-foreground text-center"
          >
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
          streaming={running}
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
          {...(onEditSplit ? { onEditSplit } : {})}
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
      {transcript.compacting && (
        <p
          className={`${NOTICE} flex items-center gap-[10px] text-dim-foreground`}
          aria-live="polite"
        >
          <span className={SPINNER} aria-hidden="true">
            <span className={SPINNER_RING} />
          </span>
          Compacting the conversation…
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
