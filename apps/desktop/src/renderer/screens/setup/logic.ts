import type {
  Check,
  ConfigFile,
  ConfigView,
  Effort,
  GateEntry,
  InstructionFile,
  ModelRouting,
  Route,
  WorkingSetView,
} from "../../client/setup.js";

/** The working set budget of `renderWorkingSet` in src/core/projects/working-set.ts. */
export const WORKING_SET_MAX_BYTES = 64 * 1024;
export const WORKING_SET_FILE_MAX_BYTES = 16 * 1024;

export type FileFit = "included" | "too-large" | "over-budget";

/**
 * Which files of a working set reach agents with their contents, in the order the core renders
 * them: a file over the per-file limit, or one that would exceed the total, is listed by name only.
 */
export function workingSetBudget(
  files: WorkingSetView["files"],
  maxBytes = WORKING_SET_MAX_BYTES,
  fileMaxBytes = WORKING_SET_FILE_MAX_BYTES,
): { used: number; total: number; fit: FileFit[] } {
  let used = 0;
  let total = 0;
  const fit = files.map((file): FileFit => {
    total += file.bytes;
    if (file.bytes > fileMaxBytes) return "too-large";
    if (used + file.bytes > maxBytes) return "over-budget";
    used += file.bytes;
    return "included";
  });
  return { used, total, fit };
}

