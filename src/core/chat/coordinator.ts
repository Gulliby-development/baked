/**
 * The project coordinator: one long-lived chat session per project that answers from project
 * state and keeps a durable project brief. The session itself is an ordinary `ChatSession` with
 * `kind: "coordinator"`; this module holds its prompt, its brief and the tool that edits the brief.
 *
 * The brief lives in `.baked/sessions/ID/brief.json` next to the session. It is put whole into the
 * system prompt of every coordinator turn, so it survives compaction and restarts, and it is
 * capped so it stays small. The model edits it with the `coordinator_brief` tool, people through
 * the local API with an expected revision, so neither overwrites the other unseen.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { writeViaTemp } from "../workflows/atomic-write.js";

/** The chat mode a coordinator runs in: read-only tools, as in architect mode. */
export const COORDINATOR_MODE = "architect" as const;
export const BRIEF_MAX_CHARS = 8000;
export const BRIEF_TOOL = "coordinator_brief";

export const LIST_SECTIONS = ["decisions", "conventions", "openQuestions"] as const;
export const BRIEF_SECTIONS = [...LIST_SECTIONS, "launched"] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

const Line = z.string().trim().min(1).max(1000);
export const LaunchedEntrySchema = z.strictObject({
  kind: z.enum(["session", "run", "initiative"]),
  id: z.string().trim().min(1).max(200),
  /** A name a person reads instead of the id: the session's title, the run's request. */
  title: z.string().trim().min(1).max(200).optional(),
  why: Line,
  status: z.string().trim().min(1).max(200),
  /** For a feature of the initiative `id`: the feature, tracked on its own task. */
  feature: z.string().trim().min(1).max(200).optional(),
  /** The workflow definition a run follows. */
  workflow: z.string().trim().min(1).max(100).optional(),
  /** For a session: how many of its answers the coordinator was told about. */
  answers: z.number().int().min(0).optional(),
  /** The task the item belongs to: an issue (`owner/name#N`) or a local task without GitHub. */
  task: z
    .strictObject({
      ref: z.string().trim().min(1).max(200),
      url: z.string().url().max(500).optional(),
      state: z.enum(["open", "closed", "local"]),
    })
    .optional(),
  /** Closed by a person or the coordinator: no longer followed, counted or shown as active. */
  closed: z.literal(true).optional(),
});
export type LaunchedEntry = z.infer<typeof LaunchedEntrySchema>;

/** One launched item is one entry: a session, run or initiative, or one feature of an initiative. */
export const launchedKey = (entry: Pick<LaunchedEntry, "kind" | "id" | "feature">): string =>
  `${entry.kind}:${entry.id}:${entry.feature ?? ""}`;

/**
 * Folds entries for the same item into the first one: the launch tools record what they start,
 * and the model may record it again. The later entry adds a title or task the first one lacks.
 */
export function dedupeLaunched(entries: readonly LaunchedEntry[]): LaunchedEntry[] {
  const byKey = new Map<string, LaunchedEntry>();
  for (const entry of entries) {
    const key = launchedKey(entry);
    const first = byKey.get(key);
    byKey.set(
      key,
      first
        ? {
            ...first,
            ...(!first.title && entry.title ? { title: entry.title } : {}),
            ...(!first.task && entry.task ? { task: entry.task } : {}),
            ...(!first.closed && entry.closed ? { closed: entry.closed } : {}),
          }
        : entry,
    );
  }
  return [...byKey.values()];
}

export const BriefContentSchema = z.strictObject({
  decisions: z.array(Line).max(100),
  conventions: z.array(Line).max(100),
  openQuestions: z.array(Line).max(100),
  launched: z.array(LaunchedEntrySchema).max(100),
});
export type BriefContent = z.infer<typeof BriefContentSchema>;

export interface ProjectBrief extends BriefContent {
  /** Increases with every saved change; 0 for a brief never saved. */
  revision: number;
  updatedAt: number;
}

export class BriefError extends Error {
  constructor(
    readonly code: "STALE_REVISION" | "TOO_LARGE" | "INVALID_REQUEST",
    message: string,
  ) {
    super(message);
  }
}

export function emptyBrief(): ProjectBrief {
  return {
    revision: 0,
    updatedAt: 0,
    decisions: [],
    conventions: [],
    openQuestions: [],
    launched: [],
  };
}

