import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateText } from "ai";
import { z } from "zod";
import type { AppConfig } from "../../../types/index.js";
import { recordModelCall } from "../../diagnostics/model-events.js";
import { resolveModel } from "../../llm/provider.js";
import { buildProviderOptions, supportsTemperature } from "../../llm/provider-options.js";
import { RelativePath, SafeId } from "../schemas.js";
import { type Gate, GateSchema, MAX_ACCEPTANCE_COMMANDS, validateGate } from "./definition.js";
import { confirmGates, describeGate, type GateLibrary, gateDirectories } from "./library.js";

/**
 * Gates written from a plain-language sentence (#372). A model fills only the content of a gate:
 * the command, or the scenario and the commands of a terminal walk-through. The host sets the
 * timeouts, retries, evidence and grants, validates the result like any gate file, and writes
 * nothing until a person saves the draft. The browser driver is never drafted.
 */

export type DraftKind = "command" | "ai-acceptance";

export interface GateDraftRequest {
  text: string;
  /** Leave the choice to the model: an exact output check becomes a command gate. */
  kind?: DraftKind;
  /** The gate ID; the model proposes one otherwise. */
  id?: string;
  /** An AI check that also walks the run's manual acceptance criteria (`fromCriteria`). */
  fromCriteria?: boolean;
}

/** A small script a command gate runs with `bun`; written next to the gate when it is saved. */
export interface DraftScript {
  path: string;
  content: string;
}

export interface GateDraft {
  gate: Gate;
  script: DraftScript | null;
  /** One line: what the gate runs and what it is granted. */
  summary: string;
  /** What the gate may do, in words, for the person who confirms it. */
  capabilities: string[];
  /** Why the draft cannot be saved as it is; empty when it can. */
  problems: string[];
  /** Where the gate file goes, relative to the workspace. */
  path: string;
}

/** One model call: a system prompt and a user prompt in, text out. */
export type DraftModel = (prompt: { system: string; user: string }) => Promise<string>;

const Argv = z
  .object({ executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)).max(40) })
  .strict();

/** What the model returns. Everything else in the gate comes from the host. */
const ModelDraft = z.object({
  kind: z.enum(["command", "ai-acceptance"]),
  id: SafeId,
  description: z.string().min(1).max(2000),
  command: Argv.extend({ cwd: z.string().max(256).optional() }).optional(),
  script: z.object({ path: RelativePath, content: z.string().min(1).max(20000) }).optional(),
  acceptance: z
    .object({
      title: z.string().min(1).max(200),
      steps: z.array(z.string().min(1).max(2000)).min(1).max(30),
      expectations: z.array(z.string().min(1).max(2000)).max(30),
      fromCriteria: z.boolean().optional(),
      start: Argv.extend({
        cwd: z.string().max(256).optional(),
        readyLog: z.string().max(200).optional(),
      }),
      commands: z.array(Argv).max(MAX_ACCEPTANCE_COMMANDS).optional(),
      listenPorts: z.array(z.number().int().min(1024).max(65535)).max(4).optional(),
    })
    .optional(),
});
type ModelDraft = z.infer<typeof ModelDraft>;

const SYSTEM = `You turn a check a person describes in plain words into a BAKED workflow gate. Reply with one JSON object and nothing else.

Pick the kind:
- "command": the check has an exact answer (an exit code, an exact output, a value). Give "command" {executable, args, cwd?} run without a shell; when a small test is needed, also give "script" {path, content}: a Bun TypeScript script under tests/gates/ that runs the program with Bun.spawn, compares its output and exits 1 with a clear message on a mismatch. The command is then bun with the script path.
- "ai-acceptance": the check needs judgement ("looks right", "is helpful", "handles bad input well"). Give "acceptance" {title, steps[], expectations[], start {executable, args, cwd?, readyLog?}, commands?[], listenPorts?[]}: start is the program a reviewer walks through its terminal (its stdin and stdout), commands are one-shot commands run in order, each an argv without a shell; readyLog is text the program prints when it is ready. Set "fromCriteria": true when the check is to walk the acceptance criteria of the feature's spec (the run's manual criteria are then added as expectations); the expectations may then be empty.

Always give "kind", "id" (lowercase letters, digits and dashes) and "description" (one sentence). Use only programs the project shows; never use a shell (sh, bash, cmd, powershell) or pipes, never a browser, never network access.`;

/** The project's top-level names and package.json scripts, so the model picks real commands. */
export function projectBrief(workspace: string): string {
  const names = existsSync(workspace)
    ? readdirSync(workspace, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .slice(0, 60)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    : [];
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    // No package.json, or not JSON.
  }
  return JSON.stringify({ files: names, packageScripts: scripts });
}

