/**
 * Rules the user sets for the routine approvals of what the coordinator launched. With the rules
 * on, the coordinator answers an approval that matches one itself, in code rather than by the
 * model: it records each answer in the rules log and notes it in its own chat and in the
 * transcript of the session it answered for. The rules are off by default and only a person edits
 * them (the local API, the desktop app, `/coordinator rules` in the terminal app); the coordinator's
 * model can neither read nor change them.
 *
 * Some approvals always go to a person whatever the rules say: destructive commands, paths outside
 * the project, questions, splits, plans that mention secrets or deployment, and run approvals that
 * write secrets, CI or deployment configuration or manifests, delete files, touch uncommitted user
 * changes, defer post-release criteria or approve tests written first.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LaunchNote } from "../../types/index.js";
import { writeViaTemp } from "../workflows/atomic-write.js";
import { alwaysNeedsPerson } from "../workflows/auto-approval.js";
import { BriefError, BriefStore, type LaunchedEntry } from "./coordinator.js";
import type { ProjectStateSource } from "./project-state.js";
import type { ChatPrompt, ChatService, ChatSession } from "./sessions.js";

export const MAX_RULES = 30;
export const RULES_LOG_MAX = 100;

const RuleId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "A rule id is lowercase letters, digits and hyphens");
const Host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "A host such as docs.github.com",
  );
const PathGlob = z.string().trim().min(1).max(200);

export const ApprovalRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: RuleId,
    /** A run's plan approval, when its token budget is at most `maxTokens`. */
    kind: z.literal("run-approval"),
    maxTokens: z.number().int().positive().max(1_000_000_000),
    /** Globs every written file must match; left out, any path the person-only list allows. */
    paths: z.array(PathGlob).min(1).max(20).optional(),
  }),
  z.strictObject({ id: RuleId, kind: z.literal("web-search") }),
  z.strictObject({
    id: RuleId,
    /** Fetching an https page from one of `hosts` or their subdomains. */
    kind: z.literal("fetch-page"),
    hosts: z.array(Host).min(1).max(50),
  }),
  z.strictObject({
    id: RuleId,
    /** Executing a plan of at most `maxSteps` steps made in plan mode. */
    kind: z.literal("plan-review"),
    maxSteps: z.number().int().min(1).max(50),
  }),
]);
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;
export type ApprovalRuleKind = ApprovalRule["kind"];

export const ApprovalRulesContentSchema = z.strictObject({
  enabled: z.boolean(),
  rules: z
    .array(ApprovalRuleSchema)
    .max(MAX_RULES)
    .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "Rule ids repeat"),
});
export type ApprovalRulesContent = z.infer<typeof ApprovalRulesContentSchema>;

/** One approval the coordinator answered by a rule. */
export interface AutoAnswer {
  at: number;
  ruleId: string;
  /** The rule as it read when it answered. */
  rule: string;
  kind: "session" | "run";
  id: string;
  title?: string;
  /** What was approved, as one line. */
  what: string;
}

export interface ApprovalRules extends ApprovalRulesContent {
  revision: number;
  updatedAt: number;
  /** The latest answers, newest last, at most `RULES_LOG_MAX`. */
  log: AutoAnswer[];
}

const emptyRules = (): ApprovalRules => ({
  revision: 0,
  updatedAt: 0,
  enabled: false,
  rules: [],
  log: [],
});

/** The rules of one coordinator, in `.baked/sessions/ID/approval-rules.json` next to its brief. */
export class ApprovalRulesStore {
  readonly path: string;

  constructor(workspace: string, coordinatorId: string) {
    this.path = join(workspace, ".baked", "sessions", coordinatorId, "approval-rules.json");
  }