export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const value = bytes / 1024;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} KB`;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Splits a command line into words, honoring single and double quotes. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else word += char;
  }
  if (started || word) words.push(word);
  return words;
}

export function joinCommand(executable: string, args: string[]): string {
  return [executable, ...args]
    .map((word) => (word === "" || /[\s"']/.test(word) ? `"${word.replaceAll('"', '\\"')}"` : word))
    .join(" ");
}

/** Names typed as a list: commas, spaces or new lines. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Where a gate is defined, in the words of the Gates screen. */
export function gateOrigin(gate: GateEntry, config: ConfigView | null): string {
  switch (gate.source) {
    case "builtin":
      return "built in";
    case "project":
      return "shared";
    case "user":
      return "all projects";
    case "policy":
      return checkScope(gate.id, config) === "global" ? "all projects" : "this checkout";
  }
}

/** Which config file holds the policy check with this ID; null when it comes from the defaults. */
export function checkScope(id: string, config: ConfigView | null): "project" | "global" | null {
  if (!config) return null;
  if (config.project.workflows?.policy?.checks?.some((c) => c.id === id)) return "project";
  if (config.global.workflows?.policy?.checks?.some((c) => c.id === id)) return "global";
  return null;
}

/** The checks runs use, as the merged config holds them. */
export function effectiveChecks(config: ConfigView | null): Check[] {
  return config?.effective.workflows?.policy?.checks ?? [];
}

/**
 * The `workflows` value to write to the project config so its policy has `checks`. The project
 * file replaces the whole policy of the global one, so the rest of the effective policy is kept.
 * Null when workflows are not configured at all: there is no policy to put checks into.
 */
export function workflowsWithChecks(config: ConfigView, checks: Check[]): ConfigFile["workflows"] {
  const effective = config.effective.workflows;
  if (!effective?.policy) return undefined;
  const own = config.project.workflows ?? {};
  return {
    ...own,
    policy: { ...effective.policy, ...(own.policy ?? {}), checks },
  };
}

export function upsertCheck(checks: Check[], check: Check, previousId: string | null): Check[] {
  const at = checks.findIndex((c) => c.id === (previousId ?? check.id));
  if (at === -1) return [...checks, check];
  return checks.map((c, i) => (i === at ? check : c));
}

export interface ClassRow {
  name: string;
  model: string | null;
  effort: Effort;
  fallback: string[];
  usedBy: string[];
  /** True for classes BAKED knows without configuration. */
  builtin: boolean;
}

const BUILTIN_CLASSES = ["active", "fast", "coding", "review"] as const;

function routeParts(route: Route): { model: string; effort: Effort; fallback: string[] } {
  return typeof route === "string"
    ? { model: route, effort: "default", fallback: [] }
    : { model: route.model, effort: route.effort ?? "default", fallback: route.fallback ?? [] };
}

/** The model classes of the routing, built-in ones first, with the roles and profiles using each. */
export function classRows(routing: ModelRouting | undefined): ClassRow[] {
  const classes = routing?.classes ?? {};
  const names = [
    ...BUILTIN_CLASSES,
    ...Object.keys(classes)
      .filter((n) => !isBuiltin(n))
      .sort(),
  ];
  const users = new Map<string, string[]>();
  const note = (route: Route, who: string): void => {
    const { model } = routeParts(route);
    if (!model.startsWith("$")) return;
    const list = users.get(model.slice(1)) ?? [];
    list.push(who);
    users.set(model.slice(1), list);
  };
  for (const [role, route] of Object.entries(routing?.roles ?? {})) note(route, role);
  for (const [profile, route] of Object.entries(routing?.profiles ?? {})) note(route, profile);
  for (const [workflow, entry] of Object.entries(routing?.workflows ?? {}))
    for (const [stage, route] of Object.entries(entry.stages ?? {}))
      note(route, `${workflow} ${stage}`);
  return names.map((name) => {
    const route = classes[name];
    const parts = route ? routeParts(route) : null;
    return {
      name,
      model: parts?.model ?? null,
      effort: parts?.effort ?? "default",
      fallback: parts?.fallback ?? [],
      usedBy: users.get(name) ?? [],
      builtin: isBuiltin(name),
    };
  });
}

function isBuiltin(name: string): boolean {
  return (BUILTIN_CLASSES as readonly string[]).includes(name);
}

/** A class route as config stores it: a bare model when it has no effort or fallback. */
export function classRoute(model: string, effort: Effort, fallback: string[]): Route {
  if (effort === "default" && fallback.length === 0) return model;
  return {
    model,
    ...(effort === "default" ? {} : { effort }),
    ...(fallback.length ? { fallback } : {}),
  };
}

/** The family part of a `provider/model` ID, used to tell whether two models are independent. */
export function modelName(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

/** Where an instruction file comes from, as the Instructions screen says it. */
export function instructionOrigin(file: InstructionFile): string {
  if (file.scope === "global") return "home folder · every project";
  if (file.source === "project") return "listed in baked/project.json";
  return file.path.includes("/") ? "in this checkout" : "repository root";
}

/** The edit form of a check, as typed. */
export interface CheckDraft {
  id: string;
  command: string;
  cwd: string;
  timeoutSeconds: string;
  required: boolean;
  scope: "task" | "feature";
  envNames: string;
  writes: string;
}

export function checkDraft(check: Check | null): CheckDraft {
  return {
    id: check?.id ?? "",
    command: check ? joinCommand(check.executable, check.args) : "",
    cwd: check?.cwd ?? ".",
    timeoutSeconds: String(Math.round((check?.timeoutMs ?? 300_000) / 1000)),
    required: check?.required ?? true,
    scope: check?.scope ?? "feature",
    envNames: check?.envNames.join(", ") ?? "",
    writes: check?.writes.join(", ") ?? "",
  };
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const isRelativeInside = (path: string): boolean =>
  !/^([a-zA-Z]:|[\\/])/.test(path) && !path.split(/[\\/]/).includes("..");

/** The check a draft describes, or what is wrong with it; mirrors `CheckSchema` of the core. */
export function draftToCheck(draft: CheckDraft): { check: Check } | { error: string } {
  const id = draft.id.trim();
  if (!SAFE_ID.test(id))
    return { error: "ID: letters, digits, '-' and '_', starting with a letter or digit" };
  const [executable, ...args] = splitCommand(draft.command);
  if (!executable) return { error: "Enter the command to run" };
  const cwd = draft.cwd.trim() || ".";
  if (cwd !== "." && !isRelativeInside(cwd))
    return { error: "Directory: a path inside the project, like . or packages/api" };
  const seconds = Number(draft.timeoutSeconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    return { error: "Timeout: whole seconds from 1 to 3600" };
  const writes = splitList(draft.writes);
  if (!writes.every(isRelativeInside))
    return { error: "Files it may write: paths inside the project" };
  return {
    check: {
      id,
      executable,
      args,
      cwd,
      timeoutMs: seconds * 1000,
      required: draft.required,
      scope: draft.scope,
      envNames: splitList(draft.envNames),
      writes,
    },
  };
}
