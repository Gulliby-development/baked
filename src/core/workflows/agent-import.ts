/**
 * Custom agents a project brought from other tools (Claude Code, GitHub Copilot, OpenCode, Roo Code)
 * and their conversion into a BAKED workflow (#832). Customization in BAKED goes through workflows:
 * these agents are found only so a project that already has them can keep editing them and turn
 * them into a workflow. A project without them shows nothing. Runs never read these files; a
 * conversion copies what it needs into `baked/agents`, `baked/gates` and `baked/workflows`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { builtinProfiles } from "../agents/profiles/builtin.js";
import { withTestIntegrityRules } from "../agents/profiles/test-integrity-rules.js";
import { WorkflowFault } from "./errors.js";
import { type AgentProfile, type RunPolicy, SafeId } from "./schemas.js";
import { type Gate, GateSchema, type WorkflowV2, WorkflowV2Schema } from "./v2/definition.js";
import {
  asV2,
  builtinPresets,
  listDefinitions,
  loadDefinition,
  validateDefinition,
} from "./v2/definitions.js";
import { copyAsCustom, writeDefinitionFile } from "./v2/editor.js";
import { confirmGates, gateDirectories, loadGateLibrary } from "./v2/library.js";

/** Where each tool keeps its agents in a project; the first label names the tool. */
const MARKDOWN_SOURCES: { source: AgentSource; dir: string; suffix: string }[] = [
  { source: "claude", dir: ".claude/agents", suffix: ".md" },
  { source: "copilot", dir: ".github/agents", suffix: ".agent.md" },
  { source: "copilot", dir: ".github/chatmodes", suffix: ".chatmode.md" },
  { source: "opencode", dir: ".opencode/agent", suffix: ".md" },
  { source: "opencode", dir: ".opencode/agents", suffix: ".md" },
];
const ROO_FILE = ".roomodes";

export type AgentSource = "claude" | "copilot" | "opencode" | "roo";
export const SOURCE_LABELS: Record<AgentSource, string> = {
  claude: "Claude Code",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  roo: "Roo Code",
};

/** The workflow stage an agent fills once converted; `skip` leaves it out. */
export const AGENT_STAGES = ["research", "specify", "plan", "implement", "review", "skip"] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

export interface FoundAgent {
  /** Stable key: the file path, plus `#slug` for a Roo mode. */
  key: string;
  name: string;
  source: AgentSource;
  sourceLabel: string;
  /** Path relative to the project, with `/` separators. */
  path: string;
  description: string;
  instructions: string;
  /** Tool names as the agent's file lists them; empty when it lists none. */
  tools: string[];
  model: string | null;
  /** The stage BAKED suggests for it, from its name, description and tools. */
  stage: AgentStage;
  /** An agent that hands work to other agents: its role becomes the workflow itself. */
  orchestrator: boolean;
  /** Whether BAKED can remove it (a whole file); a Roo mode is removed by editing `.roomodes`. */
  removable: boolean;
  /** The whole file as text and its SHA-256, for editing. */
  content: string;
  hash: string;
}

export interface AgentList {
  agents: FoundAgent[];
  /** Files that look like agents but could not be read, with why. */
  problems: string[];
}

const MAX_FILE_BYTES = 64 * 1024;
const PRESENCE_TTL_MS = 5000;
/** Whether a project has agents, per workspace, for `hasProjectAgents`. */
const presence = new Map<string, { at: number; value: boolean }>();
const MAX_TEXT = 16000;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const posix = (path: string): string => path.split(sep).join("/");

