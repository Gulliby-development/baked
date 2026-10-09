import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../../platform/index.js";
import { hashJson } from "../../specs/hash.js";
import type { RunPolicy } from "../schemas.js";
import type { Check } from "../types.js";
import {
  type CommandGateDefinition,
  effectiveMode,
  type Gate,
  type GateBinding,
  GateSchema,
  validateGate,
} from "./definition.js";
import { reviewGateId } from "./upgrade.js";

/** Where a gate definition came from, lowest precedence first. */
export type GateSource = "builtin" | "policy" | "user" | "project";
export interface LibraryEntry {
  gate: Gate;
  source: GateSource;
  hash: string;
  path: string | null;
  /** Definitions with the same ID from lower-precedence sources that this one replaces. */
  shadows: { source: GateSource; hash: string; path: string | null }[];
}
export interface GateLibrary {
  entries: Map<string, LibraryEntry>;
  gates: Map<string, Gate>;
  /** Files that could not be read as gates, with the reason. They are never used. */
  problems: string[];
}

const exitEvidence = (): CommandGateDefinition["evidence"] => ({
  kind: "exit",
  keepOutputLines: 40,
  artifactPaths: [],
});

/** A v1 policy check read as a command gate with the same ID. */
export function checkToGate(check: Check): CommandGateDefinition {
  return {
    schemaVersion: 1,
    id: check.id,
    description: "Command check from the workflow policy.",
    required: check.required,
    scope: check.scope,
    timeoutMs: check.timeoutMs,
    retries: { max: 0, retryOn: [] },
    evidence: exitEvidence(),
    type: "command",
    command: {
      executable: check.executable,
      args: check.args,
      cwd: check.cwd,
      envNames: check.envNames,
      writes: check.writes,
    },
  };
}

/** The check the v1 check runner executes for a command gate bound with a given mode. */
export function gateToCheck(gate: CommandGateDefinition, binding?: GateBinding): Check {
  return {
    id: gate.id,
    executable: gate.command.executable,
    args: gate.command.args,
    cwd: gate.command.cwd,
    timeoutMs: gate.timeoutMs,
    required: effectiveMode(binding ?? { gateId: gate.id }, gate) === "required",
    scope: gate.scope === "task" ? "task" : "feature",
    envNames: gate.command.envNames,
    writes: gate.command.writes,
  };
}

/** The review dimensions of the v1 policy as AI review gates; the v1 review stage runs exactly these. */
export function builtinReviewGates(policy: RunPolicy): Gate[] {
  const gate = (
    dimension: "correctness" | "security" | "language",
    profileId: string,
    appliesWhen: "always" | "security-sensitive",
  ): Gate => ({
    schemaVersion: 1,
    id: reviewGateId(dimension),
    description: `A ${dimension} reviewer in a fresh context.`,
    required: true,
    scope: "feature",
    timeoutMs: 900000,
    retries: { max: 0, retryOn: [] },
    evidence: { kind: "review", keepOutputLines: 40, artifactPaths: [] },
    type: "ai-review",
    review: {
      profileId,
      dimension,
      // The v1 review stage repairs every finding the skeptic does not refute.
      blockingSeverities: ["critical", "high", "medium", "low"],
      skepticProfileId: policy.skepticProfileId,
      appliesWhen,
    },
  });
  return [
    gate("correctness", policy.reviewProfiles.correctness, "always"),
    gate(
      "security",
      policy.reviewProfiles.security,
      policy.forceSecurityReview ? "always" : "security-sensitive",
    ),
    ...(policy.reviewProfiles.language
      ? [gate("language", policy.reviewProfiles.language, "always")]
      : []),
  ];
}

/** Gate directories: the user's (`~/.baked/gates`) and the project's (`baked/gates`). */
export function gateDirectories(workspace: string): { user: string; project: string } {
  return { user: join(configDir(), "gates"), project: join(workspace, "baked", "gates") };
}