/** The brief as the model reads it; also its size measure for the cap. */
export function renderBrief(brief: BriefContent): string {
  const list = (title: string, items: string[]): string[] =>
    items.length ? [`### ${title}`, ...items.map((item, i) => `${i}. ${item}`), ""] : [];
  const lines = [
    ...list("Decisions", brief.decisions),
    ...list("Conventions", brief.conventions),
    ...(brief.launched.length
      ? [
          "### Launched work",
          ...brief.launched.map(
            (l, i) =>
              `${i}. ${l.kind} ${l.id}${l.title ? ` "${l.title}"` : ""}${l.workflow ? ` (workflow ${l.workflow})` : ""}${l.task ? ` (task ${l.task.ref}, ${l.task.state})` : ""} [${l.closed ? "closed" : l.status}]: ${l.why.replace(/\s+/g, " ")}`,
          ),
          "",
        ]
      : []),
    ...list("Open questions", brief.openQuestions),
  ];
  return lines.length ? lines.join("\n").trimEnd() : "(empty)";
}

/** Reads and writes one coordinator's brief. */
export class BriefStore {
  readonly path: string;

  constructor(workspace: string, sessionId: string) {
    this.path = join(workspace, ".baked", "sessions", sessionId, "brief.json");
  }

  read(): ProjectBrief {
    if (!existsSync(this.path)) return emptyBrief();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<ProjectBrief>;
      const content = BriefContentSchema.parse({
        decisions: raw.decisions ?? [],
        conventions: raw.conventions ?? [],
        openQuestions: raw.openQuestions ?? [],
        launched: dedupeLaunched(raw.launched ?? []),
      });
      return {
        revision: typeof raw.revision === "number" ? raw.revision : 0,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        ...content,
      };
    } catch {
      // A damaged brief must not stop the coordinator; the next save replaces it.
      return emptyBrief();
    }
  }

  /** Saves `content` when the stored revision is still `expectedRevision`. */
  write(content: BriefContent, expectedRevision: number): ProjectBrief {
    const { decisions, conventions, openQuestions, launched } = content;
    const parsed = BriefContentSchema.safeParse({
      decisions,
      conventions,
      openQuestions,
      launched: dedupeLaunched(launched),
    });
    if (!parsed.success)
      throw new BriefError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid brief");
    const current = this.read();
    if (current.revision !== expectedRevision)
      throw new BriefError(
        "STALE_REVISION",
        `The brief is at revision ${current.revision}, not ${expectedRevision}; reload it and retry`,
      );
    const size = renderBrief(parsed.data).length;
    if (size > BRIEF_MAX_CHARS)
      throw new BriefError(
        "TOO_LARGE",
        `The brief would be ${size} characters, over the limit of ${BRIEF_MAX_CHARS}; condense or remove entries first`,
      );
    const brief: ProjectBrief = {
      revision: current.revision + 1,
      updatedAt: Date.now(),
      ...parsed.data,
    };
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    writeViaTemp(this.path, `${JSON.stringify(brief, null, 2)}\n`, {
      flag: "w",
      flush: true,
      mode: 0o600,
    });
    return brief;
  }
}

