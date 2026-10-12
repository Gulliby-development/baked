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
  why: Line,
  status: z.string().trim().min(1).max(200),
});
export type LaunchedEntry = z.infer<typeof LaunchedEntrySchema>;

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
            (l, i) => `${i}. ${l.kind} ${l.id} [${l.status}]: ${l.why.replace(/\s+/g, " ")}`,
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
        launched: raw.launched ?? [],
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
      launched,
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
    "You are this project's coordinator chat: one long-lived conversation the user returns to for the whole project. Triage what the user asks, answer from the project's state and your brief, and keep your replies short. Focused work (edits, long investigations) belongs to separate sessions or workflow runs: say which you would start and why; you cannot edit files or run commands here.",
    `Keep the project brief current with the ${BRIEF_TOOL} tool: record decisions the user makes, project conventions, work you or the user launched with its id and status, and open questions. Keep each entry to one line, remove entries that no longer hold, and never repeat what the brief already says. The brief survives compaction and restarts; the conversation does not.`,
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
