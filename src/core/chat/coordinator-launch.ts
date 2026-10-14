/**
 * What the project coordinator launches and how it follows it. A launch adds an entry to the
 * brief's `launched` section, which is the link table; `syncLaunched` refreshes each entry's
 * status and tells the coordinator, in its transcript, when an item finishes, fails or waits for a
 * person. Decisions stay on the item: no tool here answers a run's or a session's requests.
 * Every flow of a split belongs to a task: a GitHub issue it links or creates, or a local task
 * when the project has no GitHub token.
 */
import { tool } from "ai";
import { z } from "zod";
import type { AppConfig, ChatMessage, LaunchNote, PermissionMode } from "../../types/index.js";
import { hashJson } from "../specs/hash.js";
import {
  InitiativeFeatureSchema,
  type InitiativePlan,
  MAX_FEATURES,
  MIN_FEATURES,
  planStructureProblems,
} from "../workflows/initiatives/plan.js";
import {
  createIssue,
  fetchIssue,
  type IssueSource,
  issueTarget,
} from "../workflows/issue-source.js";
import { assessRequest, type WorkflowProposal } from "../workflows/preset-router.js";
import { terminalStates } from "../workflows/state-machine.js";
import type { DefinitionSummary } from "../workflows/v2/definitions.js";
import type { RunApprover } from "./approval-rules.js";
import { BriefStore, type LaunchedEntry } from "./coordinator.js";
import { describePrompt, type ProjectStateSource } from "./project-state.js";
import type { ChatMode, ChatPrompt, ChatService, ChatSession } from "./sessions.js";

export const LAUNCH_TOOLS = [
  "list_workflows",
  "launch_session",
  "start_run",
  "control_run",
  "start_initiative",
  "propose_split",
  "propose_chats",
  "message_session",
  "answer_session",
] as const;
export const DEFAULT_MAX_ACTIVE = 3;
export const DEFAULT_MAX_TOKENS = 20_000_000;

export type FlowTask = NonNullable<LaunchedEntry["task"]>;

/** Reads and creates the GitHub issues flows belong to. */
export interface TaskTracker {
  /** The repository new issues go to, or null when none can be created (no token or remote). */
  target(): Promise<string | null>;
  /** The open issue a reference names, as `owner/name#N`. */
  link(reference: string): Promise<FlowTask>;
  create(input: { title: string; body: string; parent?: string }): Promise<{
    task: FlowTask;
    warning?: string;
  }>;
  /** Whether the issue is closed now, or null when it cannot be read. */
  closed(ref: string): Promise<boolean | null>;
}

/** Starts runs and initiatives through the server's own start paths. */
export interface ProjectLauncher {
  /**
   * `worktree` runs the run in its own Git worktree, so several execute side by side. With
   * `issue` the run starts from that issue, `prompt` adds to it, and delivery closes it.
   */
  startRun(input: {
    prompt: string;
    workflow?: string;
    feature?: string;
    worktree?: boolean;
    issue?: string;
  }): Promise<{ runId: string }>;
  /**
   * With `plan` the initiative skips decomposition; `approveSplit` then approves that split at
   * once, for a split the user already approved in the coordinator.
   */
  startInitiative(input: {
    initiativeId: string;
    prompt: string;
    plan?: InitiativePlan;
    approveSplit?: boolean;
    /** The issue of each feature of `plan`; its runs start from it and delivery closes it. */
    featureIssues?: Record<string, IssueSource>;
  }): Promise<{ initiativeId: string }>;
  /** Issues for flows; without it every flow gets a local task. */
  tasks?: TaskTracker;
  /** Cancels a run, as `POST /v1/workflow/runs/:id/cancel` does. */
  cancelRun?(runId: string): Promise<void>;
  /** Pauses an initiative and its running feature runs; an initiative has no cancel. */
  pauseInitiative?(initiativeId: string): Promise<void>;
  /** Approves a run's plan and continues it; the approval rules use it (`approval-rules.ts`). */
  approveRun?: RunApprover["approveRun"];
  /**
   * Answers a pending request of a run or cancels it, as `baked workflow approve|reject|cancel`
   * does; an approved run goes on in the background. Without it the coordinator cannot control
   * runs.
   */
  control?(input: RunControl): Promise<void>;
}

/** One control action on a run the coordinator launched; the user approved it first. */
export type RunControl =
  | { runId: string; action: "approve"; requestId: string; digest: string }
  | { runId: string; action: "reject"; requestId: string; reason: string }
  | { runId: string; action: "cancel" };

/** The workflows a project can run, and the one BAKED proposes for a request. */
export interface WorkflowCatalog {
  list(): DefinitionSummary[];
  propose(request: string): WorkflowProposal;
}

/** Tasks as GitHub issues, read and created with `workflows.delivery.tokenEnv`. */
export function githubTasks(
  workspace: string,
  config: AppConfig,
  options: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): TaskTracker {
  const asTask = (issue: { repository: string; number: number; url: string; state: string }) => ({
    ref: `${issue.repository}#${issue.number}`,
    url: issue.url,
    state: issue.state === "closed" ? ("closed" as const) : ("open" as const),
  });
  return {
    target: async () => (await issueTarget(workspace, config, options.env))?.repository ?? null,
    link: async (reference) => asTask(await fetchIssue(workspace, config, reference, options)),
    create: async (input) => {
      const { issue, warning } = await createIssue(workspace, config, input, options);
      return { task: asTask(issue), ...(warning ? { warning } : {}) };
    },
    closed: async (ref) =>
      fetchIssue(workspace, config, ref, options).then(
        (issue) => issue.state === "closed",
        () => null,
      ),
  };
}