/** The coordinator's part of the system prompt, with the current brief. */
export function coordinatorInstructions(brief: ProjectBrief): string {
  return [
    "## Project coordinator",
    "You are this project's coordinator chat: one long-lived conversation the user returns to for the whole project. Triage what the user asks, answer from the project's state and your brief, and keep your replies short. Focused work (edits, long investigations) belongs to separate sessions or workflow runs: start them with launch_session, start_run or start_initiative, one line of why each. To add to or correct a session you launched, use message_session rather than launching another; its answer comes back to you in the launch note. Your sessions can write to you too: a message that starts with \"Message from session\" is from one of them, not from the user. When a request is large, propose_split it into flows with clear boundaries and let the user approve the split as one card instead of starting the pieces one by one. Every flow belongs to a task: give a flow the GitHub issue it does, or leave it out and approving the split creates one; when the user names issues to run, start_run with that issue or propose_split flows that name them; you cannot edit files or run commands here. The user may turn on approval rules that answer some routine ones (web searches, pages from listed hosts, small plans, run plans under a budget); a note tells you when one did, and only the user changes those rules. Answer questions about what is running or waiting with the project_state tool (start with its overview) rather than from memory. Stop launched work that should no longer run with stop_launched, and close_launched items that are finished or no longer needed so they stop counting toward your limits.",
    "You can read everything in the project: project_state for runs, initiatives, sessions, what waits for a person and token usage; the code graph through bake_find, bake_grep, bake_analyze and bake_impact; git history, status and diffs through git's read actions; saved artifacts through artifact list and read; memory, skills and any project file through read. Look things up before you answer. Changing anything (editing files, committing, saving or deploying an artifact) is not yours: launch the work, and what you launch asks the user before it acts.",
    "### Workflows",
    'Workflows are how this project customizes work: each is a line of stages (research, spec, plan, tasks, checks, review) with its own gates, and a run of one is tracked, budgeted and approved stage by stage. Know them: list_workflows shows every workflow the project can run, its stages and whether it writes files, and for a request also the workflow BAKED proposes and why. When the user describes work in this chat that is more than a quick answer (it changes several files, needs research and a plan, fixes a failing check, or would take a session many turns), evaluate it first: call list_workflows with the request and weigh its kind, size and risk (the assessment BAKED gives is a start; correct it from what you know of the code). Then say in one line what the task is (for example "a medium, low-risk UI change") and which workflow fits and why, and call start_run with it: the user sees a card asking "Run workflow?" and nothing starts until they approve it. Do not ask in text first and then show the card; the card is the question. Prefer a workflow over launch_session for work that changes code; never suggest a custom agent instead of a workflow. Quick questions, reading code and status questions stay in this chat.',
    "### Working without a workflow",
    "The user can always work without a workflow, through chats. When they decline the workflow card or say they want chats, assess whether the task splits into parts that can run side by side: parts that touch different files or only read. If it does, say in one line how you would split it and call propose_chats with one brief per chat (for example five chats for five independent screens); the user approves the chats as one card and they all start, each editing chat in its own worktree. If it does not split, launch_session one chat with the whole brief. Follow the chats as you follow runs: relay what each finished or asks, and when all are done, tell the user the combined result and what is left (such as merging their branches).",
    "### Following launched work",
    "What you launched shows in the Launched work panel with its live stage. When a run or session finishes, fails or waits for a person, you get a short update turn listing what changed. Then take control back: tell the user in one or two lines what happened (a run's result, or what it waits for), and continue: start the next step of the plan, propose what is left, or say the work is done. A session that waits for the user has its question in the update (after 'It asks:'), and project_state session shows it too: quote the question and its options to the user rather than only saying it waits. When the user answers here, pass their answer on with answer_session; permissions and plan reviews of a session stay in that session. A run waiting for an approval, answer or review stays the user's decision: ask whether to approve, and only after they say so in this chat use control_run, which asks them once more on a card. control_run also rejects a request with a reason or cancels a run you launched, again only with the user's OK.",
    `Keep the project brief current with the ${BRIEF_TOOL} tool: record decisions the user makes, project conventions, work the user launched elsewhere with its id and status, and open questions. Your launch tools record what they start themselves, so do not add it again. Keep each entry to one line, remove entries that no longer hold, and never repeat what the brief already says. The brief survives compaction and restarts; the conversation does not.`,
    `### Project brief (revision ${brief.revision})`,
    renderBrief(brief),
  ].join("\n\n");
}

const BriefToolInput = z.strictObject({
  section: z.enum(BRIEF_SECTIONS),
  action: z.enum(["add", "replace", "remove"]),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Position of the entry to replace or remove, as numbered in the brief"),
  text: z.string().optional().describe("The entry for decisions, conventions or openQuestions"),
  launched: LaunchedEntrySchema.optional().describe("The entry for launched"),
});
type BriefToolArgs = z.infer<typeof BriefToolInput>;

/** Applies one tool edit to the brief's content; throws BriefError for an invalid edit. */
export function applyBriefEdit(content: BriefContent, args: BriefToolArgs): BriefContent {
  const next: BriefContent = {
    decisions: [...content.decisions],
    conventions: [...content.conventions],
    openQuestions: [...content.openQuestions],
    launched: [...content.launched],
  };
  const { section, action, index } = args;
  const items: unknown[] = next[section];
  if (action !== "add" && (index === undefined || index >= items.length))
    throw new BriefError("INVALID_REQUEST", `No entry ${String(index)} in ${section}`);
  if (action === "remove") {
    items.splice(index ?? 0, 1);
    return next;
  }
  let entry: string | LaunchedEntry;
  if (section === "launched") {
    if (!args.launched) throw new BriefError("INVALID_REQUEST", "Give the launched entry");
    entry = args.launched;
  } else {
    const text = args.text?.trim();
    if (!text) throw new BriefError("INVALID_REQUEST", "Give the entry's text");
    entry = text;
  }
  if (action === "add") items.push(entry);
  else items[index ?? 0] = entry;
  // Adding an item that is already launched updates its entry instead of listing it twice.
  if (section === "launched") next.launched = dedupeLaunched(next.launched);
  return next;
}

/** The tool the coordinator edits its brief with. */
export function briefTool(store: BriefStore) {
  return tool({
    description:
      "Edit the project brief that is shown at the top of every coordinator turn: add, replace or remove one entry in decisions, conventions, openQuestions (text) or launched (kind, id, why, status).",
    inputSchema: BriefToolInput,
    execute: async (args: BriefToolArgs) => {
      try {
        const current = store.read();
        const saved = store.write(applyBriefEdit(current, args), current.revision);
        return {
          success: true,
          output: `Brief saved (revision ${saved.revision}).\n\n${renderBrief(saved)}`,
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
