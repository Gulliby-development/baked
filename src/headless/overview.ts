import { existsSync } from "node:fs";
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../config/index.js";
import { getCwd } from "../core/cwd.js";
import { workspacePath } from "../core/specs/validate.js";
import { type AttentionItem, attentionItems } from "../core/workflows/attention.js";
import { InitiativeStore } from "../core/workflows/initiatives/store.js";
import { NativeWorkflowService } from "../core/workflows/service.js";
import { USAGE_DIMENSIONS, type UsageDimension, usageSummary } from "../core/workflows/usage.js";

const usageHelp = `Usage: baked usage [--days N] [--group-by DIM[,DIM]] [--model ID] [--stage ID] [--json]

Token use and estimated cost of the workflow attempts of this project that started in the last
N days (default 7, at most 366), across runs. DIM is model, stage or day (default model); with
two, each row is one combination. --model filters by model ((host) for host attempts), --stage
by stage. For one run use "baked workflow usage RUN_ID".
`;

const attentionHelp = `Usage: baked attention [--json]

What waits for a person in this project: pending decisions of workflow runs, blocked runs and
pending initiative decisions, oldest first. Chat prompts are listed by the local API
(GET /v1/attention) only, where the chat sessions run.
`;

interface Flags {
  values: Map<string, string>;
  booleans: Set<string>;
}

/** Splits `--name value`, `--name=value` and boolean flags; anything else is an error. */
function parseFlags(argv: string[], valued: string[], booleans: string[]): Flags | string {
  const flags: Flags = { values: new Map(), booleans: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") ? arg.slice(2, eq < 0 ? undefined : eq) : "";
    if (booleans.includes(name) && eq < 0) flags.booleans.add(name);
    else if (valued.includes(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "") return `--${name} needs a value`;
      flags.values.set(name, value);
    } else return `Unknown argument: ${arg}`;
  }
  return flags;
}

/** The project's workflows, read-only; null when no run was ever started here. */
function openReadonly(): NativeWorkflowService | null {
  const cwd = getCwd();
  if (!existsSync(workspacePath(cwd, ".baked/workflows.sqlite"))) return null;
  return new NativeWorkflowService(
    cwd,
    mergeConfigs(loadConfig(), loadEffectiveProjectConfig(cwd)),
    undefined,
    true,
  );
}

const count = (n: number): string => n.toLocaleString("en-US");

export async function runUsageCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usageHelp);
    return 0;
  }
  const flags = parseFlags(argv, ["days", "group-by", "model", "stage"], ["json"]);
  if (typeof flags === "string") {
    process.stderr.write(`${flags}\n\n${usageHelp}`);
    return 1;
  }
  const days = flags.values.get("days") ?? "7";
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 366) {
    process.stderr.write("--days needs a number of days from 1 to 366\n");
    return 1;
  }
  const groupBy = (flags.values.get("group-by") ?? "model").split(",");
  if (
    groupBy.length > 2 ||
    new Set(groupBy).size !== groupBy.length ||
    !groupBy.every((d) => (USAGE_DIMENSIONS as readonly string[]).includes(d))
  ) {
    process.stderr.write(
      `--group-by takes one or two of ${USAGE_DIMENSIONS.join(", ")}, separated by a comma\n`,
    );
    return 1;
  }
  const model = flags.values.get("model");
  const stage = flags.values.get("stage");
  const service = openReadonly();
  try {
    const summary = usageSummary(service?.store ?? null, {
      days: Number(days),
      groupBy: groupBy as UsageDimension[],
      ...(model !== undefined ? { model } : {}),
      ...(stage !== undefined ? { stage } : {}),
    });
    if (flags.booleans.has("json")) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    const cost = (usd: number, unpriced: number): string =>
      `$${usd.toFixed(2)}${unpriced > 0 ? ` (+${count(unpriced)} unpriced tokens)` : ""}`;
    const out = [
      `Last ${String(summary.days)} day${summary.days === 1 ? "" : "s"}: ${count(summary.tokens)} tokens, ${cost(summary.costUsd, summary.unpricedTokens)}, ${String(summary.runs)} run${summary.runs === 1 ? "" : "s"}, ${String(summary.attempts)} attempt${summary.attempts === 1 ? "" : "s"}`,
    ];
    const width = Math.max(0, ...summary.groups.map((g) => g.key.length));
    for (const group of summary.groups)
      out.push(
        `  ${group.key.padEnd(width)}  ${count(group.tokens).padStart(13)} tokens  ${cost(group.costUsd, group.unpricedTokens)}  ${String(group.runs)} run${group.runs === 1 ? "" : "s"}`,
      );
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  } finally {
    service?.close();
  }
}

function attentionLine(item: AttentionItem): string {
  const when = new Date(item.createdAt).toISOString().slice(0, 16).replace("T", " ");
  const what = item.requestId === null ? `blocked: ${item.kind}` : item.kind;
  const where =
    item.source === "run"
      ? `run ${item.runId ?? ""} (${item.featureId ?? ""})`
      : item.source === "initiative"
        ? `initiative ${item.initiativeId ?? ""} "${item.title ?? ""}"`
        : `chat ${item.sessionId ?? ""} "${item.title ?? ""}"`;
  return `  ${when}  ${where}  ${what}${item.blocking ? "" : " (advisory)"}${item.requestId ? `  request ${item.requestId}` : ""}`;
}

export async function runAttentionCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(attentionHelp);
    return 0;
  }
  const flags = parseFlags(argv, [], ["json"]);
  if (typeof flags === "string") {
    process.stderr.write(`${flags}\n\n${attentionHelp}`);
    return 1;
  }
  const service = openReadonly();
  try {
    const items = service ? attentionItems(service.store, new InitiativeStore(service.store)) : [];
    if (flags.booleans.has("json")) {
      process.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      items.length
        ? `${String(items.length)} waiting for a person:\n${items.map(attentionLine).join("\n")}\n`
        : "Nothing waits for a person.\n",
    );
    return 0;
  } finally {
    service?.close();
  }
}