export function coordinatorLimits(config: AppConfig): { maxActive: number; maxTokens: number } {
  return {
    maxActive: config.coordinator?.maxActive ?? DEFAULT_MAX_ACTIVE,
    maxTokens: config.coordinator?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/** Where a launched run is: its stages in order and its tasks. */
export interface RunProgress {
  /** The stage running or waiting now; null before the first or after the last. */
  stage: string | null;
  stages: { id: string; status: string }[];
  tasks: { done: number; total: number };
}

const STAGE_MARKS: Record<string, string> = {
  completed: "✓",
  skipped: "–",
  running: "▸",
  waiting: "◆",
  failed: "✗",
  interrupted: "✗",
};

/** A run's stages as one line: `✓ spec  ▸ plan  · tasks`, then its tasks done. */
export function stageTrack(progress: RunProgress): string {
  const stages = progress.stages.map((s) => `${STAGE_MARKS[s.status] ?? "·"} ${s.id}`).join("  ");
  const tasks = progress.tasks.total
    ? `  (tasks ${progress.tasks.done}/${progress.tasks.total})`
    : "";
  return `${stages}${tasks}`;
}

/** A launched item as it is now: its status word, whether it still runs, and its tokens. */
export interface LiveState {
  status: string;
  active: boolean;
  tokens: number;
  progress?: RunProgress;
}

/** Statuses the coordinator is told about; others only update the brief. */
const NOTEWORTHY = /^(done|waiting|completed|failed|cancelled|deleted|blocked)/;

function sessionState(chat: ChatService, id: string): LiveState {
  let session: ChatSession;
  try {
    session = chat.get(id);
  } catch {
    return { status: "deleted", active: false, tokens: 0 };
  }
  const { state, messageCount } = session.summary();
  const { usage } = session.detail();
  const tokens = usage.input + usage.output;
  if (state === "waiting") return { status: "waiting for you", active: true, tokens };
  if (state === "working") return { status: "working", active: true, tokens };
  return { status: messageCount > 1 ? "done" : "idle", active: false, tokens };
}

/** The launched item's live status, read from its session, run or initiative. */
export function liveState(
  chat: ChatService,
  state: ProjectStateSource | null,
  entry: LaunchedEntry,
): LiveState {
  if (entry.kind === "session") return sessionState(chat, entry.id);
  if (!state) return { status: entry.status, active: false, tokens: 0 };
  try {
    if (entry.kind === "run") {
      const { summary, stages } = state.run(entry.id);
      const status = summary.snapshot.status;
      const active = !terminalStates.includes(status);
      return {
        progress: {
          stage: active ? (summary.snapshot.stageId ?? null) : null,
          stages,
          tasks: summary.tasks,
        },
        status: summary.pendingKind
          ? `waiting: ${summary.pendingKind}`
          : summary.snapshot.reason !== "none" && status !== "completed"
            ? `${status}: ${summary.snapshot.reason}`
            : status,
        active,
        tokens: summary.snapshot.tokenUsage,
      };
    }
    const view = state.initiative(entry.id);
    if (entry.feature) {
      const feature = view.features.find((f) => f.id === entry.feature);
      if (!feature) return { status: "deleted", active: false, tokens: 0 };
      // An accepted feature reads as a completed run, so its task is checked for a merge.
      const done = feature.state === "accepted";
      return {
        status: done
          ? "completed"
          : feature.pendingRequests.length
            ? `waiting: ${feature.pendingRequests[0]?.kind}`
            : feature.state.replaceAll("_", " "),
        active: !done && !["failed"].includes(feature.state),
        tokens: feature.usage.tokens,
      };
    }
    const active = !["completed", "cancelled", "failed"].includes(view.status);
    return {
      status: view.pendingDecisions.length
        ? `waiting: ${view.pendingDecisions[0]?.kind}`
        : view.status,
      active,
      tokens: view.budget.used.tokens,
    };
  } catch {
    return { status: "deleted", active: false, tokens: 0 };
  }
}

/**
 * A launched entry with its live status, whether it still runs and the tokens it used; a working
 * session also says which tool it is in, a session with its own worktree names it, and a run
 * has its stage progress.
 */
export type LaunchedView = LaunchedEntry & {
  active: boolean;
  tokens: number;
  activity?: string;
  worktree?: { path: string; branch: string };
  progress?: RunProgress;
};

/** The tool a launched session's turn is in now. */
function activityOf(chat: ChatService, entry: LaunchedEntry): string | null {
  if (entry.kind !== "session") return null;
  try {
    return chat.get(entry.id).activity;
  } catch {
    return null;
  }
}

/** The entry's title, or for a session recorded without one, the session's own title. */
function titleOf(chat: ChatService, entry: LaunchedEntry): string | undefined {
  if (entry.title || entry.kind !== "session") return entry.title;
  try {
    return chat.get(entry.id).summary().title;
  } catch {
    return undefined;
  }
}

/** A launched session's own worktree and branch, when it has one. */
function worktreeOf(
  chat: ChatService,
  entry: LaunchedEntry,
): { worktree?: { path: string; branch: string } } {
  if (entry.kind !== "session") return {};
  try {
    const { worktree } = chat.get(entry.id).summary();
    return worktree ? { worktree } : {};
  } catch {
    return {};
  }
}

/** How a launched session sees a message the coordinator sent it. */
export const COORDINATOR_MESSAGE_PREFIX = "Message from the project coordinator:\n\n";

/** The longest result a launch note carries from a session's last answer. */
export const LAUNCH_RESULT_MAX = 2000;

/** How many answers a launched session has given; 0 when it is gone. */
function sessionAnswers(chat: ChatService, id: string): number {
  try {
    return chat.get(id).messages.filter((m) => m.role === "assistant").length;
  } catch {
    return 0;
  }
}

/** What a launched session answered last, for its launch note; null while it has said nothing. */
export function sessionResult(chat: ChatService, id: string): string | null {
  let messages: ChatMessage[];
  try {
    messages = chat.get(id).messages;
  } catch {
    return null;
  }
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  if (!last) return null;
  const text = last.content.trim();
  return text.length > LAUNCH_RESULT_MAX ? `${text.slice(0, LAUNCH_RESULT_MAX - 1)}…` : text;
}

/** What a launched session waits on, for its launch note; null when it waits on nothing. */
export function sessionAsks(chat: ChatService, id: string): string | null {
  let prompts: ChatPrompt[];
  try {
    prompts = chat.get(id).pendingPrompts;
  } catch {
    return null;
  }
  return prompts.length ? prompts.map((p) => describePrompt(p)).join("\n") : null;
}

/** A session's id is a UUID nobody reads; its first block is enough to tell two apart. */
const shortId = (id: string): string =>
  /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? id.slice(0, 8) : id;

/** How a notice names a launched item: its title when it has one, its kind and id otherwise. */
export function launchLabel(note: Pick<LaunchNote, "kind" | "id" | "feature" | "title">): string {
  const kind = note.kind[0]?.toUpperCase() + note.kind.slice(1);
  if (note.feature) return `Feature "${note.title ?? note.feature}" of initiative ${note.id}`;
  return note.title ? `${kind} "${note.title}"` : `${kind} ${shortId(note.id)}`;
}

/** The notice's text, for front ends that do not draw the launch card. */
export function launchNoteText(note: LaunchNote): string {
  const task = note.task && note.task.state !== "local" ? ` (${note.task.ref})` : "";
  return note.event === "task-closed"
    ? `Task ${note.task?.ref ?? ""} closed: the pull request of ${launchLabel(note)} merged`
    : `${launchLabel(note)}${task}: ${note.status}`;
}

/** What the coordinator launched, as it is now; `GET /v1/coordinator/launched`. */
export function launchedView(
  chat: ChatService,
  coordinatorId: string,
  state: ProjectStateSource | null,
): LaunchedView[] {
  return new BriefStore(chat.workspace, coordinatorId).read().launched.map((entry) => {
    const title = titleOf(chat, entry);
    const activity = activityOf(chat, entry);
    return {
      ...entry,
      ...(title ? { title } : {}),
      ...worktreeOf(chat, entry),
      ...liveState(chat, state, entry),
      ...(activity ? { activity } : {}),
    };
  });
}

/**
 * Refreshes the status of everything the coordinator launched. Returns the notices it added to the
 * coordinator's transcript; a brief edited meanwhile is left for the next call.
 */
export async function syncLaunched(
  chat: ChatService,
  coordinator: ChatSession,
  state: ProjectStateSource | null,
  tasks: TaskTracker | null = null,
  /** Gets the notes added, for a wake-up that names each item's id. */
  onNotes?: (notes: LaunchNote[]) => void,
): Promise<string[]> {
  const store = new BriefStore(chat.workspace, coordinator.id);
  const brief = store.read();
  const notices: LaunchNote[] = [];
  let changed = false;
  const launched: LaunchedEntry[] = [];
  for (const entry of brief.launched) {
    if (entry.closed) {
      launched.push(entry);
      continue;
    }
    const { status } = liveState(chat, state, entry);
    const title = titleOf(chat, entry);
    const worktree = worktreeOf(chat, entry);
    const note = (next: LaunchedEntry, event: LaunchNote["event"]): LaunchNote => ({
      kind: next.kind,
      id: next.id,
      ...(next.feature ? { feature: next.feature } : {}),
      ...(title ? { title } : {}),
      status: next.status,
      why: next.why,
      ...(next.task ? { task: next.task } : {}),
      ...worktree,
      event,
    });
    let next = entry;
    // A session that answered again between two checks (a quick follow-up) reports again too.
    const answers = entry.kind === "session" ? sessionAnswers(chat, entry.id) : 0;
    const answered = answers > (entry.answers ?? 0) && !/^working/.test(status);
    if (status !== entry.status || answered) {
      next = { ...next, status, ...(answered ? { answers } : {}) };
      if (NOTEWORTHY.test(status)) {
        const result = answered ? sessionResult(chat, entry.id) : null;
        // A question asked mid-turn is a prompt, not a message: the note carries it.
        const asks =
          entry.kind === "session" && status.startsWith("waiting")
            ? sessionAsks(chat, entry.id)
            : null;
        notices.push({
          ...note(next, "status"),
          ...(result ? { result } : {}),
          ...(asks ? { asks } : {}),
        });
      }
    }
    // A completed run's pull request closes its issue when it merges.
    if (tasks && next.task?.state === "open" && status === "completed") {
      const closed = await tasks.closed(next.task.ref).catch(() => null);
      if (closed) {
        next = { ...next, task: { ...next.task, state: "closed" } };
        notices.push(note(next, "task-closed"));
      }
    }
    if (next !== entry) changed = true;
    launched.push(next);
  }
  if (!changed) return [];
  try {
    store.write({ ...brief, launched }, brief.revision);
  } catch {
    return [];
  }
  const texts = notices.map(launchNoteText);
  for (const [i, notice] of notices.entries()) await coordinator.addNotice(texts[i] ?? "", notice);
  if (notices.length) onNotes?.(notices);
  return texts;
}

/** A notice as the coordinator's wake-up lists it: the text, the id and why it needs, then a session's answer. */
export function wakeLine(note: LaunchNote): string {
  const id = note.feature
    ? `feature ${note.feature} of initiative ${note.id}`
    : `${note.kind} id ${note.id}`;
  const line = `${launchNoteText(note)} [${id}; why: ${note.why.replace(/\s+/g, " ")}]`;
  const asks = note.asks ? `\nIt asks: ${note.asks}` : "";
  return note.result ? `${line}\nAnswer: ${note.result}${asks}` : `${line}${asks}`;
}

/**
 * The message a coordinator wakes with when launched work changed: the notices, then what to do.
 * The model reads it as a turn of its own; the transcript shows only the notices.
 */
export function wakePrompt(notices: string[]): string {
  return [
    "[Update on work you launched. BAKED sent this, not the user.]",
    ...notices.map((n) => `- ${n}`),
    "",
    "Take control back. Tell the user in one or two short lines what finished, failed or waits for them (read the run with project_state when you need its result). Then continue: start the next step of the work this was part of, propose what is left, or say it is done. A request the run waits for stays the user's decision: ask them, and use control_run only after they say yes. When a session asks something, quote its question and options to the user; once they answer here, answer_session passes their answer on. Do not repeat these lines verbatim.",
  ].join("\n");
}

/** Checks the coordinator's limits before one more launch; returns why not, or null. */
function overLimit(
  chat: ChatService,
  state: ProjectStateSource | null,
  launched: LaunchedEntry[],
  limits: { maxActive: number; maxTokens: number },
  adding = 1,
): string | null {
  const live = launched.filter((e) => !e.closed).map((entry) => liveState(chat, state, entry));
  const active = live.filter((l) => l.active).length;
  if (adding > 1 && active + adding > limits.maxActive)
    return `${active} launched items are still active and this adds ${adding} (limit ${limits.maxActive}); propose fewer flows or wait`;
  const tokens = live.reduce((sum, l) => sum + l.tokens, 0);
  if (active >= limits.maxActive)
    return `${active} launched items are still active (limit ${limits.maxActive}); wait for one to finish`;
  if (tokens >= limits.maxTokens)
    return `Launched work has used ${tokens} tokens (limit ${limits.maxTokens}); ask the user to raise coordinator.maxTokens`;
  return null;
}

/** A launched item's title from its request: the first line, cut to the brief's limit. */
function requestTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line || "Untitled";
}

const Why = z.string().trim().min(1).max(300).describe("One line on why, kept in the brief");

const IssueRef = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("A GitHub issue URL, owner/name#N or #N");

export const SplitFlowSchema = InitiativeFeatureSchema.extend({
  issue: IssueRef.optional().describe(
    "The existing issue this flow does; left out, approving the split creates one",
  ),
});

export const SplitInput = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .describe("Short lowercase id of the split; the initiative id when flows depend on each other"),
  title: z.string().trim().min(1).max(200),
  goals: z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
  completionCriteria: z.array(z.string().trim().min(1).max(4000)).min(1).max(30),
  flows: z.array(SplitFlowSchema).min(2).max(MAX_FEATURES),
  parentIssue: IssueRef.optional().describe(
    "The request's own issue; created issues become its sub-issues",
  ),
  why: Why,
});
export type SplitRequest = z.infer<typeof SplitInput>;

