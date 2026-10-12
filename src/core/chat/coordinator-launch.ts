/**
 * What the project coordinator launches and how it follows it. A launch adds an entry to the
 * brief's `launched` section, which is the link table; `syncLaunched` refreshes each entry's
 * status and tells the coordinator, in its transcript, when an item finishes, fails or waits for a
 * person. Decisions stay on the item: no tool here answers a run's or a session's requests.
 */
import { tool } from "ai";
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import { hashJson } from "../specs/hash.js";
import {
  InitiativeFeatureSchema,
  type InitiativePlan,
  MAX_FEATURES,
  MIN_FEATURES,
  planStructureProblems,
} from "../workflows/initiatives/plan.js";
import { terminalStates } from "../workflows/state-machine.js";
import { BriefStore, type LaunchedEntry } from "./coordinator.js";
import type { ProjectStateSource } from "./project-state.js";
import type { ChatMode, ChatService, ChatSession } from "./sessions.js";

export const LAUNCH_TOOLS = [
  "launch_session",
  "start_run",
  "start_initiative",
  "propose_split",
] as const;
export const DEFAULT_MAX_ACTIVE = 3;
export const DEFAULT_MAX_TOKENS = 20_000_000;

/** Starts runs and initiatives through the server's own start paths. */
export interface ProjectLauncher {
  /** `worktree` runs the run in its own Git worktree, so several execute side by side. */
  startRun(input: {
    prompt: string;
    workflow?: string;
    feature?: string;
    worktree?: boolean;
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
  }): Promise<{ initiativeId: string }>;
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
 * Refreshes the status of everything the coordinator launched. Returns the notices it added to the
 * coordinator's transcript; a brief edited meanwhile is left for the next call.
 */
export async function syncLaunched(
  chat: ChatService,
  coordinator: ChatSession,
  state: ProjectStateSource | null,
): Promise<string[]> {
  const store = new BriefStore(chat.workspace, coordinator.id);
  const brief = store.read();
  const notices: string[] = [];
  let changed = false;
  const launched = brief.launched.map((entry) => {
    const { status } = liveState(chat, state, entry);
    if (status === entry.status) return entry;
    changed = true;
    if (NOTEWORTHY.test(status))
      notices.push(`${entry.kind} ${entry.id}: ${status} (${entry.why})`);
    return { ...entry, status };
  });
  if (!changed) return [];
  try {
    store.write({ ...brief, launched }, brief.revision);
  } catch {
    return [];
  }
  for (const notice of notices) await coordinator.addNotice(`Launched ${notice}`);
  return notices;
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

const Why = z.string().trim().min(1).max(300).describe("One line on why, kept in the brief");

export const SplitInput = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .describe("Short lowercase id of the split; the initiative id when flows depend on each other"),
  title: z.string().trim().min(1).max(200),
  goals: z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
  completionCriteria: z.array(z.string().trim().min(1).max(4000)).min(1).max(30),
  flows: z.array(InitiativeFeatureSchema).min(2).max(MAX_FEATURES),
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
    features: split.flows,
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

/** The prompt of one flow's run: its title, scope and contract. */
function flowPrompt(flow: SplitRequest["flows"][number], split: SplitRequest): string {
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
  /** Runs `start` when the limits allow, then records the launched entry in the brief. */
  const launch = async (
    start: () => Promise<Omit<LaunchedEntry, "why">>,
    why: string,
  ): Promise<{ success: boolean; output: string; error?: string }> => {
    const blocked = overLimit(chat, state, store.read().launched, limits);
    if (blocked) return failed(blocked);
    let entry: LaunchedEntry;
    try {
      entry = { ...(await start()), why };
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
      output: `Started ${entry.kind} ${entry.id} (${entry.status}).${note} You will get a note in this chat when it finishes or needs a decision; the user answers its approvals there.`,
    };
  };

  return {
    launch_session: tool({
      description:
        "Start a background chat session with a brief. It runs on its own, shows in the session list, and reports back here when its turn ends or it asks something. architect mode only reads; default or auto mode can edit files and needs the user's yes first.",
      inputSchema: z.strictObject({
        title: z.string().trim().min(1).max(200),
        brief: z.string().trim().min(1).max(20_000).describe("The session's first message"),
        mode: z.enum(["architect", "default", "auto"]).default("architect"),
        why: Why,
      }),
      execute: async ({ title, brief, mode, why }) =>
        launch(async () => {
          if (
            mode !== "architect" &&
            !(await coordinator.confirm(
              `Start a ${mode}-mode session that can edit files: "${title}"`,
            ))
          )
            throw new Error("The user declined to start a session that can edit files");
          const session = await chat.create({ title, mode: mode as ChatMode });
          session.send(brief);
          return { kind: "session", id: session.id, status: "working" };
        }, why),
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
        why: Why,
      }),
      execute: async ({ prompt, workflow, feature, why }) => {
        if (!launcher) return failed("This server cannot start workflow runs");
        return launch(async () => {
          const { runId } = await launcher.startRun({
            prompt,
            ...(workflow ? { workflow } : {}),
            ...(feature ? { feature } : {}),
          });
          return { kind: "run", id: runId, status: "started" };
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
          return { kind: "initiative", id: initiativeId, status: "started" };
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
        const digest = hashJson({ id: split.id, mode: shape.mode, plan: shape.plan });
        const approved = await coordinator.proposeSplit({
          kind: "split",
          title: split.title,
          mode: shape.mode,
          flows: split.flows.map((flow) => ({
            id: flow.id,
            title: flow.title,
            paths: flow.boundary.paths,
            dependsOn: flow.dependsOn,
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
        if (shape.mode === "initiative")
          try {
            const { initiativeId } = await launcher.startInitiative({
              initiativeId: split.id,
              prompt: split.title,
              plan: shape.plan,
              approveSplit: true,
            });
            entries.push({
              kind: "initiative",
              id: initiativeId,
              status: "started",
              why: split.why,
            });
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        else
          for (const flow of split.flows)
            try {
              const { runId } = await launcher.startRun({
                prompt: flowPrompt(flow, split),
                feature: `${split.id}-${flow.id}`.slice(0, 96),
                worktree: true,
              });
              entries.push({
                kind: "run",
                id: runId,
                status: "started",
                why: `${flow.title} (${split.id})`,
              });
            } catch (err) {
              errors.push(`${flow.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        recordInBrief(store, (brief) => ({
          ...brief,
          decisions: [...brief.decisions, decided],
          launched: [...brief.launched, ...entries],
        }));
        const started = entries.map((e) => `${e.kind} ${e.id}`).join(", ") || "nothing";
        return {
          success: errors.length === 0,
          output: `The user approved the split. Started ${started}. Each run stops at its own approval; you get a note here as they finish or wait.`,
          ...(errors.length ? { error: `Not started: ${errors.join("; ")}` } : {}),
        };
      },
    }),
  };
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