/** Every custom agent in the project's own folders, sorted by path. Reading writes nothing. */
export function listAgents(workspace: string): AgentList {
  const agents: FoundAgent[] = [];
  const problems: string[] = [];
  for (const { source, dir, suffix } of MARKDOWN_SOURCES) {
    const folder = join(workspace, dir);
    if (!isDirectory(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith(suffix)) continue;
      const path = join(folder, name);
      try {
        const text = readSmall(path);
        agents.push(markdownAgent(workspace, path, source, name.slice(0, -suffix.length), text));
      } catch (error) {
        problems.push(`${posix(relative(workspace, path))}: ${message(error)}`);
      }
    }
  }
  const roo = join(workspace, ROO_FILE);
  if (existsSync(roo)) {
    try {
      agents.push(...rooAgents(workspace, roo, readSmall(roo)));
    } catch (error) {
      problems.push(`${ROO_FILE}: ${message(error)}`);
    }
  }
  return { agents: agents.sort((a, b) => a.key.localeCompare(b.key)), problems };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readSmall(path: string): string {
  if (statSync(path).size > MAX_FILE_BYTES) throw new Error("larger than 64 KB");
  return readFileSync(path, "utf8").replace(/^﻿/, "");
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Splits YAML frontmatter from a Markdown body. A file without frontmatter is all body. */
export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const parsed = Bun.YAML.parse(match[1] ?? "");
  const meta =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { meta, body: text.slice(match[0].length).trim() };
}

/** A frontmatter list as strings: `[a, b]`, a YAML list, `a, b`, or a `{name: true}` map. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, on]) => on !== false)
      .map(([name]) => name);
  return [];
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function markdownAgent(
  workspace: string,
  path: string,
  source: AgentSource,
  fileName: string,
  content: string,
): FoundAgent {
  const { meta, body } = splitFrontmatter(content);
  const name = text(meta.name) || fileName;
  const description = text(meta.description) || firstLine(body);
  const tools = stringList(meta.tools);
  const handoffs = Array.isArray(meta.handoffs) && meta.handoffs.length > 0;
  return agent({
    key: posix(relative(workspace, path)),
    name,
    source,
    path: posix(relative(workspace, path)),
    description,
    instructions: body,
    tools,
    model: text(meta.model) || null,
    orchestrator: handoffs || meta.mode === "primary",
    removable: true,
    content,
  });
}

/** Roo Code (and Kilo Code) modes: `customModes` in JSON or YAML. */
function rooAgents(workspace: string, path: string, content: string): FoundAgent[] {
  const parsed = (
    content.trimStart().startsWith("{") ? JSON.parse(content) : Bun.YAML.parse(content)
  ) as {
    customModes?: unknown;
  } | null;
  const modes = Array.isArray(parsed?.customModes) ? parsed.customModes : [];
  return modes.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const mode = raw as Record<string, unknown>;
    const slug = text(mode.slug);
    if (!slug) return [];
    const instructions = [text(mode.roleDefinition), text(mode.customInstructions)]
      .filter(Boolean)
      .join("\n\n");
    const groups = stringList(
      Array.isArray(mode.groups) ? mode.groups.map((g) => (Array.isArray(g) ? g[0] : g)) : [],
    );
    return [
      agent({
        key: `${ROO_FILE}#${slug}`,
        name: slug,
        source: "roo",
        path: posix(relative(workspace, path)),
        description: text(mode.whenToUse) || text(mode.description) || text(mode.name) || slug,
        instructions,
        tools: groups,
        model: null,
        orchestrator: /orchestrat|boomerang/i.test(`${slug} ${text(mode.name)}`),
        removable: false,
        content,
      }),
    ];
  });
}

function agent(
  fields: Omit<FoundAgent, "sourceLabel" | "stage" | "hash"> & { content: string },
): FoundAgent {
  const found = {
    ...fields,
    sourceLabel: SOURCE_LABELS[fields.source],
    hash: sha256(fields.content),
    stage: "implement" as AgentStage,
  };
  return { ...found, stage: suggestStage(found) };
}

const firstLine = (body: string): string =>
  body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean) ?? "";

const WRITE_TOOLS =
  /^(edit|write|multiedit|multi_edit|notebookedit|bash|shell|command|editfiles|runcommands|edit_file)$/i;

