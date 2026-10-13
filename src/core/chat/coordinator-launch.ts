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
import type { AppConfig, ChatMessage, LaunchNote } from "../../types/index.js";
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
import { terminalStates } from "../workflows/state-machine.js";
import type { RunApprover } from "./approval-rules.js";
import { BriefStore, type LaunchedEntry } from "./coordinator.js";
import type { ProjectStateSource } from "./project-state.js";
import type { ChatMode, ChatService, ChatSession } from "./sessions.js";

export const LAUNCH_TOOLS = [
  "launch_session",
  "start_run",
  "start_initiative",
  "propose_split",
  "message_session",
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
  /** Approves a run's plan and continues it; the approval rules use it (`approval-rules.ts`). */
  approveRun?: RunApprover["approveRun"];
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

/** A launched item as it is now: its status word, whether it still runs, and its tokens. */
interface LiveState {
  status: string;
  active: boolean;
  tokens: number;
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

function liveState(
  chat: ChatService,
  state: ProjectStateSource | null,
  entry: LaunchedEntry,
): LiveState {
  if (entry.kind === "session") return sessionState(chat, entry.id);
  if (!state) return { status: entry.status, active: false, tokens: 0 };
  try {
    if (entry.kind === "run") {
      const { summary } = state.run(entry.id);
      const status = summary.snapshot.status;
      const active = !terminalStates.includes(status);
      return {
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
 * A launched entry with its live status, whether it still runs, and the tokens it used; a working
 * session also says which tool it is in, and a session with its own worktree names it.
 */
export type LaunchedView = LaunchedEntry & {
  active: boolean;
  tokens: number;
  activity?: string;
  worktree?: { path: string; branch: string };
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
): Promise<string[]> {
  const store = new BriefStore(chat.workspace, coordinator.id);
  const brief = store.read();
  const notices: LaunchNote[] = [];
  let changed = false;
  const launched: LaunchedEntry[] = [];
  for (const entry of brief.launched) {
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
        notices.push({ ...note(next, "status"), ...(result ? { result } : {}) });
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
  return texts;
}

/** Checks the coordinator's limits before one more launch; returns why not, or null. */
function overLimit(
  chat: ChatService,
  state: ProjectStateSource | null,
  launched: LaunchedEntry[],
  limits: { maxActive: number; maxTokens: number },
  adding = 1,
): string | null {
  const live = launched.map((entry) => liveState(chat, state, entry));
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
        "Start a background chat session with a brief. It runs on its own, shows in the session list, and reports back here when its turn ends or it asks something. architect mode only reads; default or auto mode can edit files and needs the user's yes first. An editing session works in its own Git worktree and branch, so it does not overwrite the user's or another session's files.",
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
          if (
            mode !== "architect" &&
            !(await coordinator.confirm(
              `Start a ${mode}-mode session that can edit files: "${title}"`,
            ))
          )
            throw new Error("The user declined to start a session that can edit files");
          const { session, detail } = await createLaunched(chat, {
            title,
            mode: mode as ChatMode,
            parentId: coordinator.id,
            worktree: mode !== "architect" && worktree !== false,
          });
          session.send(brief);
          return { kind: "session", id: session.id, title, status: "working", detail };
        }, why),
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
        "Start a workflow run, as `baked workflow run` does. It stops at its own approval request with its estimate; the user approves it, not you.",
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
        return launch(async () => {
          const task = issue ? await linkTask(issue) : undefined;
          const { runId } = await launcher.startRun({
            prompt,
            ...(workflow ? { workflow } : {}),
            ...(feature ? { feature } : {}),
            ...(task ? { issue: task.ref } : {}),
          });
          return {
            kind: "run",
            id: runId,
            title: requestTitle(prompt),
            status: "started",
            ...(task ? { task } : {}),
          };
        }, why);
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
  input: { title: string; mode: ChatMode; parentId: string; worktree: boolean },
): Promise<{ session: ChatSession; detail: string }> {
  const { title, mode, parentId } = input;
  if (!input.worktree) {
    const shared = input.mode === "architect" ? "" : "It works in the shared project folder.";
    return { session: await chat.create({ title, mode, parentId }), detail: shared };
  }
  try {
    const session = await chat.create({ title, mode, parentId, worktree: true });
    const own = session.summary().worktree;
    return { session, detail: own ? `It works in ${own.path} on branch ${own.branch}.` : "" };
  } catch (err) {
    // A ChatError; checked by its code, as this module cannot import sessions.ts at run time.
    if ((err as { code?: unknown }).code !== "NOT_SUPPORTED") throw err;
    const session = await chat.create({ title, mode, parentId });
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
