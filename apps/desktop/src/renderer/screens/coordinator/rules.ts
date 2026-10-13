import type { ApprovalRule, ApprovalRuleKind } from "../../client/coordinator.js";
import type { IconName } from "../../components/Icon.js";

/** What each kind of rule answers, as the add form and the rule cards name it. */
export const RULE_KINDS: Record<ApprovalRuleKind, { label: string; icon: IconName; help: string }> =
  {
    "web-search": {
      label: "Web searches",
      icon: "search",
      help: "Approve the web searches of sessions the coordinator launched.",
    },
    "fetch-page": {
      label: "Pages",
      icon: "globe",
      help: "Approve fetching https pages from these hosts and their subdomains.",
    },
    "plan-review": {
      label: "Small plans",
      icon: "plan",
      help: "Execute a plan made in plan mode when it has at most this many steps. Plans that mention secrets, deploys or releases still wait for you.",
    },
    "run-approval": {
      label: "Run plans",
      icon: "runs",
      help: "Approve a run's plan when its token budget is at most this much, and optionally only when every file it writes matches these paths.",
    },
  };

export const RULE_KIND_ORDER: ApprovalRuleKind[] = [
  "web-search",
  "fetch-page",
  "plan-review",
  "run-approval",
];

/** What always waits for a person, whatever the rules say. */
export const ALWAYS_YOURS =
  "Destructive commands, paths outside the project, questions, splits, and run plans that touch secrets, CI or deploy config, manifests, deletions or your uncommitted changes always wait for you.";

const compact = (n: number): string =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

/** A rule as one line, as the core writes it in the log. */
export function ruleLine(rule: ApprovalRule): string {
  switch (rule.kind) {
    case "run-approval":
      return `Approve run plans with a budget up to ${compact(rule.maxTokens)} tokens${rule.paths ? ` that write only ${rule.paths.join(", ")}` : ""}`;
    case "web-search":
      return "Approve web searches of launched sessions";
    case "fetch-page":
      return `Approve fetching pages from ${rule.hosts.join(", ")}`;
    case "plan-review":
      return `Approve plans of up to ${rule.maxSteps} steps`;
  }
}

/** The fields of the add form, as typed. */
export interface RuleDraft {
  kind: ApprovalRuleKind;
  hosts: string;
  maxSteps: string;
  /** Millions of tokens. */
  maxTokens: string;
  paths: string;
}

export const emptyDraft = (kind: ApprovalRuleKind = "web-search"): RuleDraft => ({
  kind,
  hosts: "",
  maxSteps: "5",
  maxTokens: "2",
  paths: "",
});

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const list = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/** An id for a new rule of `kind` that no rule in `rules` has. */
export function newRuleId(kind: ApprovalRuleKind, rules: ApprovalRule[]): string {
  const taken = new Set(rules.map((r) => r.id));
  for (let n = 1; ; n++) {
    const id = n === 1 ? kind : `${kind}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The rule a draft stands for, or what is wrong with it. */
export function ruleFromDraft(
  draft: RuleDraft,
  rules: ApprovalRule[],
): { rule: ApprovalRule } | { error: string } {
  const id = newRuleId(draft.kind, rules);
  switch (draft.kind) {
    case "web-search":
      if (rules.some((r) => r.kind === "web-search"))
        return { error: "Web searches are approved already." };
      return { rule: { id, kind: "web-search" } };
    case "fetch-page": {
      const hosts = list(draft.hosts.toLowerCase()).map((h) =>
        h.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
      );
      if (!hosts.length) return { error: "Name at least one host, such as docs.github.com." };
      const bad = hosts.find((h) => !HOST.test(h));
      if (bad) return { error: `${bad} is not a host name.` };
      return { rule: { id, kind: "fetch-page", hosts: [...new Set(hosts)] } };
    }
    case "plan-review": {
      const steps = Number(draft.maxSteps);
      if (!Number.isInteger(steps) || steps < 1 || steps > 50)
        return { error: "Steps are a whole number from 1 to 50." };
      return { rule: { id, kind: "plan-review", maxSteps: steps } };
    }
    case "run-approval": {
      const millions = Number(draft.maxTokens.replace(",", "."));
      if (!Number.isFinite(millions) || millions <= 0 || millions > 1000)
        return { error: "The budget is a number of million tokens, up to 1000." };
      const paths = list(draft.paths);
      return {
        rule: {
          id,
          kind: "run-approval",
          maxTokens: Math.round(millions * 1_000_000),
          ...(paths.length ? { paths } : {}),
        },
      };
    }
  }
}
