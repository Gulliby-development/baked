/**
 * Lines of the terminal coordinator view, kept free of React so tests can check them directly.
 * Every line is already wrapped to the view's width, so the view shows the tail that fits.
 */
import { launchControl } from "../../core/chat/coordinator-control.js";
import {
  type LaunchedView,
  launchLabel,
  launchNoteText,
} from "../../core/chat/coordinator-launch.js";
import { parsePeerMessage } from "../../core/chat/peer-messages.js";
import type { ChatPrompt } from "../../core/chat/sessions.js";
import type { ChatMessage, LaunchNote } from "../../types/index.js";

export type LineTone = "user" | "assistant" | "muted" | "tool" | "accent" | "warning" | "error";

export interface ViewLine {
  text: string;
  tone: LineTone;
}

/** The message Edit starts after rejecting a split card, as the desktop app does. */
export const SPLIT_EDIT_PREFIX = "Change the split: ";

/** Splits `text` into lines of at most `width` columns, breaking at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    let line = raw.trimEnd();
    if (!line) {
      out.push("");
      continue;
    }
    while (line.length > max) {
      const space = line.lastIndexOf(" ", max);
      const cut = space > 0 ? space : max;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

/** Wraps `text` under a label: the first line starts with it, the rest are indented as far. */
function labelled(label: string, text: string, width: number, tone: LineTone): ViewLine[] {
  const pad = " ".repeat(label.length);
  return wrap(text, width - label.length).map((line, i) => ({
    text: `${i === 0 ? label : pad}${line}`,
    tone,
  }));
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`;
  return `${n} tokens`;
}

/** The tone of a launched item's status: waiting for a person, failed, or otherwise. */
function statusTone(status: string, fallback: LineTone): LineTone {
  if (/^waiting/.test(status)) return "warning";
  if (/^(failed|cancelled|deleted|blocked)/.test(status)) return "error";
  return fallback;
}

/** The why of a launched item, unless it only repeats the title. */
const whyBesides = (why: string, title: string | undefined): string =>
  title && why.startsWith(title) ? "" : why;

/**
 * One line per open launched item: its title (or kind and id), status, tokens, task and why. With
 * `selected`, that item is marked for the stop and close keys. Closed items are counted at the end.
 */
export function launchedLines(
  launched: LaunchedView[],
  width: number,
  selected?: number,
): ViewLine[] {
  const open = launched.filter((entry) => !entry.closed);
  const closed = launched.length - open.length;
  const lines = open.flatMap((entry, i) => {
    const task = entry.task
      ? ` · ${entry.task.state === "local" ? "local task" : entry.task.ref}`
      : "";
    const status = entry.activity ? `${entry.status} (${entry.activity})` : entry.status;
    const head = `${entry.active ? "●" : "○"} ${launchLabel(entry)}: ${status} · ${tokens(entry.tokens)}${task}`;
    const why = whyBesides(entry.why, entry.title);
    return labelled(
      selected === undefined ? "" : i === selected ? "› " : "  ",
      why ? `${head} · ${why}` : head,
      width,
      statusTone(entry.status, entry.active ? "accent" : "muted"),
    );
  });
  if (closed) lines.push({ text: `${closed} closed`, tone: "muted" });
  return lines;
}

/** The launched items the stop and close keys move over: the open ones. */
export const openLaunched = (launched: LaunchedView[]): LaunchedView[] =>
  launched.filter((entry) => !entry.closed);

/** At most this many lines of a launched session's answer show under its note. */
const RESULT_ROWS = 6;

/** A coordinator's notice about launched work: a marked headline in its status tone, then why. */
function launchNoteLines(note: LaunchNote, width: number): ViewLine[] {
  const closed = note.event === "task-closed";
  const lines = labelled(
    closed ? "  ✓ " : "  ◆ ",
    launchNoteText(note),
    width,
    closed ? "accent" : statusTone(note.status, "accent"),
  );
  const why = closed ? "" : whyBesides(note.why, note.title);
  if (why) lines.push(...labelled("    ", why, width, "muted"));
  if (note.result) {
    const bar = "    │ ";
    const result = wrap(note.result, width - bar.length).map(
      (line): ViewLine => ({ text: `${bar}${line}`, tone: "assistant" }),
    );
    lines.push(...result.slice(0, RESULT_ROWS));
    if (result.length > RESULT_ROWS)
      lines.push({ text: `    │ … ${result.length - RESULT_ROWS} more lines`, tone: "muted" });
  }
  return lines;
}

/** The conversation, then the text the running turn has streamed so far. */
export function messageLines(messages: ChatMessage[], live: string, width: number): ViewLine[] {
  const lines: ViewLine[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      // A thread's message to the coordinator is labelled as the thread's, not the person's.
      const peer = parsePeerMessage(message.content);
      if (peer) lines.push(...labelled("from ", `"${peer.title}": ${peer.text}`, width, "accent"));
      else lines.push(...labelled("you  ", message.content, width, "user"));
    } else if (message.role === "assistant") {
      for (const call of message.toolCalls ?? [])
        lines.push(...labelled("  ↳ ", call.name, width, "tool"));
      if (message.content.trim())
        lines.push(...labelled("     ", message.content, width, "assistant"));
    } else if (message.launch) {
      lines.push(...launchNoteLines(message.launch, width));
    } else if (message.showInChat !== false) {
      lines.push(...labelled("  · ", message.content, width, "muted"));
    }
    lines.push({ text: "", tone: "muted" });
  }
  if (live.trim()) lines.push(...labelled("     ", live, width, "assistant"));
  return lines;
}

/** The pending prompt as a card the keys below it answer. */
export function promptLines(prompt: ChatPrompt, width: number): ViewLine[] {
  switch (prompt.kind) {
    case "split": {
      const lines = labelled(
        "Split: ",
        `${prompt.title} (${prompt.mode === "runs" ? "parallel runs" : "one initiative"})`,
        width,
        "warning",
      );
      prompt.flows.forEach((flow, i) => {
        lines.push(
          ...labelled(`${i + 1}. `, `${flow.title} [${flow.id}] · ${flow.task}`, width, "accent"),
        );
        if (flow.paths.length)
          lines.push(...labelled("   ", flow.paths.join(", "), width, "muted"));
        if (flow.dependsOn.length)
          lines.push(...labelled("   ", `After ${flow.dependsOn.join(", ")}`, width, "muted"));
      });
      return lines;
    }
    case "question":
      return [
        ...labelled("? ", prompt.question, width, "warning"),
        ...prompt.options.flatMap((option, i) =>
          labelled(
            `${i + 1}. `,
            option.description ? `${option.label}: ${option.description}` : option.label,
            width,
            "accent",
          ),
        ),
      ];
    case "plan-review":
      return labelled("Plan: ", prompt.title, width, "warning");
    case "outside-cwd":
      return labelled(
        "Allow? ",
        `${prompt.tool} outside the project: ${prompt.path}`,
        width,
        "warning",
      );
    case "destructive":
      return labelled("Allow? ", prompt.description, width, "warning");
    case "web-search":
      return labelled("Allow? ", `web search: ${prompt.query}`, width, "warning");
    case "fetch-page":
      return labelled("Allow? ", `fetch ${prompt.url}`, width, "warning");
  }
}

/** What each key does in the current state; the view's footer. */
export function keyHints(
  prompt: ChatPrompt | undefined,
  working: boolean,
  item?: LaunchedView,
): { key: string; label: string }[] {
  const hints: { key: string; label: string }[] = [];
  if (prompt?.kind === "split")
    hints.push(
      { key: "^Y", label: "approve split" },
      { key: "^N", label: "reject" },
      { key: "^E", label: "edit" },
    );
  else if (prompt?.kind === "question")
    hints.push({ key: "Enter", label: "answer (number or text)" });
  else if (prompt)
    hints.push(
      { key: "^Y", label: prompt.kind === "plan-review" ? "approve" : "allow" },
      { key: "^N", label: prompt.kind === "plan-review" ? "cancel" : "deny" },
    );
  if (!prompt) hints.push({ key: "Enter", label: "send" });
  if (!prompt && item) {
    hints.push({ key: "Tab", label: "select launched" });
    const control = launchControl(item);
    if (control === "stop")
      hints.push({ key: "^X", label: item.kind === "initiative" ? "pause it" : "stop it" });
    else if (control === "close") hints.push({ key: "^R", label: "close it" });
  }
  if (!prompt && !working) hints.push({ key: "^S", label: "what's happening" });
  hints.push({ key: "Esc", label: working ? "stop" : "back" });
  return hints;
}

/** A question's answer: an option's number picks that option, other text is the answer itself. */
export function questionAnswer(
  prompt: Extract<ChatPrompt, { kind: "question" }>,
  typed: string,
): string {
  const text = typed.trim();
  const index = /^\d+$/.test(text) ? Number(text) - 1 : -1;
  return prompt.options[index]?.value ?? text;
}