export const ChatsInput = z.strictObject({
  title: z.string().trim().min(1).max(200).describe("What the chats do together"),
  chats: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
          .describe("Short lowercase id, unique in this proposal"),
        title: z.string().trim().min(1).max(200),
        brief: z.string().trim().min(1).max(20_000).describe("The chat's first message"),
        mode: z
          .enum(["architect", "default", "auto"])
          .default("default")
          .describe("architect only reads; default and auto edit files in their own worktree"),
        paths: z
          .array(z.string().trim().min(1).max(500))
          .max(50)
          .default([])
          .describe("The files the chat writes, as globs; two editing chats must not overlap"),
      }),
    )
    .min(2)
    .max(MAX_FEATURES),
  why: Why,
});
export type ChatsRequest = z.infer<typeof ChatsInput>;

/** Why parallel chats cannot start as proposed, or null: unique ids, disjoint writes. */
export function chatsProblem(request: ChatsRequest): string | null {
  const ids = new Set<string>();
  for (const c of request.chats) {
    if (ids.has(c.id)) return `Two chats have the id ${c.id}`;
    ids.add(c.id);
  }
  const editing = request.chats.filter((c) => c.mode !== "architect");
  for (const [i, a] of editing.entries())
    for (const b of editing.slice(i + 1)) {
      const pair = a.paths
        .flatMap((p) => b.paths.map((q) => [p, q] as const))
        .find(([p, q]) => pathsOverlap(p, q));
      if (pair)
        return `Chats ${a.id} and ${b.id} both write ${pair[0]} / ${pair[1]}; merge them into one chat or narrow their paths`;
    }
  return null;
}