/** The stage an agent most likely fills, from the words of its name and description and its tools. */
export function suggestStage(
  agent: Pick<FoundAgent, "name" | "description" | "tools" | "orchestrator">,
): AgentStage {
  if (agent.orchestrator) return "skip";
  const words = `${agent.name} ${agent.description}`.toLowerCase();
  if (/review|audit|security|critic|lint|qa\b|inspect/.test(words)) return "review";
  if (/research|explor|investigat|analy[sz]|search|scout|discover/.test(words)) return "research";
  if (/\bspec|requirement|product manager|\bpm\b|story|acceptance/.test(words)) return "specify";
  if (/plan|architect|design|break ?down|decompos/.test(words)) return "plan";
  const readOnly = agent.tools.length > 0 && !agent.tools.some((t) => WRITE_TOOLS.test(t));
  return readOnly ? "research" : "implement";
}

// ---------------------------------------------------------------------------------------------
// Editing and removing

export type AgentWrite =
  | { status: "written"; agent: FoundAgent | null }
  | { status: "unknown" | "changed"; message: string };

/** Replaces an agent's file when it still has `expectedHash`. A Roo mode edits all of `.roomodes`. */
export function writeAgentFile(
  workspace: string,
  key: string,
  content: string,
  expectedHash: string,
): AgentWrite {
  const found = listAgents(workspace).agents.find((a) => a.key === key);
  if (!found) return { status: "unknown", message: `No agent ${key} in this project` };
  if (found.hash !== expectedHash)
    return { status: "changed", message: `${found.path} changed on disk; reload and edit again` };
  writeFileSync(insideWorkspace(workspace, found.path), content);
  return {
    status: "written",
    agent: listAgents(workspace).agents.find((a) => a.key === key) ?? null,
  };
}

/** Deletes an agent's file. A Roo mode is refused: other modes share `.roomodes`. */
export function removeAgentFile(workspace: string, key: string, expectedHash?: string): AgentWrite {
  presence.delete(workspace);
  const found = listAgents(workspace).agents.find((a) => a.key === key);
  if (!found) return { status: "unknown", message: `No agent ${key} in this project` };
  if (!found.removable)
    return {
      status: "changed",
      message: `${found.name} is one mode of ${found.path}; remove it there`,
    };
  if (expectedHash && found.hash !== expectedHash)
    return { status: "changed", message: `${found.path} changed on disk; reload first` };
  unlinkSync(insideWorkspace(workspace, found.path));
  return { status: "written", agent: null };
}

function insideWorkspace(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new WorkflowFault("CAPABILITY_DENIED", "Path escapes");
  return target;
}

// ---------------------------------------------------------------------------------------------
// Conversion

export interface ConvertRequest {
  /** The new workflow's ID; `baked/workflows/ID.json` must not exist. */
  workflowId: string;
  /** The definition it starts from; `standard` by default. */
  from?: string;
  /** The agents to use and the stage each fills; an agent left out or set to `skip` is not used. */
  agents: { key: string; stage: AgentStage }[];
  /** Delete the converted agents' files after the workflow is written. */
  removeOriginals?: boolean;
}

export interface ConvertResult {
  workflowId: string;
  path: string;
  from: string;
  profiles: { id: string; path: string; stage: AgentStage; agent: string }[];
  gates: { id: string; path: string; agent: string }[];
  removed: string[];
  /** Agents left in place, with why (a Roo mode, a file changed meanwhile). */
  kept: { key: string; reason: string }[];
  notes: string[];
  /** Validation problems of the written workflow, for the editor to fix. */
  problems: string[];
}

/** The built-in profile each stage's agents build on, and the contract its stage produces. */
const STAGE_BASE: Record<
  Exclude<AgentStage, "review" | "skip">,
  { profile: string; produces: string }
> = {
  research: { profile: "researcher", produces: "research" },
  specify: { profile: "spec-author", produces: "spec" },
  plan: { profile: "planner", produces: "plan" },
  implement: { profile: "implementer", produces: "implementation" },
};

const GUIDANCE = (agent: FoundAgent) =>
  `\n\nProject guidance from the agent "${agent.name}" (${agent.path}, made for ${agent.sourceLabel}). ` +
  "Follow it where it does not conflict with the instructions above; the result format above always wins:\n";

/** The text that fits after `prefix` in a 16,000-character field, and whether it was cut. */
function fit(prefix: string, body: string): { value: string; cut: boolean } {
  const room = MAX_TEXT - prefix.length;
  if (body.length <= room) return { value: prefix + body, cut: false };
  return { value: `${prefix + body.slice(0, Math.max(0, room - 1)).trimEnd()}…`, cut: true };
}