  read(): ApprovalRules {
    if (!existsSync(this.path)) return emptyRules();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<ApprovalRules>;
      const content = ApprovalRulesContentSchema.parse({
        enabled: raw.enabled === true,
        rules: raw.rules ?? [],
      });
      return {
        revision: typeof raw.revision === "number" ? raw.revision : 0,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        ...content,
        log: Array.isArray(raw.log) ? raw.log.slice(-RULES_LOG_MAX) : [],
      };
    } catch {
      // Damaged rules answer nothing: a person sees every approval until they are saved again.
      return emptyRules();
    }
  }

  /** Saves the switch and the rules when the stored revision is still `expectedRevision`. */
  write(content: ApprovalRulesContent, expectedRevision: number): ApprovalRules {
    const parsed = ApprovalRulesContentSchema.safeParse(content);
    if (!parsed.success)
      throw new BriefError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid rules");
    const current = this.read();
    if (current.revision !== expectedRevision)
      throw new BriefError(
        "STALE_REVISION",
        `The rules are at revision ${current.revision}, not ${expectedRevision}; reload them and retry`,
      );
    return this.save({ ...current, ...parsed.data, revision: current.revision + 1 });
  }

  /** Appends answers to the log; the rules and their revision stay as they are. */
  record(answers: AutoAnswer[]): void {
    if (!answers.length) return;
    const current = this.read();
    this.save({ ...current, log: [...current.log, ...answers].slice(-RULES_LOG_MAX) });
  }

  private save(rules: ApprovalRules): ApprovalRules {
    const next = { ...rules, updatedAt: Date.now() };
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    writeViaTemp(this.path, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "w",
      flush: true,
      mode: 0o600,
    });
    return next;
  }
}

const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

/** A rule as one line a person reads. */
export function ruleText(rule: ApprovalRule): string {
  switch (rule.kind) {
    case "run-approval":
      return `Approve run plans with a budget up to ${tokens(rule.maxTokens)} tokens${rule.paths ? ` that write only ${rule.paths.join(", ")}` : ""}`;
    case "web-search":
      return "Approve web searches of launched sessions";
    case "fetch-page":
      return `Approve fetching pages from ${rule.hosts.join(", ")}`;
    case "plan-review":
      return `Approve plans of up to ${rule.maxSteps} steps`;
  }
}

/** Words that keep a plan with a person: secrets, credentials and anything that ships. */
const RISKY_PLAN =
  /\b(?:secrets?|credentials?|passwords?|api[ _-]?keys?|private keys?|deploy\w*|publish\w*|releases?|production|force[- ]push\w*)\b|\.env\b/i;