/** The literal directory part of a path glob: `src/api/**` gives `src/api/`. */
function literalPrefix(pattern: string): string {
  const glob = pattern.search(/[*?[]/);
  return glob < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf("/", glob) + 1);
}
/** Whether two path globs may name the same file; errs towards yes. */
export function pathsOverlap(a: string, b: string): boolean {
  const [x, y] = [literalPrefix(a), literalPrefix(b)];
  return x === "" || y === "" || x.startsWith(y) || y.startsWith(x);
}

/**
 * How a split runs, or why it cannot: flows without dependencies become runs in their own
 * worktrees and must not write the same paths; any dependency makes the split one initiative.
 */
export function splitShape(
  split: SplitRequest,
): { mode: "runs" | "initiative"; plan: InitiativePlan } | { problem: string } {
  const plan: InitiativePlan = {
    schemaVersion: 1,
    title: split.title,
    goals: split.goals,
    completionCriteria: split.completionCriteria,
    features: split.flows.map(({ issue: _issue, ...feature }) => feature),
  };
  const problems = planStructureProblems(plan);
  if (problems.length) return { problem: problems.join("; ") };
  if (split.flows.some((flow) => flow.dependsOn.length)) {
    if (split.flows.length < MIN_FEATURES)
      return {
        problem: `Flows that depend on each other run as an initiative of at least ${MIN_FEATURES}; merge them into one run or add flows`,
      };
    return { mode: "initiative", plan };
  }
  for (const [i, a] of split.flows.entries())
    for (const b of split.flows.slice(i + 1)) {
      if (!a.boundary.paths.length || !b.boundary.paths.length)
        return {
          problem: `Flows ${a.id} and ${b.id} run in parallel, so each needs boundary paths`,
        };
      const pair = a.boundary.paths
        .flatMap((p) => b.boundary.paths.map((q) => [p, q] as const))
        .find(([p, q]) => pathsOverlap(p, q));
      if (pair)
        return {
          problem: `Flows ${a.id} and ${b.id} both write ${pair[0]} / ${pair[1]}; merge them or make one depend on the other`,
        };
    }
  return { mode: "runs", plan };
}

type SplitFlow = SplitRequest["flows"][number];