/** The first JSON object in a reply, with or without a fenced block around it. */
function parseReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return a gate draft.");
  return JSON.parse(body.slice(start, end + 1));
}

const SHELLS = /^(sh|bash|zsh|fish|cmd|cmd\.exe|powershell|pwsh|powershell\.exe)$/i;

/** Builds a complete gate around what the model wrote, with the host's own defaults. */
export function gateFromDraft(
  draft: ModelDraft,
  request: GateDraftRequest,
): {
  gate: Gate;
  script: DraftScript | null;
} {
  const id = request.id ?? draft.id;
  const common = {
    schemaVersion: 1 as const,
    id,
    description: draft.description,
    timeoutMs: 600000,
    retries: { max: 0, retryOn: [] },
  };
  if (draft.kind === "command") {
    const script = draft.script ?? null;
    const command = script
      ? { executable: "bun", args: [script.path], cwd: "." }
      : (draft.command ?? null);
    if (!command) throw new Error("The draft has neither a command nor a script.");
    return {
      gate: {
        ...common,
        type: "command",
        required: true,
        scope: "feature",
        evidence: { kind: "exit", keepOutputLines: 80, artifactPaths: [] },
        command: {
          executable: command.executable,
          args: command.args,
          cwd: command.cwd && command.cwd !== "." ? command.cwd : ".",
          envNames: [],
          writes: [],
        },
      } as Gate,
      script,
    };
  }
  const a = draft.acceptance;
  if (!a) throw new Error("The draft has no scenario.");
  const fromCriteria = request.fromCriteria === true || a.fromCriteria === true;
  if (!a.expectations.length && !fromCriteria)
    throw new Error("The draft's scenario has no expectation to check.");
  const ports = a.listenPorts ?? [];
  return {
    gate: {
      ...common,
      type: "ai-acceptance",
      required: false,
      scope: "feature",
      evidence: { kind: "recording", keepOutputLines: 80, artifactPaths: [] },
      acceptance: {
        scenario: {
          title: a.title,
          steps: a.steps,
          expectations: a.expectations,
          ...(fromCriteria ? { fromCriteria: "manual" } : {}),
        },
        start: {
          executable: a.start.executable,
          args: a.start.args,
          cwd: a.start.cwd && a.start.cwd !== "." ? a.start.cwd : ".",
          envNames: [],
          readyWhen: a.start.readyLog ? { logIncludes: a.start.readyLog } : {},
        },
        ...(a.commands?.length ? { commands: a.commands } : {}),
        driver: "terminal",
        capabilities: { spawnApp: true, listenPorts: ports, outboundHosts: [], writePaths: [] },
        promote: {
          commandGateId: `${id}-test`.slice(0, 96),
          testPath: `tests/acceptance/${id}.ts`,
          framework: "cli-script",
          stableRuns: 3,
        },
      },
    } as Gate,
    script: null,
  };
}

/** The library's one-line description of a gate that is not in the library yet. */
const describe = (gate: Gate): string =>
  describeGate({ gate, source: "project", hash: "", path: null, shadows: [] });

/** What a gate may do, in words a person can confirm. */
export function gateCapabilities(gate: Gate, script: DraftScript | null): string[] {
  if (gate.type === "command") {
    const run = [gate.command.executable, ...gate.command.args].join(" ");
    return [
      `Runs ${run} in ${gate.command.cwd} without a shell; a non-zero exit blocks the workflow`,
      ...(script ? [`Writes the test script ${script.path} when saved`] : []),
    ];
  }
  if (gate.type !== "ai-acceptance") return [describe(gate)];
  const { start, commands = [], capabilities } = gate.acceptance;
  return [
    `Starts ${[start.executable, ...start.args].join(" ")} in ${start.cwd} and drives its terminal`,
    ...commands.map((c, i) => `Runs command ${i + 1}: ${[c.executable, ...c.args].join(" ")}`),
    capabilities.listenPorts.length
      ? `The program may listen on ports ${capabilities.listenPorts.join(", ")}`
      : "The program may not listen on any port",
    "No network access and no file writes; advisory until a person accepts the test it writes",
  ];
}

