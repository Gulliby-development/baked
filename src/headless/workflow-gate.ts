import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkflowFault } from "../core/workflows/errors.js";
import type { RunPolicy } from "../core/workflows/schemas.js";
import {
  configuredDraftModel,
  type DraftKind,
  type DraftModel,
  draftGate,
  type GateDraft,
  gateCapabilities,
  saveGateDraft,
} from "../core/workflows/v2/gate-draft.js";
import { describeGate, loadGateLibrary, readConfirmations } from "../core/workflows/v2/library.js";
import type { AppConfig } from "../types/index.js";
import type { WorkflowArgs } from "./workflow-parse.js";

export interface GateCommandResult {
  result: unknown;
  /** What a person reads in the terminal; `--json` prints `result` instead. */
  text: string;
  exitCode: number;
}

const flag = (args: WorkflowArgs, name: string): string | undefined =>
  typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined;

function gateRows(workspace: string, policy: RunPolicy) {
  const library = loadGateLibrary(workspace, policy);
  const confirmed = readConfirmations(workspace);
  return {
    library,
    rows: [...library.entries.values()].map((entry) => ({
      id: entry.gate.id,
      type: entry.gate.type,
      mode: entry.gate.required ? "required" : "advisory",
      source: entry.source,
      path: entry.path,
      summary: describeGate(entry),
      ...(entry.source === "project" ? { confirmed: confirmed[entry.gate.id] === entry.hash } : {}),
    })),
  };
}

export function formatDraft(draft: GateDraft): string {
  const lines = [
    `Draft gate ${draft.gate.id} (${draft.gate.type}, ${draft.gate.required ? "required" : "advisory"})`,
    `  ${draft.gate.description}`,
  ];
  if (draft.gate.type === "ai-acceptance") {
    const { scenario } = draft.gate.acceptance;
    lines.push("  Steps:", ...scenario.steps.map((s, i) => `    ${i + 1}. ${s}`));
    lines.push("  Expectations:", ...scenario.expectations.map((e, i) => `    E${i + 1}. ${e}`));
  }
  lines.push("  It may:", ...draft.capabilities.map((c) => `    - ${c}`));
  if (draft.script) lines.push(`  Test script ${draft.script.path}:`, indent(draft.script.content));
  if (draft.problems.length)
    lines.push("  Cannot be saved:", ...draft.problems.map((p) => `    - ${p}`));
  return `${lines.join("\n")}\n`;
}

const indent = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

/**
 * `baked workflow gate new|save|list|show`: gates from a sentence (#372). `new` calls the model
 * and writes nothing unless `--save` is given; `save --file` writes a draft printed with `--json`.
 */
export async function executeGateCommand(
  args: WorkflowArgs,
  workspace: string,
  config: AppConfig,
  policy: RunPolicy,
  model?: DraftModel,
): Promise<GateCommandResult> {
  const [sub, ...rest] = args.positional;
  switch (sub) {
    case "list": {
      const { rows, library } = gateRows(workspace, policy);
      const text = rows
        .map(
          (r) =>
            `${r.id}  ${r.type}  ${r.mode}  ${r.source}${r.confirmed === false ? "  (not confirmed)" : ""}\n    ${r.summary}`,
        )
        .join("\n");
      return {
        result: { gates: rows, problems: library.problems },
        text: `${text || "No gates."}\n`,
        exitCode: 0,
      };
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new WorkflowFault("INVALID_DEFINITION", "gate show needs a gate ID");
      const { library, rows } = gateRows(workspace, policy);
      const entry = library.entries.get(id);
      const row = rows.find((r) => r.id === id);
      if (!entry || !row) throw new WorkflowFault("NOT_FOUND", `No gate ${id}`);
      const capabilities = gateCapabilities(entry.gate, null);
      return {
        result: { ...row, capabilities, gate: entry.gate },
        text: `${row.id} (${row.type}, ${row.mode}, ${row.source})\n  ${entry.gate.description}\n  ${row.summary}\n${capabilities.map((c) => `  - ${c}`).join("\n")}\n`,
        exitCode: 0,
      };
    }
    case "new": {
      const text = flag(args, "text") ?? rest.join(" ");
      const kind = flag(args, "kind");
      if (kind !== undefined && kind !== "command" && kind !== "ai-acceptance")
        throw new WorkflowFault("INVALID_DEFINITION", "--kind is command or ai-acceptance");
      const id = flag(args, "id");
      const library = loadGateLibrary(workspace, policy);
      const draft = await draftGate(
        workspace,
        {
          text,
          ...(kind ? { kind: kind as DraftKind } : {}),
          ...(id ? { id } : {}),
          ...(args.flags["from-criteria"] === true ? { fromCriteria: true } : {}),
        },
        model ?? configuredDraftModel(config, flag(args, "model")),
        library,
      );
      if (args.flags.save !== true)
        return {
          result: draft,
          text: `${formatDraft(draft)}${draft.problems.length ? "" : `Save it with --save, or print it with --json and run "baked workflow gate save --file FILE".\n`}`,
          exitCode: draft.problems.length ? 1 : 0,
        };
      if (draft.problems.length) return { result: draft, text: formatDraft(draft), exitCode: 1 };
      const saved = saveGateDraft(workspace, draft, () => loadGateLibrary(workspace, policy));
      return {
        result: { ...draft, saved },
        text: `${formatDraft(draft)}Saved ${saved.path}${saved.script ? ` and ${saved.script}` : ""}; bind it to a workflow with /workflow edit or the desktop Gates screen.\n`,
        exitCode: 0,
      };
    }
    case "save": {
      const file = flag(args, "file");
      if (!file) throw new WorkflowFault("INVALID_DEFINITION", "gate save needs --file DRAFT.json");
      const draft = JSON.parse(readFileSync(resolve(workspace, file), "utf8")) as {
        gate?: unknown;
        script?: GateDraft["script"];
      };
      const saved = saveGateDraft(
        workspace,
        { gate: draft.gate, script: draft.script ?? null },
        () => loadGateLibrary(workspace, policy),
      );
      return {
        result: { saved },
        text: `Saved ${saved.path}${saved.script ? ` and ${saved.script}` : ""}.\n`,
        exitCode: 0,
      };
    }
    default:
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "gate takes new TEXT, save --file FILE, list or show ID",
      );
  }
}
