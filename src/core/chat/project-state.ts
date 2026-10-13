/**
 * The coordinator's read-only view of the project: workflow runs, initiatives, chat sessions,
 * token usage and what waits for a person, as compact text so a status question costs few tokens. The data comes
 * from the same services `baked serve` answers from; the coordinator reads it with the
 * `project_state` tool.
 */
import { tool } from "ai";
import { z } from "zod";
import type { ChatMessage } from "../../types/index.js";
import type { AttentionItem } from "../workflows/attention.js";
import type { InitiativeView } from "../workflows/initiatives/service.js";
import type { NativeWorkflowService } from "../workflows/service.js";
import { terminalStates } from "../workflows/state-machine.js";
import { type UsageSummary, usageSummary } from "../workflows/usage.js";
import { usageMarkdown } from "../workflows/usage-markdown.js";
import {
  type RunSummary,
  readWorkflowSummaries,
  readWorkflowSummary,
  readWorkflowView,
} from "../workflows/view.js";
import type { SessionSummary } from "./sessions.js";

export const STATE_TOOL = "project_state";

/** Where project state comes from; the API server builds one over its services. */
export interface ProjectStateSource {
  runs(limit: number): RunSummary[];
  run(id: string): RunDetail;
  initiatives(): InitiativeView[];
  initiative(id: string): InitiativeView;
  attention(): AttentionItem[];
  /** Token usage and cost of workflow runs over the last `days` days, by model and stage. */
  usage?(days: number): UsageSummary;
}

/** What the coordinator reads about one run. */
export interface RunDetail {
  summary: RunSummary;
  stages: { id: string; status: string }[];
  tasks: { id: string; title: string; status: string }[];
  /** `digest` and the parsed `body` let the coordinator's approval rules read a plan approval. */
  pendingRequests: { id: string; kind: string; digest?: string; body?: unknown }[];
  changedFiles: number;
}

/** Chat sessions as the coordinator sees them; the service itself implements it. */
export interface SessionSource {
  list(limit: number): SessionSummary[];
  messages(id: string): { title: string; messages: ChatMessage[] };
}

const RUN_LIMIT = 15;
const SESSION_LIMIT = 15;
const LAST_MESSAGES = 6;
const MESSAGE_CHARS = 400;
const USAGE_DAYS = 7;

const isActive = (summary: RunSummary): boolean =>
  !terminalStates.includes(summary.snapshot.status);
const short = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const ago = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

function runLine(r: RunSummary, now: number): string {
  const s = r.snapshot;
  const stage = s.stageId ? ` stage ${s.stageId} (${r.stage.index + 1}/${r.stage.total})` : "";
  const tasks = r.tasks.total ? ` tasks ${r.tasks.done}/${r.tasks.total}` : "";
  const waiting = r.pendingKind ? ` waits: ${r.pendingKind}` : "";
  return `- run ${s.runId} [${s.status}${s.reason && s.reason !== "none" ? `: ${s.reason}` : ""}]${stage}${tasks} tokens ${r.budget.tokens}/${r.budget.maxTokens}${waiting}, updated ${ago(r.updatedAt, now)}: ${short(r.title ?? s.featureId, 120)}`;
}

function initiativeLine(i: InitiativeView): string {
  const done = i.features.filter((f) => f.state === "accepted").length;
  return `- initiative ${i.initiativeId} [${i.status}] features ${done}/${i.features.length} accepted, next: ${i.next.kind}: ${short(i.title, 120)}`;
}

function attentionLine(a: AttentionItem): string {
  const where =
    a.source === "chat"
      ? `session ${a.sessionId}`
      : a.source === "initiative"
        ? `initiative ${a.initiativeId}${a.runId ? ` run ${a.runId}` : ""}`
        : `run ${a.runId}`;
  const request = a.requestId ? ` request ${a.requestId}` : "";
  return `- ${where}: ${a.kind}${request}${a.blocking ? "" : " (advisory)"}${a.title ? ` (${short(a.title, 80)})` : ""}`;
}

function sessionLine(s: SessionSummary, now: number): string {
  return `- session ${s.id} [${s.state}] ${s.messageCount} messages, updated ${ago(s.updatedAt, now)}: ${short(s.title, 100)}`;
}

const section = (title: string, lines: string[], empty: string): string =>
  [`## ${title}`, ...(lines.length ? lines : [empty])].join("\n");

export type StateView =
  | "overview"
  | "runs"
  | "run"
  | "initiatives"
  | "initiative"
  | "sessions"
  | "session"
  | "attention"
  | "usage";