/** The body of the issue a split creates for a flow. */
function flowIssueBody(flow: SplitFlow, split: SplitRequest): string {
  return [
    flow.boundary.scope,
    "",
    `**Boundary:** ${flow.boundary.paths.map((p) => `\`${p}\``).join(", ") || "not fixed yet"}`,
    "",
    `**Contract:** ${flow.contract}`,
    "",
    "**Acceptance criteria**",
    ...split.completionCriteria.map((c) => `- ${c}`),
    "",
    `Part of "${split.title}", split by the BAKED coordinator.`,
  ].join("\n");
}

/** How the split card names a flow's task before approval. */
const taskLabel = (task: FlowTask | "new" | "local"): string =>
  task === "new" ? "new issue" : task === "local" ? "local task" : task.ref;

/** The prompt of one flow's run: its title, scope and contract. */
function flowPrompt(flow: SplitFlow, split: SplitRequest): string {
  return [
    flow.title,
    "",
    `Part of "${split.title}". Scope: ${flow.boundary.scope}`,
    `Write only: ${flow.boundary.paths.join(", ")}`,
    `Done when: ${flow.contract}`,
  ].join("\n");
}

/** The coordinator's launch tools for one turn of `coordinator`. */
export function launchTools(
  chat: ChatService,
  coordinator: ChatSession,
  state: ProjectStateSource | null,
  launcher: ProjectLauncher | null,
  limits: { maxActive: number; maxTokens: number },
  workflows: WorkflowCatalog | null = null,
) {
  const store = new BriefStore(chat.workspace, coordinator.id);
  const failed = (error: string) => ({ success: false, output: "", error });
  const tracker = launcher?.tasks ?? null;
  /** The task an issue reference names; read from GitHub when this server can. */
  const linkTask = async (reference: string): Promise<FlowTask> => {
    if (!tracker) return { ref: reference, state: "open" };
    const task = await tracker.link(reference);
    if (task.state === "closed") throw new Error(`Issue ${task.ref} is already closed`);
    return task;
  };
  /** Runs `start` when the limits allow, then records the launched entry in the brief. */
  const launch = async (
    start: () => Promise<Omit<LaunchedEntry, "why"> & { detail?: string }>,
    why: string,
  ): Promise<{ success: boolean; output: string; error?: string }> => {
    const blocked = overLimit(chat, state, store.read().launched, limits);
    if (blocked) return failed(blocked);
    let entry: LaunchedEntry;
    let detail = "";
    try {
      const { detail: said, ...started } = await start();
      entry = { ...started, why };
      if (said) detail = ` ${said}`;
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
    let note = "";
    // The model may be editing the brief too; retry once on a revision race.
    for (let attempt = 0; attempt < 2; attempt++) {
      const brief = store.read();
      try {
        store.write({ ...brief, launched: [...brief.launched, entry] }, brief.revision);
        break;
      } catch (err) {
        note = ` It is not in the brief: ${err instanceof Error ? err.message : String(err)}.`;
      }
    }
    return {
      success: true,
      output: `Started ${entry.kind} ${entry.id} (${entry.status}).${detail}${note} You will get a note in this chat when it finishes or needs a decision; the user answers its approvals there.`,
    };
  };

  return {
    launch_session: tool({
      description:
        "Start a background chat session with a brief. It runs on its own, shows in the session list, and reports back here when its turn ends or it asks something. architect mode only reads; default or auto mode can edit files and needs the user's yes first unless the user gave this chat full access. The session gets this chat's permission mode; auto mode gives it full access. An editing session works in its own Git worktree and branch, so it does not overwrite the user's or another session's files.",
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(200),
        brief: z.string().trim().min(1).max(20_000).describe("The session's first message"),
        mode: z.enum(["architect", "default", "auto"]).default("architect"),
        worktree: z
          .boolean()
          .default(true)
          .describe(
            "For default or auto mode: work in an own worktree (true) or in the shared project folder (false)",
          ),
        why: Why,
      }),
      execute: async ({ title, brief, mode, worktree, why }) =>
        launch(async () => {
          // A coordinator with full access starts editing sessions without asking.
          const permissions = coordinator.permissionMode;
          if (
            mode !== "architect" &&
            permissions !== "full" &&
            !(await coordinator.confirm(
              `Start a ${mode}-mode session that can edit files: "${title}"`,
            ))
          )
            throw new Error("The user declined to start a session that can edit files");
          const { session, detail } = await createLaunched(chat, {
            title,
            mode: mode as ChatMode,
            permissions,
            parentId: coordinator.id,
            worktree: mode !== "architect" && worktree !== false,
          });
          session.send(brief);
          return { kind: "session", id: session.id, title, status: "working", detail };
        }, why),
    }),
    list_workflows: tool({
      description:
        "List the workflows this project can run: id, where it comes from (built in or the project's baked/workflows), what it is for, its stages in order and whether it writes files. With `request`, also BAKED's assessment of the request (kind, size, risk, the parts it lists) and the workflow it proposes and why. Read this before suggesting a workflow.",
      inputSchema: z.strictObject({
        request: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe("The work to find a workflow for, in the user's words"),
      }),
      execute: async ({ request }) => {
        if (!workflows) return failed("This server cannot list workflows");
        try {
          return { success: true, output: renderWorkflows(workflows, request) };
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    message_session: tool({
      description:
        "Send a follow-up, correction or answer to a session you launched. It reaches the session as a message from the coordinator: steered into its running turn, or starting its next turn. You get a note here with its answer when that turn ends.",
      inputSchema: z.strictObject({
        id: z.string().trim().min(1).max(200).describe("The launched session's id"),
        text: z.string().trim().min(1).max(20_000),
      }),
      execute: async ({ id, text }) => {
        if (!store.read().launched.some((l) => l.kind === "session" && l.id === id))
          return failed(`Session ${id} is not one you launched; launch_session starts one`);
        let session: ChatSession;
        try {
          session = chat.get(id);
        } catch {
          return failed(`Session ${id} no longer exists`);
        }
        try {
          const { queued } = session.send(`${COORDINATOR_MESSAGE_PREFIX}${text}`);
          return {
            success: true,
            output: queued
              ? `Sent to session ${id}; it joins the turn that is running.`
              : `Sent to session ${id}; it started a new turn.`,
          };
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    start_run: tool({
      description:
        'Ask the user to run a workflow on a request, then start it. The chat shows a card "Run workflow?" with the workflow, its stages and the request; the run starts only when the user approves the card, and its own approvals stay with the user. Without `workflow`, the one BAKED proposes for the prompt (list_workflows). The run shows in Launched work with its live stage, and you get an update turn when it finishes, fails or waits.',
      inputSchema: z.strictObject({
        prompt: z.string().trim().min(1).max(20_000),
        workflow: z.string().trim().min(1).max(100).optional(),
        feature: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
          .optional()
          .describe("Feature id to group the run under; derived from the prompt when left out"),
        issue: IssueRef.optional().describe(
          "Start from this issue: its text is the request, the prompt adds to it, and the pull request closes it",
        ),
        why: Why,
      }),
      execute: async ({ prompt, workflow, feature, issue, why }) => {
        if (!launcher) return failed("This server cannot start workflow runs");
        const blocked = overLimit(chat, state, store.read().launched, limits);
        if (blocked) return failed(blocked);
        const chosen = chooseWorkflow(workflows, prompt, workflow);
        if ("problem" in chosen) return failed(chosen.problem);
        // A closed or unknown issue is refused before the user is asked.
        let task: FlowTask | undefined;
        try {
          task = issue ? await linkTask(issue) : undefined;
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
        const card = workflowCard(chosen, prompt, why, task?.ref);
        if (!(await coordinator.proposeWorkflow(card)))
          return failed(
            `The user did not approve running workflow ${card.workflow}. Ask what to change, or work without a workflow: if the task has parts that can run side by side, propose_chats them as parallel chats; otherwise launch_session one chat.`,
          );
        return launch(async () => {
          const { runId } = await launcher.startRun({
            prompt,
            ...(chosen.id ? { workflow: chosen.id } : {}),
            ...(feature ? { feature } : {}),
            ...(task ? { issue: task.ref } : {}),
          });
          return {
            kind: "run",
            id: runId,
            title: requestTitle(prompt),
            status: "started",
            ...(chosen.id ? { workflow: chosen.id } : {}),
            ...(task ? { task } : {}),
          };
        }, why);
      },
    }),
    control_run: tool({
      description:
        "Approve or reject a pending request of a run you launched, or cancel the run. Use it only after the user said so in this chat: it shows them a card first and does nothing unless they approve it. `approve` takes the run's pending approval, answer-free request; `reject` needs a reason the run gets.",
      inputSchema: z.strictObject({
        runId: z.string().trim().min(1).max(200),
        action: z.enum(["approve", "reject", "cancel"]),
        requestId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The pending request; the only one pending when left out"),
        reason: z.string().trim().min(1).max(4000).optional().describe("Why, for reject"),
      }),
      execute: async ({ runId, action, requestId, reason }) => {
        if (!launcher?.control || !state) return failed("This server cannot control workflow runs");
        if (!store.read().launched.some((l) => l.kind === "run" && l.id === runId))
          return failed(`Run ${runId} was not launched by you; the user controls it in Runs`);
        try {
          const control = resolveControl(state, { runId, action, requestId, reason });
          if (!(await coordinator.confirm(controlDescription(control))))
            return failed("The user did not approve it. Nothing changed.");
          await launcher.control(control.input);
          return {
            success: true,
            output: `${controlDescription(control)}: done. You get an update when the run finishes or waits again.`,
          };
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    start_initiative: tool({
      description:
        "Start an initiative that splits a large goal into features, as `baked workflow initiative start` does. The user approves its split.",
      inputSchema: z.strictObject({
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
          .describe("Short lowercase id, such as checkout-redesign"),
        prompt: z.string().trim().min(1).max(20_000),
        why: Why,
      }),
      execute: async ({ id, prompt, why }) => {
        if (!launcher) return failed("This server cannot start initiatives");
        return launch(async () => {
          const { initiativeId } = await launcher.startInitiative({ initiativeId: id, prompt });
          return {
            kind: "initiative",
            id: initiativeId,
            title: requestTitle(prompt),
            status: "started",
          };
        }, why);
      },
    }),
    answer_session: tool({
      description:
        "Pass the user's answer to a question a session you launched is waiting on (project_state session shows it). Use it only with what the user said in this chat, never an answer of your own. Permissions and plan reviews stay with the user in that session.",
      inputSchema: z.strictObject({
        id: z.string().trim().min(1).max(200).describe("The launched session's id"),
        answer: z
          .string()
          .trim()
          .max(4000)
          .describe(
            "The user's answer, or an option's label; empty skips a question that allows it",
          ),
        promptId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("The question; the only one pending when left out"),
      }),
      execute: async ({ id, answer, promptId }) => {
        if (!store.read().launched.some((l) => l.kind === "session" && l.id === id))
          return failed(`Session ${id} is not one you launched; the user answers it there`);
        let session: ChatSession;
        try {
          session = chat.get(id);
        } catch {
          return failed(`Session ${id} no longer exists`);
        }
        const pending = session.pendingPrompts;
        const prompt = promptId ? pending.find((p) => p.id === promptId) : pending[0];
        if (!prompt) return failed(`Session ${id} waits for no answer`);
        if (!promptId && pending.length > 1)
          return failed(
            `Session ${id} waits on several prompts (${pending.map((p) => `${p.id}: ${p.kind}`).join(", ")}); name one`,
          );
        if (prompt.kind !== "question")
          return failed(
            `Session ${id} waits on ${describePrompt(prompt)}. The user answers that in the session itself.`,
          );
        const option = prompt.options.find(
          (o) => o.label.toLowerCase() === answer.toLowerCase() || o.value === answer,
        );
        const value = option?.value ?? answer;
        const title = session.title;
        if (
          coordinator.permissionMode !== "full" &&
          !(await coordinator.confirm(
            `Answer "${prompt.question}" in session "${title}" with: ${answer || "(skip)"}`,
          ))
        )
          return failed("The user did not approve the answer. Nothing was sent.");
        try {
          session.answer(prompt.id, { answer: value });
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
        return {
          success: true,
          output: `Answered the question of session ${id}; it goes on. You get a note here when its turn ends or it asks again.`,
        };
      },
    }),
    propose_chats: tool({
      description:
        "Propose working without a workflow: split a task into parallel chat sessions the user approves as one card, then start them all. Use it when the user does not want a workflow run and the task has parts that can run side by side. Each chat gets its own brief; an editing chat works in its own Git worktree and branch, and two editing chats must not write the same paths. You get a note here as each one finishes or asks something.",
      inputSchema: ChatsInput,
      execute: async (request: ChatsRequest) => {
        const problem = chatsProblem(request);
        if (problem) return failed(problem);
        const blocked = overLimit(chat, state, store.read().launched, limits, request.chats.length);
        if (blocked) return failed(blocked);
        const digest = hashJson({ kind: "chats", chats: request.chats });
        const approved = await coordinator.proposeSplit({
          kind: "split",
          title: request.title,
          mode: "chats",
          flows: request.chats.map((c) => ({
            id: c.id,
            title: c.title,
            paths: c.paths,
            dependsOn: [],
            task: c.mode === "architect" ? "chat, reads only" : "chat, edits files",
          })),
          digest,
        });
        const decided = `Parallel chats "${request.title}" ${approved ? "approved" : "rejected"} (digest ${digest.slice(0, 12)})`;
        if (!approved) {
          recordInBrief(store, (brief) => ({
            ...brief,
            openQuestions: [...brief.openQuestions, `${decided}; ask what to change`],
          }));
          return failed("The user rejected the chats. Ask what to change, then propose again.");
        }
        const entries: LaunchedEntry[] = [];
        const errors: string[] = [];
        const details: string[] = [];
        for (const c of request.chats)
          try {
            const { session, detail } = await createLaunched(chat, {
              title: c.title,
              mode: c.mode as ChatMode,
              permissions: coordinator.permissionMode,
              parentId: coordinator.id,
              worktree: c.mode !== "architect",
            });
            session.send(c.brief);
            entries.push({
              kind: "session",
              id: session.id,
              title: requestTitle(c.title),
              status: "working",
              why: `${c.title} (${request.title})`.slice(0, 300),
            });
            if (detail) details.push(`${c.id}: ${detail}`);
          } catch (err) {
            errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        recordInBrief(store, (brief) => ({
          ...brief,
          decisions: [...brief.decisions, decided],
          launched: [...brief.launched, ...entries],
        }));
        return {
          success: errors.length === 0,
          output: `The user approved the chats. Started ${entries.map((e) => `session ${e.id} "${e.title}"`).join(", ") || "nothing"}.${details.length ? ` ${details.join(" ")}` : ""} You get a note here as each finishes or asks something; report back to the user when they are all done.`,
          ...(errors.length ? { error: `Not started: ${errors.join("; ")}` } : {}),
        };
      },
    }),
    propose_split: tool({
      description:
        "Propose splitting a large request into flows the user approves as one card. Flows without dependsOn run as parallel workflow runs, each in its own worktree and branch, and must have disjoint boundary paths; if any flow depends on another, the whole split runs as one initiative (3 to 12 flows) that orders them. Waits for the user's answer, then launches everything at once.",
      inputSchema: SplitInput,
      execute: async (split: SplitRequest) => {
        if (!launcher) return failed("This server cannot start workflow runs");
        const shape = splitShape(split);
        if ("problem" in shape) return failed(shape.problem);
        const adding = shape.mode === "runs" ? split.flows.length : 1;
        const blocked = overLimit(chat, state, store.read().launched, limits, adding);
        if (blocked) return failed(blocked);
        // Each flow's task: its own issue, a new one in the origin repository, or a local task.
        const target = tracker ? await tracker.target().catch(() => null) : null;
        const planned: (FlowTask | "new" | "local")[] = [];
        for (const flow of split.flows)
          try {
            planned.push(flow.issue ? await linkTask(flow.issue) : target ? "new" : "local");
          } catch (err) {
            return failed(`${flow.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        const digest = hashJson({
          id: split.id,
          mode: shape.mode,
          plan: shape.plan,
          tasks: planned.map(taskLabel),
        });
        const approved = await coordinator.proposeSplit({
          kind: "split",
          title: split.title,
          mode: shape.mode,
          flows: split.flows.map((flow, i) => ({
            id: flow.id,
            title: flow.title,
            paths: flow.boundary.paths,
            dependsOn: flow.dependsOn,
            task: taskLabel(planned[i] ?? "local"),
          })),
          digest,
        });
        const decided = `Split ${split.id} "${split.title}" ${approved ? "approved" : "rejected"} (digest ${digest.slice(0, 12)})`;
        if (!approved) {
          recordInBrief(store, (brief) => ({
            ...brief,
            openQuestions: [...brief.openQuestions, `${decided}; ask what to change`],
          }));
          return failed("The user rejected the split. Ask what to change, then propose again.");
        }
        const entries: LaunchedEntry[] = [];
        const errors: string[] = [];
        const notes: string[] = [];
        const tasks: FlowTask[] = [];
        for (const [i, flow] of split.flows.entries()) {
          const plan = planned[i] ?? "local";
          if (plan === "local" || plan === "new") {
            const local: FlowTask = { ref: `local:${split.id}/${flow.id}`, state: "local" };
            if (plan === "local" || !tracker) {
              tasks.push(local);
              continue;
            }
            try {
              const created = await tracker.create({
                title: flow.title,
                body: flowIssueBody(flow, split),
                ...(split.parentIssue ? { parent: split.parentIssue } : {}),
              });
              tasks.push(created.task);
              if (created.warning) notes.push(created.warning);
            } catch (err) {
              tasks.push(local);
              notes.push(
                `${flow.id} has a local task: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          } else tasks.push(plan);
        }
        if (shape.mode === "initiative")
          try {
            const featureIssues: Record<string, IssueSource> = {};
            for (const [i, flow] of split.flows.entries()) {
              const issue = issueOf(tasks[i], flow.title);
              if (issue) featureIssues[flow.id] = issue;
            }
            const { initiativeId } = await launcher.startInitiative({
              initiativeId: split.id,
              prompt: split.title,
              plan: shape.plan,
              approveSplit: true,
              ...(Object.keys(featureIssues).length ? { featureIssues } : {}),
            });
            entries.push({
              kind: "initiative",
              id: initiativeId,
              title: requestTitle(split.title),
              status: "started",
              why: `${split.why}; tasks ${tasks.map((t) => t.ref).join(", ")}`.slice(0, 1000),
            });
            // One entry per feature task, so a merge is reported per task as it is for runs.
            for (const [i, flow] of split.flows.entries()) {
              const task = tasks[i];
              if (task && task.state !== "local")
                entries.push({
                  kind: "initiative",
                  id: initiativeId,
                  feature: flow.id,
                  title: requestTitle(flow.title),
                  status: "started",
                  why: `${flow.title} (${split.id})`,
                  task,
                });
            }
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        else
          for (const [i, flow] of split.flows.entries())
            try {
              const task = tasks[i];
              const issue = task && task.state !== "local" ? task.ref : undefined;
              const { runId } = await launcher.startRun({
                prompt: flowPrompt(flow, split),
                // From an issue the run is named after it, so reruns of the task group together.
                ...(issue ? { issue } : { feature: `${split.id}-${flow.id}`.slice(0, 96) }),
                worktree: true,
              });
              entries.push({
                kind: "run",
                id: runId,
                title: requestTitle(flow.title),
                status: "started",
                why: `${flow.title} (${split.id})`,
                ...(task ? { task } : {}),
              });
            } catch (err) {
              errors.push(`${flow.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        recordInBrief(store, (brief) => ({
          ...brief,
          decisions: [...brief.decisions, decided],
          launched: [...brief.launched, ...entries],
        }));
        const started =
          entries.map((e) => `${e.kind} ${e.id}${e.task ? ` for ${e.task.ref}` : ""}`).join(", ") ||
          "nothing";
        return {
          success: errors.length === 0,
          output: `The user approved the split. Started ${started}. Tasks: ${tasks.map((t) => t.url ?? t.ref).join(", ")}.${notes.length ? ` Note: ${notes.join("; ")}.` : ""} Each run stops at its own approval; you get a note here as they finish or wait, and when a task's pull request merges.`,
          ...(errors.length ? { error: `Not started: ${errors.join("; ")}` } : {}),
        };
      },
    }),
  };
}

type WorkflowCardBody = Omit<Extract<ChatPrompt, { kind: "workflow" }>, "id" | "createdAt">;

/** The workflow a run uses: the one named, or the one BAKED proposes for the prompt. */
export function chooseWorkflow(
  workflows: WorkflowCatalog | null,
  prompt: string,
  named: string | undefined,
): { id: string | null; summary: DefinitionSummary | null; reason: string } | { problem: string } {
  if (!workflows)
    return named
      ? { id: named, summary: null, reason: "named by the coordinator" }
      : { id: null, summary: null, reason: "the project default" };
  const all = workflows.list();
  const ready = all.filter((d) => !d.problems.length);
  const known = ready.map((d) => d.id).join(", ");
  if (named) {
    const summary = all.find((d) => d.id === named);
    if (!summary) return { problem: `There is no workflow ${named}; the project has ${known}` };
    if (summary.problems.length)
      return {
        problem: `Workflow ${named} cannot start: ${summary.problems.join("; ")}. Pick one of ${known}`,
      };
    return { id: named, summary, reason: "chosen for this request" };
  }
  const proposal = workflows.propose(prompt);
  return {
    id: proposal.workflowId,
    summary: all.find((d) => d.id === proposal.workflowId) ?? null,
    reason: proposal.reason,
  };
}

/** The "Run workflow?" card; its digest binds the approval to this workflow and request. */
export function workflowCard(
  chosen: { id: string | null; summary: DefinitionSummary | null; reason: string },
  prompt: string,
  why: string,
  issue?: string,
): WorkflowCardBody {
  const workflow = chosen.id ?? "default";
  const body = {
    kind: "workflow" as const,
    workflow,
    description: chosen.summary?.description ?? "",
    stages: chosen.summary?.stages ?? [],
    writes: chosen.summary?.writes ?? true,
    prompt,
    why,
    reason: chosen.reason,
    ...(issue ? { issue } : {}),
  };
  return { ...body, digest: hashJson({ workflow, prompt, issue: issue ?? null }) };
}

/** The workflow list the model reads; with a request, the proposal first. */
export function renderWorkflows(workflows: WorkflowCatalog, request?: string): string {
  const all = workflows.list();
  const lines = all.map((d) => {
    const flags = [
      d.source === "project" ? "project" : "built in",
      d.writes ? "writes files" : "read only",
    ];
    const problems = d.problems.length ? ` CANNOT START: ${d.problems.join("; ")}` : "";
    return `- ${d.id} (${flags.join(", ")}): ${d.description.replace(/\s+/g, " ").trim() || "no description"}. Stages: ${d.stages.join(" > ") || "none"}.${problems}`;
  });
  const head: string[] = [];
  if (request) {
    const p = workflows.propose(request);
    const a = assessRequest(request, p);
    const signals = a.signals.length ? ` (signals: ${[...new Set(a.signals)].join(", ")})` : "";
    const parts =
      a.parts >= 2
        ? ` It lists ${a.parts} parts; if they touch different files they can run side by side.`
        : "";
    head.push(
      `Assessment: ${a.kind} request, size ${a.size}, risk ${a.risk}${signals}.${parts}`,
      `Proposed for this request: ${p.workflowId} (${p.reason}; ${p.confidence} confidence, budget ${p.budget})`,
      "",
    );
  }
  return [...head, "## Workflows", ...(lines.length ? lines : ["None."])].join("\n");
}

type ControlInput = {
  runId: string;
  action: RunControl["action"];
  requestId: string | undefined;
  reason: string | undefined;
};

/** The control the tool asks for, with the pending request it acts on; throws when there is none. */
export function resolveControl(
  state: ProjectStateSource,
  { runId, action, requestId, reason }: ControlInput,
): { input: RunControl; kind: string | null } {
  if (action === "cancel") return { input: { runId, action }, kind: null };
  const pending = state.run(runId).pendingRequests;
  const request = requestId ? pending.find((r) => r.id === requestId) : pending[0];
  if (!request)
    throw new Error(
      requestId
        ? `Run ${runId} has no pending request ${requestId}`
        : `Run ${runId} waits for nothing`,
    );
  if (!requestId && pending.length > 1)
    throw new Error(
      `Run ${runId} has several pending requests (${pending.map((r) => `${r.id}: ${r.kind}`).join(", ")}); name one`,
    );
  if (action === "reject") {
    if (!reason) throw new Error("Give the reason the run gets with the rejection");
    return { input: { runId, action, requestId: request.id, reason }, kind: request.kind };
  }
  if (request.kind !== "approval" || !request.digest)
    throw new Error(
      `Request ${request.id} is a ${request.kind}; the user answers it in the run itself`,
    );
  return {
    input: { runId, action, requestId: request.id, digest: request.digest },
    kind: request.kind,
  };
}

/** The card text the user approves before a control runs. */
function controlDescription({ input, kind }: { input: RunControl; kind: string | null }): string {
  if (input.action === "cancel") return `Cancel run ${input.runId}`;
  if (input.action === "approve") return `Approve the ${kind} of run ${input.runId}`;
  return `Reject the ${kind} of run ${input.runId}: ${input.reason}`;
}

/** The issue a flow's task names, for a feature run to start from; null for a local task. */
export function issueOf(task: FlowTask | undefined, title: string): IssueSource | null {
  const match =
    task?.url && task.state !== "local" ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(task.ref) : null;
  if (!task?.url || !match?.[1] || !match[2]) return null;
  return { repository: match[1], number: Number(match[2]), url: task.url, title };
}

/**
 * Creates a launched session; an editing one gets its own worktree. When the project cannot have
 * one (no Git repository, no commit), the session works in the shared folder and the coordinator
 * is told so.
 */
async function createLaunched(
  chat: ChatService,
  input: {
    title: string;
    mode: ChatMode;
    permissions: PermissionMode;
    parentId: string;
    worktree: boolean;
  },
): Promise<{ session: ChatSession; detail: string }> {
  const { title, mode, permissions, parentId } = input;
  if (!input.worktree) {
    const shared = input.mode === "architect" ? "" : "It works in the shared project folder.";
    return { session: await chat.create({ title, mode, permissions, parentId }), detail: shared };
  }
  try {
    const session = await chat.create({ title, mode, permissions, parentId, worktree: true });
    const own = session.summary().worktree;
    return { session, detail: own ? `It works in ${own.path} on branch ${own.branch}.` : "" };
  } catch (err) {
    // A ChatError; checked by its code, as this module cannot import sessions.ts at run time.
    if ((err as { code?: unknown }).code !== "NOT_SUPPORTED") throw err;
    const session = await chat.create({ title, mode, permissions, parentId });
    return { session, detail: `${(err as Error).message}; it works in the shared project folder.` };
  }
}

/** Applies one change to the brief, retrying once when the model edited it meanwhile. */
function recordInBrief(
  store: BriefStore,
  change: (brief: ReturnType<BriefStore["read"]>) => ReturnType<BriefStore["read"]>,
): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const brief = store.read();
    try {
      store.write(change(brief), brief.revision);
      return;
    } catch {
      // A revision race or a full brief; the next attempt reads it again.
    }
  }
}
