import {
  type LimitWindow,
  type ProviderLimits,
  readUsageLimits,
  resetsIn,
} from "../core/llm/usage-limits.js";
import { BOLD, DIM, GREEN, PURPLE, RED, RST, YELLOW } from "./constants.js";

const help = `Usage: baked limits [--json]

Shows how much of each subscription's usage limit is left: Codex (read from its app-server),
Claude Code (the last report BAKED's own turns on it recorded) and GitHub Copilot (read from
GitHub). Pay-per-token API keys have no limit and are not listed. --json prints the answer of
the local API's GET /v1/providers/limits.
`;

const BAR = 24;

function bar(w: LimitWindow): string {
  if (w.unlimited) return `${GREEN()}unlimited${RST}`;
  if (w.usedPercent === null) return `${DIM}unknown${RST}`;
  const used = Math.min(100, Math.max(0, w.usedPercent));
  const filled = Math.round((used / 100) * BAR);
  const color = w.status === "limited" ? RED() : w.status === "warning" ? YELLOW() : GREEN();
  const left = Math.max(0, 100 - w.usedPercent);
  return `${color}${"█".repeat(filled)}${RST}${DIM}${"░".repeat(BAR - filled)}${RST} ${String(Math.round(left))}% left`;
}

export function formatLimits(limits: ProviderLimits[], now: Date = new Date()): string {
  const out: string[] = [];
  for (const p of limits) {
    const plan = p.plan ? ` ${DIM}(${p.plan})${RST}` : "";
    out.push(`${BOLD}${PURPLE()}${p.name}${RST}${plan}`);
    for (const w of p.windows) {
      const count =
        w.remaining != null && w.entitlement != null && !w.unlimited
          ? ` ${DIM}${String(w.remaining)}/${String(w.entitlement)}${RST}`
          : "";
      const reset = resetsIn(w.resetsAt, now);
      const tail = [reset && `resets ${reset}`, w.detail].filter(Boolean).join(" · ");
      out.push(`  ${w.label.padEnd(26)} ${bar(w)}${count}${tail ? `  ${DIM}${tail}${RST}` : ""}`);
    }
    if (p.credits) {
      const credits = p.credits.unlimited ? "unlimited" : (p.credits.balance ?? "available");
      out.push(`  ${"Credits".padEnd(26)} ${credits}`);
    }
    const seen =
      p.source === "last-seen" && p.observedAt
        ? ` ${DIM}(as of ${new Date(p.observedAt).toLocaleString()})${RST}`
        : "";
    if (p.message) out.push(`  ${DIM}${p.message}${RST}${seen}`);
    out.push("");
  }
  return out.join("\n");
}

export async function runLimitsCli(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help);
    return 0;
  }
  const unknown = args.filter((a) => a !== "--json");
  if (unknown.length) {
    process.stderr.write(`Unknown argument: ${unknown.join(" ")}\n${help}`);
    return 1;
  }
  const limits = await readUsageLimits();
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ limits }, null, 2)}\n`);
  else process.stdout.write(formatLimits(limits));
  return 0;
}