/** Why a drafted gate cannot be saved yet. */
export function draftProblems(
  workspace: string,
  gate: Gate,
  script: DraftScript | null,
  library?: GateLibrary,
): string[] {
  const problems: string[] = [];
  const parsed = GateSchema.safeParse(gate);
  if (!parsed.success)
    problems.push(
      ...parsed.error.issues.map((i) => `${i.path.join(".") || "(gate)"}: ${i.message}`),
    );
  else problems.push(...validateGate(parsed.data));
  const argvs =
    gate.type === "command"
      ? [gate.command]
      : gate.type === "ai-acceptance"
        ? [gate.acceptance.start, ...(gate.acceptance.commands ?? [])]
        : [];
  for (const argv of argvs)
    if (SHELLS.test(argv.executable.split(/[\\/]/).at(-1) ?? ""))
      problems.push(`${argv.executable}: a gate runs programs directly, not through a shell`);
  if (existsSync(join(gateDirectories(workspace).project, `${gate.id}.json`)))
    problems.push(`baked/gates/${gate.id}.json already exists; choose another ID`);
  else if (library?.entries.has(gate.id))
    problems.push(`A gate with the ID ${gate.id} already exists`);
  if (script) {
    if (!/^tests\/gates\/[A-Za-z0-9._\-/]+\.(ts|js|mjs)$/.test(script.path))
      problems.push(`${script.path}: the test script goes under tests/gates/`);
    if (existsSync(join(workspace, script.path)))
      problems.push(`${script.path} already exists; nothing is overwritten`);
  }
  return problems;
}

/** Drafts a gate from a sentence; writes nothing. */
export async function draftGate(
  workspace: string,
  request: GateDraftRequest,
  model: DraftModel,
  library?: GateLibrary,
): Promise<GateDraft> {
  const text = request.text.trim();
  if (!text) throw new Error("Describe the check in a sentence.");
  if (request.id !== undefined && !SafeId.safeParse(request.id).success)
    throw new Error(`${request.id} is not a valid gate ID`);
  if (request.fromCriteria && request.kind === "command")
    throw new Error("Only an AI check walks the spec's acceptance criteria.");
  const kind = request.kind ?? (request.fromCriteria ? "ai-acceptance" : undefined);
  const user = [
    `The check: ${text}`,
    kind ? `Use the kind "${kind}".` : "",
    request.fromCriteria
      ? `Set "fromCriteria": true; the run's manual acceptance criteria are added as expectations.`
      : "",
    request.id ? `Use the ID "${request.id}".` : "",
    `The project: ${projectBrief(workspace)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const reply = await model({ system: SYSTEM, user });
  const parsed = ModelDraft.safeParse(parseReply(reply));
  if (!parsed.success)
    throw new Error(
      `The model's draft is not a gate: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  if (kind && parsed.data.kind !== kind)
    throw new Error(`The model drafted a ${parsed.data.kind} gate instead of ${kind}.`);
  const { gate, script } = gateFromDraft(parsed.data, request);
  const problems = draftProblems(workspace, gate, script, library);
  return {
    gate,
    script,
    summary: describe(gate),
    capabilities: gateCapabilities(gate, script),
    problems,
    path: `baked/gates/${gate.id}.json`,
  };
}

/**
 * Saves a draft a person confirmed: the test script (never over an existing file), then the gate
 * file, which is confirmed in the same step because the person just read it.
 */
export function saveGateDraft(
  workspace: string,
  draft: { gate: unknown; script?: DraftScript | null },
  loadLibrary: () => GateLibrary,
): { id: string; path: string; script: string | null } {
  const gate = GateSchema.parse(draft.gate);
  const script = draft.script ?? null;
  const problems = draftProblems(workspace, gate, script);
  if (problems.length) throw new Error(problems.join("; "));
  if (script) {
    const target = join(workspace, script.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, script.content.endsWith("\n") ? script.content : `${script.content}\n`, {
      flag: "wx",
    });
  }
  const directory = gateDirectories(workspace).project;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${gate.id}.json`), `${JSON.stringify(gate, null, 2)}\n`, {
    flag: "wx",
  });
  confirmGates(workspace, loadLibrary(), [gate.id]);
  return { id: gate.id, path: `baked/gates/${gate.id}.json`, script: script?.path ?? null };
}

/** The configured model as a DraftModel: one `generateText` call, recorded with model events. */
export function configuredDraftModel(config: AppConfig, modelId?: string): DraftModel {
  const id = modelId || config.defaultModel;
  return async ({ system, user }) => {
    if (!id || id === "none")
      throw new Error("No model is configured; pick one with --model or /model.");
    const options = await buildProviderOptions(id, config);
    const startedAt = Date.now();
    const result = await generateText({
      model: resolveModel(id),
      ...(supportsTemperature(id) ? { temperature: 0 } : {}),
      maxOutputTokens: 8192,
      ...(Object.keys(options.providerOptions).length
        ? { providerOptions: options.providerOptions }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      system,
      prompt: user,
    });
    recordModelCall({
      modelId: id,
      source: "other",
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      state: "ok",
      input: result.usage.inputTokens ?? 0,
      output: result.usage.outputTokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    return result.text;
  };
}
