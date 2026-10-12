import { parseUsageArgs, projectUsage, writeUsageMarkdown } from "../../headless/overview.js";
import { usageMarkdown } from "../workflows/usage-markdown.js";
import type { CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";
import { splitWorkflowCommand } from "./workflow.js";

const HELP = `/usage [--days N] [--group-by DIM[,DIM]] [--model ID] [--stage ID]
  Token use and estimated cost of this project's workflow runs, as Markdown (DIM: model, stage, day)
/usage export [FILE] [same options]
  Write it to FILE in the project (default baked-usage-YYYY-MM-DD.md) to share`;

/**
 * `/usage`: the project usage summary of `baked usage` in the chat as Markdown, and `/usage
 * export` writing the same document to a file in the project.
 */
export function register(map: Map<string, CommandHandler>): void {
  map.set("/usage", (input, ctx) => {
    let words = splitWorkflowCommand(input).slice(1);
    if (words[0] === "help" || words.includes("--help")) {
      sysMsg(ctx, HELP);
      return;
    }
    const exporting = words[0] === "export";
    let file: string | undefined;
    if (exporting) {
      words = words.slice(1);
      if (words[0] !== undefined && !words[0].startsWith("--")) {
        file = words[0];
        words = words.slice(1);
      }
    }
    const args = parseUsageArgs(words);
    if (typeof args === "string" || args.json || args.output !== undefined) {
      sysMsg(ctx, `${typeof args === "string" ? args : "Use /usage export FILE"}\n\n${HELP}`);
      return;
    }
    const summary = projectUsage(ctx.cwd, args);
    if (!exporting) {
      sysMsg(ctx, usageMarkdown(summary).trimEnd());
      return;
    }
    const target = file ?? `baked-usage-${new Date().toISOString().slice(0, 10)}.md`;
    sysMsg(ctx, `Usage written to ${writeUsageMarkdown(ctx.cwd, target, summary)}.`);
  });
}