function hostAllowed(url: string, hosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The rule that answers a session prompt, or null when it stays with a person. */
export function matchPrompt(rules: ApprovalRule[], prompt: ChatPrompt): ApprovalRule | null {
  switch (prompt.kind) {
    case "web-search":
      return rules.find((r) => r.kind === "web-search") ?? null;
    case "fetch-page":
      return rules.find((r) => r.kind === "fetch-page" && hostAllowed(prompt.url, r.hosts)) ?? null;
    case "plan-review":
      if (RISKY_PLAN.test(`${prompt.title}\n${prompt.content}`)) return null;
      return (
        rules.find((r) => r.kind === "plan-review" && prompt.steps.length <= r.maxSteps) ?? null
      );
    default:
      // Destructive commands, paths outside the project, questions and splits: always a person.
      return null;
  }
}

/** What the coordinator reads of a run's pending approval request. */
export interface RunApprovalBody {
  writes?: { path: string; action: string }[];
  policy?: { maxTotalTokens?: number };
  worktree?: { userChangesInScope?: string[] };
  deferredCriteria?: string[];
  testsFirst?: unknown;
}

/** Why a run approval stays with a person whatever the rules; empty when a rule may answer it. */
export function personOnly(body: RunApprovalBody): string[] {
  const reasons: string[] = [];
  if (body.testsFirst !== undefined) reasons.push("tests written first are reviewed by a person");
  if (!Array.isArray(body.writes)) reasons.push("the plan lists no writes");
  for (const write of body.writes ?? []) {
    if (write.action === "delete") reasons.push(`${write.path} would be deleted`);
    else if (alwaysNeedsPerson(write.path)) reasons.push(`${write.path} always needs a person`);
  }
  if (body.worktree?.userChangesInScope?.length)
    reasons.push("it writes files with uncommitted changes");
  if (body.deferredCriteria?.length) reasons.push("it defers post-release criteria");
  if (typeof body.policy?.maxTotalTokens !== "number") reasons.push("its budget is unknown");
  return reasons;
}

/** The rule that answers a run's plan approval, or null when it stays with a person. */
export function matchRunApproval(
  rules: ApprovalRule[],
  body: RunApprovalBody,
): Extract<ApprovalRule, { kind: "run-approval" }> | null {
  if (personOnly(body).length) return null;
  const budget = body.policy?.maxTotalTokens ?? Number.POSITIVE_INFINITY;
  const paths = (body.writes ?? []).map((w) => w.path.toLowerCase());
  for (const rule of rules) {
    if (rule.kind !== "run-approval" || budget > rule.maxTokens) continue;
    const globs = rule.paths?.map((p) => new Bun.Glob(p.toLowerCase()));
    if (globs && !paths.every((path) => globs.some((g) => g.match(path)))) continue;
    return rule;
  }
  return null;
}

/** Approves a run's pending plan approval and continues the run, as the person's approve does. */
export interface RunApprover {
  approveRun(input: {
    runId: string;
    requestId: string;
    digest: string;
    expectedRevision: number;
  }): Promise<void>;
}

function promptWhat(prompt: ChatPrompt): string {
  switch (prompt.kind) {
    case "web-search":
      return `web search "${prompt.query}"`;
    case "fetch-page":
      return `fetching ${prompt.url}`;
    case "plan-review":
      return `the plan "${prompt.title}" (${prompt.steps.length} steps)`;
    default:
      return prompt.kind;
  }
}

/** The coordinator's note about an answer, as its chat shows it. */
export function autoAnswerText(answer: AutoAnswer): string {
  const name = answer.title ? `"${answer.title}"` : `${answer.kind} ${answer.id.slice(0, 8)}`;
  return `Approved ${answer.what} for ${name} by the rule: ${answer.rule}.`;
}

/**
 * Answers the pending approvals of what the coordinator launched that a rule covers. `tried`
 * holds run requests already attempted, so a failing approval is not retried on every check.
 * Returns the answers it gave.
 */
export async function answerByRules(
  chat: ChatService,
  coordinator: ChatSession,
  state: ProjectStateSource | null,
  approver: RunApprover | null,
  tried: Set<string>,
): Promise<AutoAnswer[]> {
  const store = new ApprovalRulesStore(chat.workspace, coordinator.id);
  const { enabled, rules } = store.read();
  if (!enabled || !rules.length) return [];
  const answers: AutoAnswer[] = [];
  const answer = (entry: LaunchedEntry, rule: ApprovalRule, what: string): AutoAnswer => ({
    at: Date.now(),
    ruleId: rule.id,
    rule: ruleText(rule),
    kind: entry.kind === "run" ? "run" : "session",
    id: entry.id,
    ...(entry.title ? { title: entry.title } : {}),
    what,
  });
  for (const entry of new BriefStore(chat.workspace, coordinator.id).read().launched) {
    if (entry.kind === "session") {
      let session: ChatSession;
      try {
        session = chat.get(entry.id);
      } catch {
        continue;
      }
      for (const prompt of session.pendingPrompts) {
        const rule = matchPrompt(rules, prompt);
        if (!rule) continue;
        const given = answer(entry, rule, promptWhat(prompt));
        try {
          session.answer(
            prompt.id,
            prompt.kind === "plan-review" ? { action: "execute" } : { approve: true },
          );
        } catch {
          continue;
        }
        answers.push(given);
        await session.addNotice(
          `The project coordinator ${autoAnswerText(given).replace(/^A/, "a")}`,
        );
      }
    } else if (entry.kind === "run" && state && approver) {
      let detail: ReturnType<ProjectStateSource["run"]>;
      try {
        detail = state.run(entry.id);
      } catch {
        continue;
      }
      for (const request of detail.pendingRequests) {
        if (request.kind !== "approval" || !request.digest || tried.has(request.id)) continue;
        const body = (request.body ?? {}) as RunApprovalBody;
        const rule = matchRunApproval(rules, body);
        if (!rule) continue;
        tried.add(request.id);
        const files = new Set((body.writes ?? []).map((w) => w.path)).size;
        const given = answer(
          entry,
          rule,
          `the plan of run ${entry.id.slice(0, 8)} (${tokens(body.policy?.maxTotalTokens ?? 0)} tokens, ${files} files)`,
        );
        try {
          await approver.approveRun({
            runId: entry.id,
            requestId: request.id,
            digest: request.digest,
            expectedRevision: detail.summary.snapshot.revision,
          });
        } catch {
          continue;
        }
        answers.push(given);
      }
    }
  }
  if (!answers.length) return [];
  store.record(answers);
  for (const given of answers) {
    const note: LaunchNote = {
      kind: given.kind,
      id: given.id,
      ...(given.title ? { title: given.title } : {}),
      status: "approved by rule",
      why: given.rule,
      event: "auto-answered",
      answered: given.what,
    };
    await coordinator.addNotice(autoAnswerText(given), note);
  }
  return answers;
}
