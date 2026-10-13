import type { ChatPlan, ChatPrompt, ToolCall } from "../../client/chat.js";
import { toolTitle, unfinishedVerb } from "../chat/tools.js";
import type { Transcript } from "../chat/transcript.js";

/** What a thread card shows about a session the coordinator launched, from its live transcript. */
export interface ThreadView {
  state: "loading" | "working" | "waiting" | "done" | "idle" | "gone";
  /** What it does right now: its current tool, "Thinking…", "Writing…" or what it waits for. */
  activity: string | null;
  /** The first lines of its latest answer; null before it has answered. */
  answer: string | null;
  plan: { title: string; done: number; steps: ChatPlan["steps"] } | null;
  tokens: number;
  /** Its turns: messages from the person or the coordinator that started one. */
  turns: number;
}

/** The session id `launch_session` reports in its result: "Started session ID (working)". */
export function launchedSessionId(call: ToolCall): string | null {
  if (call.name !== "launch_session" || !call.result?.success) return null;
  return /session ([0-9a-f-]{36})/.exec(call.result.output)?.[1] ?? null;
}

function promptText(prompt: ChatPrompt): string {
  switch (prompt.kind) {
    case "question":
      return `Asks: ${prompt.question}`;
    case "plan-review":
      return `Plan to review: ${prompt.title}`;
    case "split":
      return `Split to approve: ${prompt.title}`;
    case "workflow":
      return `Asks to run the ${prompt.workflow} workflow`;
    case "destructive":
      return `Asks to allow: ${prompt.description}`;
    case "outside-cwd":
      return `Asks to allow ${prompt.tool} outside the project`;
    case "web-search":
      return `Asks to search the web for ${prompt.query}`;
    case "fetch-page":
      return `Asks to fetch ${prompt.url}`;
  }
}

/** The running turn's current step: its last unfinished tool call, else thinking or writing. */
function currentStep(t: Transcript): string {
  const live = t.live;
  const calls = live?.toolCalls ?? [];
  const running = [...calls].reverse().find((c) => !c.result);
  if (running) {
    const { verb, subject } = toolTitle(running.name, running.args);
    return subject ? `${unfinishedVerb(verb)} ${subject}` : unfinishedVerb(verb);
  }
  if (t.thinkingSince !== null) return "Thinking…";
  const last = live?.segments?.at(-1);
  if (last?.type === "text" && last.content.trim()) return "Writing the answer…";
  return "Working…";
}

/** The first `lines` non-empty lines of `text`, joined; an ellipsis marks what was left out. */
export function firstLines(text: string, lines: number): string {
  const all = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const shown = all.slice(0, lines).join("\n");
  return all.length > lines ? `${shown} …` : shown;
}

/** The card's view of a launched session's transcript; `null` while it is not loaded. */
export function threadView(t: Transcript | null, missing = false): ThreadView {
  if (missing)
    return { state: "gone", activity: null, answer: null, plan: null, tokens: 0, turns: 0 };
  if (!t?.session)
    return { state: "loading", activity: null, answer: null, plan: null, tokens: 0, turns: 0 };
  const waiting = t.prompts.find((p) => p.outcome === undefined);
  const running = t.turnId !== null;
  const answered = [...t.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content.trim());
  const state = waiting
    ? "waiting"
    : running
      ? "working"
      : t.messages.some((m) => m.role === "assistant")
        ? "done"
        : "idle";
  return {
    state,
    activity: waiting ? promptText(waiting.prompt) : running ? currentStep(t) : null,
    answer: answered ? firstLines(answered.content, 3) : null,
    plan: t.plan
      ? {
          title: t.plan.title,
          done: t.plan.steps.filter((s) => s.status === "done").length,
          steps: t.plan.steps,
        }
      : null,
    tokens: t.usage.input + t.usage.output,
    turns: t.messages.filter((m) => m.role === "user" && !m.isSteering).length,
  };
}