/** A safe ID from an agent's name, kept clear of `taken` (built-in profile and gate IDs). */
export function agentId(name: string, taken: ReadonlySet<string>, suffix = ""): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 80) || "agent";
  let id = `${base}${suffix}`;
  for (let n = 2; taken.has(id); n++) id = `${base}${suffix}-${n}`;
  return SafeId.parse(id);
}

/** A workflow profile from an agent: the stage's built-in profile with the agent's prompt added. */
export function agentProfile(
  agent: FoundAgent,
  stage: Exclude<AgentStage, "review" | "skip">,
  id: string,
): { profile: AgentProfile; cut: boolean } {
  const base = withTestIntegrityRules(builtinProfiles).find(
    (p) => p.id === STAGE_BASE[stage].profile,
  );
  if (!base) throw new WorkflowFault("NOT_FOUND", `No built-in profile for ${stage}`);
  const instructions = fit(base.instructions + GUIDANCE(agent), agent.instructions);
  return {
    profile: {
      ...base,
      id,
      version: "1.0.0",
      description: (agent.description || agent.name).slice(0, 200),
      instructions: instructions.value,
    },
    cut: instructions.cut,
  };
}

/** An AI review gate from a reviewer agent: the built-in reviewer, with the agent's prompt as focus. */
export function agentReviewGate(
  agent: FoundAgent,
  id: string,
  policy: RunPolicy,
): {
  gate: Gate;
  cut: boolean;
} {
  const focus = fit(
    `Review with the focus of the agent "${agent.name}" (${agent.path}, made for ${agent.sourceLabel}):\n`,
    agent.instructions || agent.description,
  );
  return {
    gate: GateSchema.parse({
      schemaVersion: 1,
      id,
      description: (agent.description || `Review by ${agent.name}`).slice(0, 200),
      required: true,
      scope: "feature",
      timeoutMs: 900000,
      retries: { max: 0, retryOn: [] },
      evidence: { kind: "review", keepOutputLines: 40, artifactPaths: [] },
      type: "ai-review",
      review: {
        profileId: policy.reviewProfiles.correctness,
        dimension: "custom",
        instructions: focus.value,
        blockingSeverities: ["critical", "high"],
        skepticProfileId: policy.skepticProfileId,
        appliesWhen: "always",
      },
    }),
    cut: focus.cut,
  };
}

/**
 * Writes a workflow made from the project's agents: a profile per research, specify, plan and
 * implement agent in `baked/agents`, an AI review gate per review agent in `baked/gates`
 * (confirmed, since the person converting chose it) and a custom copy of `from` that uses them.
 * Nothing is written when any check fails. `removeOriginals` then deletes the converted files.
 */
