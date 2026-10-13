/**
 * The approval rules as text commands, shared by `/coordinator rules` in the terminal app and
 * `baked session coordinator rules` in the CLI. Each call reads the rules, applies one change and
 * saves it by revision, as the desktop app and `PUT /v1/coordinator/approval-rules` do.
 */
import { SessionManager } from "../sessions/manager.js";
import {
  type ApprovalRule,
  type ApprovalRuleKind,
  type ApprovalRules,
  ApprovalRulesStore,
  ruleText,
} from "./approval-rules.js";

export const RULES_USAGE = `rules                      show the switch, the rules and the latest answers
rules on | off             answer approvals by the rules, or let every approval wait for you
rules add web-search       approve web searches of launched sessions
rules add pages HOST...    approve fetching https pages from these hosts
rules add plans N          execute plans of at most N steps
rules add runs TOKENS [GLOB...]
                           approve run plans with a budget up to TOKENS (2M, 500k),
                           only writing files that match the globs when given
rules remove ID            remove a rule`;

/** What always waits for a person, whatever the rules say. */
export const ALWAYS_YOURS =
  "Destructive commands, paths outside the project, questions, splits, and run plans that touch secrets, CI or deploy config, manifests, deletions or uncommitted changes always wait for you.";

export class RulesCommandError extends Error {}

/** The project's coordinator session id, or null before the coordinator exists. */
export function coordinatorId(workspace: string): string | null {
  return (
    new SessionManager(workspace).listSessions().find((s) => s.kind === "coordinator")?.id ?? null
  );
}

function parseTokens(text: string): number {
  const match = /^(\d+(?:[.,]\d+)?)\s*([km])?$/i.exec(text.trim());
  if (!match?.[1]) throw new RulesCommandError(`${text} is not a token count such as 2M or 500k`);
  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1000 : 1;
  return Math.round(Number(match[1].replace(",", ".")) * scale);
}

function newId(kind: ApprovalRuleKind, rules: ApprovalRule[]): string {
  const taken = new Set(rules.map((r) => r.id));
  for (let n = 1; ; n++) {
    const id = n === 1 ? kind : `${kind}-${n}`;
    if (!taken.has(id)) return id;
  }
}

function ruleFrom(args: string[], rules: ApprovalRule[]): ApprovalRule {
  const [what, ...rest] = args;
  switch (what) {
    case "web-search":
    case "searches":
      return { id: newId("web-search", rules), kind: "web-search" };
    case "pages":
    case "fetch-page":
      if (!rest.length)
        throw new RulesCommandError("Name at least one host, such as docs.github.com");
      return {
        id: newId("fetch-page", rules),
        kind: "fetch-page",
        hosts: [
          ...new Set(
            rest.map((h) =>
              h
                .toLowerCase()
                .replace(/^https?:\/\//, "")
                .replace(/\/.*$/, ""),
            ),
          ),
        ],
      };
    case "plans":
    case "plan-review": {
      const steps = Number(rest[0]);
      if (!Number.isInteger(steps))
        throw new RulesCommandError("Give the most steps, such as: plans 5");
      return { id: newId("plan-review", rules), kind: "plan-review", maxSteps: steps };
    }
    case "runs":
    case "run-approval": {
      if (!rest[0]) throw new RulesCommandError("Give the budget, such as: runs 2M src/**");
      const paths = rest.slice(1);
      return {
        id: newId("run-approval", rules),
        kind: "run-approval",
        maxTokens: parseTokens(rest[0]),
        ...(paths.length ? { paths } : {}),
      };
    }
    default:
      throw new RulesCommandError(
        `Unknown rule ${what ?? ""}; use web-search, pages, plans or runs`,
      );
  }
}

const time = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** The switch, the rules with their ids, what stays with the person, and the latest answers. */
export function renderRules(rules: ApprovalRules): string {
  const lines = [
    `Approval rules: ${rules.enabled ? "on" : "off (every approval waits for you)"}`,
    ...(rules.rules.length
      ? rules.rules.map((rule) => `  ${rule.id}: ${ruleText(rule)}`)
      : ["  No rules yet."]),
    "",
    ALWAYS_YOURS,
  ];
  const recent = rules.log.slice(-5).reverse();
  if (recent.length)
    lines.push(
      "",
      "Answered by rules:",
      ...recent.map((a) => `  ${time(a.at)}  ${a.title ?? a.id.slice(0, 8)}: approved ${a.what}`),
    );
  return lines.join("\n");
}

/** Runs one rules command (`args` after `rules`) and returns what it prints. */
export function runRulesCommand(workspace: string, coordinator: string, args: string[]): string {
  const store = new ApprovalRulesStore(workspace, coordinator);
  const current = store.read();
  const [command, ...rest] = args;
  const save = (next: Pick<ApprovalRules, "enabled" | "rules">, done: string): string => {
    try {
      return `${done}\n\n${renderRules(store.write(next, current.revision))}`;
    } catch (error) {
      throw new RulesCommandError(error instanceof Error ? error.message : String(error));
    }
  };
  switch (command) {
    case undefined:
    case "list":
      return renderRules(current);
    case "on":
    case "off":
      return save(
        { enabled: command === "on", rules: current.rules },
        command === "on"
          ? "The coordinator now answers matching approvals of what it launched."
          : "Approval rules are off; every approval waits for you.",
      );
    case "add": {
      const rule = ruleFrom(rest, current.rules);
      return save(
        { enabled: current.enabled, rules: [...current.rules, rule] },
        `Added ${rule.id}.`,
      );
    }
    case "remove": {
      const id = rest[0];
      if (!id || !current.rules.some((r) => r.id === id))
        throw new RulesCommandError(`No rule ${id ?? ""}; the ids are listed by rules`);
      return save(
        { enabled: current.enabled, rules: current.rules.filter((r) => r.id !== id) },
        `Removed ${id}.`,
      );
    }
    default:
      throw new RulesCommandError(`Unknown rules command ${command}\n\n${RULES_USAGE}`);
  }
}