/** Renders one view of the project state; throws for an unknown id. */
export function renderState(
  view: StateView,
  id: string | undefined,
  state: ProjectStateSource | null,
  sessions: SessionSource,
  now = Date.now(),
  days = USAGE_DAYS,
): string {
  const need = (): string => {
    if (!id) throw new Error(`Give the id of the ${view} to show`);
    return id;
  };
  const noWorkflows = "Workflow runs and initiatives are not available in this server.";
  switch (view) {
    case "overview": {
      const runs = state?.runs(50) ?? [];
      const active = runs.filter(isActive);
      const initiatives = (state?.initiatives() ?? []).filter(
        (i) => !["completed", "cancelled", "failed"].includes(i.status),
      );
      const attention = state?.attention() ?? [];
      const busy = sessions.list(50).filter((s) => s.state !== "idle");
      return [
        section("Waiting for a person", attention.map(attentionLine), "Nothing."),
        section(
          "Active runs",
          active.slice(0, RUN_LIMIT).map((r) => runLine(r, now)),
          state ? "None." : noWorkflows,
        ),
        section("Open initiatives", initiatives.map(initiativeLine), "None."),
        section(
          "Sessions with a turn running or a prompt open",
          busy.map((s) => sessionLine(s, now)),
          "None.",
        ),
      ].join("\n\n");
    }
    case "runs":
      if (!state) return noWorkflows;
      return section(
        "Runs, newest first",
        state.runs(RUN_LIMIT).map((r) => runLine(r, now)),
        "No runs yet.",
      );
    case "run": {
      if (!state) return noWorkflows;
      const run = state.run(need());
      return [
        runLine(run.summary, now).slice(2),
        `Stages: ${run.stages.map((s) => `${s.id} ${s.status}`).join(", ") || "none"}`,
        section(
          "Tasks",
          run.tasks.map((t) => `- ${t.id} [${t.status}] ${short(t.title, 120)}`),
          "No tasks yet.",
        ),
        section(
          "Pending requests",
          run.pendingRequests.map((r) => `- ${r.id}: ${r.kind}`),
          "None.",
        ),
        `Changed files: ${run.changedFiles}`,
      ].join("\n\n");
    }
    case "initiatives":
      if (!state) return noWorkflows;
      return section("Initiatives", state.initiatives().map(initiativeLine), "No initiatives yet.");
    case "initiative": {
      if (!state) return noWorkflows;
      const i = state.initiative(need());
      return [
        initiativeLine(i).slice(2),
        section(
          "Features",
          i.features.map(
            (f) =>
              `- ${f.id} [${f.state}]${f.runId ? ` run ${f.runId} ${f.runStatus ?? ""}` : ""}${f.blockers.length ? ` blocked: ${f.blockers.map((b) => short(b, 120)).join("; ")}` : ""}: ${short(f.title, 100)}`,
          ),
          "No features yet.",
        ),
        section(
          "Pending decisions",
          i.pendingDecisions.map(
            (d) => `- ${d.kind} request ${d.requestId}${d.featureId ? ` (${d.featureId})` : ""}`,
          ),
          "None.",
        ),
      ].join("\n\n");
    }
    case "sessions":
      return section(
        "Chat sessions, most recent first",
        sessions.list(SESSION_LIMIT).map((s) => sessionLine(s, now)),
        "No sessions yet.",
      );
    case "session": {
      const { title, messages } = sessions.messages(need());
      const last = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-LAST_MESSAGES)
        .map((m) => `- ${m.role}: ${short(m.content || "(tool calls only)", MESSAGE_CHARS)}`);
      return section(`Last messages of "${short(title, 100)}"`, last, "No messages yet.");
    }
    case "attention":
      return section(
        "Waiting for a person",
        (state?.attention() ?? []).map(attentionLine),
        "Nothing.",
      );
    case "usage":
      if (!state?.usage) return noWorkflows;
      return usageMarkdown(state.usage(Math.min(Math.max(Math.round(days), 1), 366)), now);
  }
}

/** The tool the coordinator reads project state with. */
export function stateTool(state: ProjectStateSource | null, sessions: SessionSource) {
  return tool({
    description:
      "Read the project's state: overview (what runs and what waits for a person), runs, run (id), initiatives, initiative (id), sessions, session (id: its last messages), attention or usage (tokens and estimated cost of workflow runs by model and stage over the last `days` days, default 7). Read-only; answers are compact summaries.",
    inputSchema: z.strictObject({
      view: z.enum([
        "overview",
        "runs",
        "run",
        "initiatives",
        "initiative",
        "sessions",
        "session",
        "attention",
        "usage",
      ]),
      id: z.string().optional().describe("Run, initiative or session id for the single views"),
      days: z.number().int().min(1).max(366).optional().describe("For usage: the window in days"),
    }),
    execute: async ({ view, id, days }) => {
      try {
        return {
          success: true,
          output: renderState(view, id, state, sessions, Date.now(), days),
        };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

/** A state source over the workflow and initiative services of `baked serve`. */
export function serviceStateSource(
  service: NativeWorkflowService,
  initiatives: { list(): InitiativeView[]; view(id: string): InitiativeView },
  attention: () => AttentionItem[],
): ProjectStateSource {
  return {
    runs: (limit) => readWorkflowSummaries(service, limit),
    run: (id) => {
      const summary = readWorkflowSummary(service, id);
      const view = readWorkflowView(service, id);
      return {
        summary,
        stages: view.stages.map((s) => ({ id: s.id, status: s.status })),
        tasks: view.tasks
          .filter((t) => t.status !== "invalidated")
          .map((t) => ({ id: t.id, title: taskTitle(t.definition_json, t.id), status: t.status })),
        pendingRequests: view.requests
          .filter((r) => r.status === "pending")
          .map((r) => ({ id: r.id, kind: r.kind, digest: r.digest, body: parseBody(r.body_json) })),
        changedFiles: view.changes.length,
      };
    },
    initiatives: () => initiatives.list(),
    initiative: (id) => initiatives.view(id),
    attention,
    usage: (days) => usageSummary(service.store, { days, groupBy: ["model", "stage"] }),
  };
}

function parseBody(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function taskTitle(definition: string, fallback: string): string {
  try {
    const parsed = JSON.parse(definition) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : fallback;
  } catch {
    return fallback;
  }
}