export function convertAgents(
  workspace: string,
  policy: RunPolicy,
  request: ConvertRequest,
): ConvertResult {
  const workflowId = SafeId.parse(request.workflowId);
  const from = request.from ?? "standard";
  const workflowPath = join(workspace, "baked", "workflows", `${workflowId}.json`);
  if (existsSync(workflowPath))
    throw new WorkflowFault("INVALID_DEFINITION", `Workflow ${workflowId} already exists`);
  const { agents } = listAgents(workspace);
  const chosen = request.agents
    .filter((a) => a.stage !== "skip")
    .map((choice) => {
      const found = agents.find((a) => a.key === choice.key);
      if (!found) throw new WorkflowFault("NOT_FOUND", `No agent ${choice.key} in this project`);
      return { agent: found, stage: choice.stage as Exclude<AgentStage, "skip"> };
    });
  if (!chosen.length)
    throw new WorkflowFault("INVALID_DEFINITION", "Choose at least one agent and its stage");
  for (const single of ["research", "specify", "plan", "implement"] as const) {
    const named = chosen.filter((c) => c.stage === single).map((c) => c.agent.name);
    if (named.length > 1)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `One agent per ${single} stage; ${named.join(" and ")} both chose it`,
      );
  }

  const source = asV2(loadDefinition(workspace, from, policy), policy);
  const definition: WorkflowV2 = copyAsCustom(source, workflowId);
  const notes: string[] = [];
  const library = loadGateLibrary(workspace, policy);
  const agentsDir = join(workspace, "baked", "agents");
  const takenProfiles = new Set<string>([
    ...builtinProfiles.map((p) => p.id),
    ...(isDirectory(agentsDir)
      ? readdirSync(agentsDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => basename(f, ".json"))
      : []),
  ]);
  const takenGates = new Set<string>(library.entries.keys());
  const profiles: { profile: AgentProfile; stage: AgentStage; agent: FoundAgent }[] = [];
  const gates: { gate: Gate; agent: FoundAgent }[] = [];
  let stages = definition.stages;

  for (const { agent: found, stage } of chosen) {
    if (stage === "review") {
      const id = agentId(found.name, takenGates, found.name.endsWith("review") ? "" : "-review");
      takenGates.add(id);
      const { gate, cut } = agentReviewGate(found, id, policy);
      if (cut) notes.push(`${found.name}: the prompt was cut to fit a gate's 16,000 characters`);
      gates.push({ gate, agent: found });
      const reviews = stages.filter((s) => s.type === "review");
      if (!reviews.length)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `${from} has no review stage for ${found.name}`,
        );
      stages = stages.map((s) =>
        s.type === "review" ? { ...s, gates: [...s.gates, { gateId: id }] } : s,
      );
      continue;
    }
    const id = agentId(found.name, takenProfiles);
    takenProfiles.add(id);
    const { profile, cut } = agentProfile(found, stage, id);
    if (cut) notes.push(`${found.name}: the prompt was cut to fit a profile's 16,000 characters`);
    profiles.push({ profile, stage, agent: found });
    if (stage === "implement") {
      if (!stages.some((s) => s.type === "tasks"))
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `${from} has no tasks stage for ${found.name}`,
        );
      stages = stages.map((s) => (s.type === "tasks" ? { ...s, profileId: id } : s));
      if (found.tools.length && !found.tools.some((t) => WRITE_TOOLS.test(t)))
        notes.push(`${found.name} lists no editing tool; as an implementer it can edit files`);
      continue;
    }
    const produces = STAGE_BASE[stage].produces;
    const target = stages.filter((s) => s.type === "agent" && s.produces === produces);
    if (!target.length)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `${from} has no ${stage} stage for ${found.name}`,
      );
    stages = stages.map((s) =>
      s.type === "agent" && s.produces === produces ? { ...s, profileId: id } : s,
    );
  }
  for (const { agent: found } of chosen)
    if (found.model)
      notes.push(
        `${found.name} asked for model ${found.model}; workflow models come from model routing`,
      );

  // Without feature checks a preset's check stage has no gate; the copy keeps the preset's
  // example gates so it parses, and validation names them for the person to replace.
  const shipped = builtinPresets.get(from);
  stages = stages.map((s) => {
    if ((s.type !== "check" && s.type !== "wait") || s.gates.length) return s;
    const example = shipped?.stages.find((p) => p.id === s.id);
    return example && "gates" in example ? { ...s, gates: example.gates } : s;
  });
  const workflow = WorkflowV2Schema.parse({
    ...definition,
    description:
      `${definition.description} Made from ${chosen.length} project agent${chosen.length === 1 ? "" : "s"}.`.slice(
        0,
        16000,
      ),
    stages,
  });
  // Validate against a library that already holds the new gates, before writing anything.
  const gateDir = gateDirectories(workspace).project;
  for (const { gate } of gates)
    if (existsSync(join(gateDir, `${gate.id}.json`)))
      throw new WorkflowFault("INVALID_DEFINITION", `Gate ${gate.id} already exists`);
  const preview = new Map(library.gates);
  for (const { gate } of gates) preview.set(gate.id, gate);
  // A problem of the base itself (a check stage without the project's checks) does not block
  // the copy: the editor shows it and the person fixes it there, as for any custom workflow.
  const problems = validateDefinition(workflow, { ...library, gates: preview });

  const writtenProfiles = profiles.map(({ profile, stage, agent: found }) => {
    const path = join(agentsDir, `${profile.id}.json`);
    writeJson(path, profile);
    return { id: profile.id, path, stage, agent: found.key };
  });
  const writtenGates = gates.map(({ gate, agent: found }) => {
    const path = join(gateDir, `${gate.id}.json`);
    writeJson(path, gate);
    return { id: gate.id, path, agent: found.key };
  });
  if (writtenGates.length)
    confirmGates(
      workspace,
      loadGateLibrary(workspace, policy),
      writtenGates.map((g) => g.id),
    );
  const path = writeDefinitionFile(workspace, workflow);

  const removed: string[] = [];
  const kept: { key: string; reason: string }[] = [];
  if (request.removeOriginals)
    for (const { agent: found } of chosen) {
      const outcome = removeAgentFile(workspace, found.key, found.hash);
      if (outcome.status === "written") removed.push(found.key);
      else kept.push({ key: found.key, reason: outcome.message });
    }
  return {
    workflowId,
    path,
    from,
    profiles: writtenProfiles,
    gates: writtenGates,
    removed,
    kept,
    notes,
    problems,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The definitions a conversion can start from: those with a tasks stage, `standard` first. */
export function conversionBases(workspace: string, policy: RunPolicy): string[] {
  const ids = listDefinitions(workspace, policy)
    .filter((d) => d.schemaVersion === 2 && d.line.stages.some((s) => s.type === "tasks"))
    .map((d) => d.id);
  return ["standard", ...ids.filter((id) => id !== "standard")].filter((id) => ids.includes(id));
}

// ---------------------------------------------------------------------------------------------
// Front-end helpers

/**
 * Whether the project has any custom agent, cached for a few seconds: the TUI asks on every
 * palette render to show `/agents` only in projects that have agents.
 */
export function hasProjectAgents(workspace: string): boolean {
  const cached = presence.get(workspace);
  if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) return cached.value;
  let value = false;
  try {
    value = listAgents(workspace).agents.length > 0;
  } catch {
    value = false;
  }
  presence.set(workspace, { at: Date.now(), value });
  return value;
}