function readDirectory(directory: string, problems: string[]): { gate: Gate; path: string }[] {
  if (!existsSync(directory)) return [];
  const found: { gate: Gate; path: string }[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    try {
      const gate = GateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (`${gate.id}.json` !== name) throw new Error(`the file name must be ${gate.id}.json`);
      const errors = validateGate(gate);
      if (errors.length) throw new Error(errors.join("; "));
      found.push({ gate, path });
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return found;
}

/**
 * Resolves the gate library of a workspace: built-in review gates, then the policy's command
 * checks, then the user's gates, then the project's. A later source replaces an earlier one with
 * the same ID and records what it shadows, so the caller can show both definitions. Reading the
 * library runs nothing.
 */
export function loadGateLibrary(
  workspace: string,
  policy: RunPolicy,
  directories = gateDirectories(workspace),
): GateLibrary {
  const entries = new Map<string, LibraryEntry>();
  const problems: string[] = [];
  const add = (gate: Gate, source: GateSource, path: string | null): void => {
    const previous = entries.get(gate.id);
    const hash = hashJson(gate);
    entries.set(gate.id, {
      gate,
      source,
      hash,
      path,
      shadows: previous
        ? [
            ...previous.shadows,
            { source: previous.source, hash: previous.hash, path: previous.path },
          ]
        : [],
    });
  };
  for (const gate of builtinReviewGates(policy)) add(gate, "builtin", null);
  for (const check of policy.checks) add(checkToGate(check), "policy", null);
  for (const { gate, path } of readDirectory(directories.user, problems)) add(gate, "user", path);
  for (const { gate, path } of readDirectory(directories.project, problems))
    add(gate, "project", path);
  return {
    entries,
    gates: new Map([...entries].map(([id, entry]) => [id, entry.gate])),
    problems,
  };
}

/** Where a workspace keeps the hashes of the project gates its user confirmed; local, never shared. */
export const confirmationPath = (workspace: string): string =>
  join(workspace, ".baked", "gate-confirmations.json");

export function readConfirmations(workspace: string): Record<string, string> {
  const path = confirmationPath(workspace);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { gates?: Record<string, string> };
    return parsed.gates && typeof parsed.gates === "object" ? parsed.gates : {};
  } catch {
    return {};
  }
}

/**
 * Project gates that need the user's confirmation before a run uses them: every gate from
 * `baked/gates` whose current definition the user has not confirmed in this workspace. A cloned
 * project's commands therefore run only after someone here reviewed them, and a project gate that
 * shadows a built-in, policy or user gate of the same ID is never used silently.
 */
export function unconfirmedGates(
  workspace: string,
  library: GateLibrary,
  ids: readonly string[],
): LibraryEntry[] {
  const confirmed = readConfirmations(workspace);
  return ids
    .map((id) => library.entries.get(id))
    .filter((entry): entry is LibraryEntry => entry !== undefined)
    .filter((entry) => entry.source === "project" && confirmed[entry.gate.id] !== entry.hash);
}

/** Records the user's confirmation of the current definitions of the given project gates. */
export function confirmGates(
  workspace: string,
  library: GateLibrary,
  ids: readonly string[],
): { id: string; hash: string }[] {
  const confirmed = readConfirmations(workspace);
  const done: { id: string; hash: string }[] = [];
  for (const id of ids) {
    const entry = library.entries.get(id);
    if (!entry) throw new Error(`Unknown gate ${id}`);
    if (entry.source !== "project") continue;
    confirmed[id] = entry.hash;
    done.push({ id, hash: entry.hash });
  }
  const path = confirmationPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, gates: confirmed }, null, 2)}\n`);
  renameSync(temp, path);
  return done;
}

/** One line per gate for a confirmation prompt: what it runs and what it replaces. */
export function describeGate(entry: LibraryEntry): string {
  const gate = entry.gate;
  const body =
    gate.type === "command"
      ? `runs ${[gate.command.executable, ...gate.command.args].join(" ")} in ${gate.command.cwd}`
      : gate.type === "human"
        ? "asks a person"
        : gate.type === "ai-review"
          ? `AI review by ${gate.review.profileId}`
          : "AI walk-through";
  const shadows = entry.shadows.length
    ? `; replaces the ${entry.shadows.map((s) => s.source).join(", ")} gate of the same ID`
    : "";
  return `${gate.id}: ${body}${shadows}`;
}