/** Forgets the cached presence, after a conversion or removal. */
export function forgetAgentPresence(workspace: string): void {
  presence.delete(workspace);
}

/** A free workflow ID for a conversion: `base`, then `base-2` and so on. */
export function freeWorkflowId(workspace: string, base = "agents"): string {
  let id = base;
  for (let n = 2; existsSync(join(workspace, "baked", "workflows", `${id}.json`)); n++)
    id = `${base}-${n}`;
  return id;
}

/** How a person reads each stage. */
export const STAGE_LABELS: Record<AgentStage, string> = {
  research: "Research",
  specify: "Specify",
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  skip: "Not used",
};

/** The tools the agents come from, in words: "Claude Code" or "Claude Code and Roo Code". */
export function agentOrigins(agents: readonly FoundAgent[]): string {
  const labels = [...new Set(agents.map((a) => a.sourceLabel))];
  return labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** The outcome of a conversion as lines for the TUI and the CLI. */
export function describeConversion(result: ConvertResult): string[] {
  const used = result.profiles.length + result.gates.length;
  const lines = [
    `Made workflow ${result.workflowId} from ${used} agent${used === 1 ? "" : "s"} (based on ${result.from}): ${result.path}`,
    ...result.profiles.map((p) => `  ${STAGE_LABELS[p.stage]}: profile ${p.id} from ${p.agent}`),
    ...result.gates.map((g) => `  Review: gate ${g.id} from ${g.agent}`),
  ];
  if (result.removed.length)
    lines.push(
      `Removed ${result.removed.length} agent file${result.removed.length === 1 ? "" : "s"}: ${result.removed.join(", ")}`,
    );
  for (const k of result.kept) lines.push(`Kept ${k.key}: ${k.reason}`);
  for (const note of result.notes) lines.push(`Note: ${note}`);
  if (result.problems.length)
    lines.push(`Fix in the editor before a run: ${result.problems.join("; ")}`);
  return lines;
}
