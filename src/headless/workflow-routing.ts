import { getCwd } from "../core/cwd.js";
import {
  CRITIC_MODES,
  INDEPENDENT_REVIEW_MODES,
  ROUTED_ROLES,
  RouteEffort,
} from "../core/llm/model-routing.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import {
  readRoutingLayers,
  routingConfigFiles,
  saveRoutingChange,
} from "../core/workflows/routing-config.js";
import {
  parseRouteContext,
  type RoutingChange,
  type RoutingScope,
  type RoutingTarget,
} from "../core/workflows/routing-edit.js";

export const routingHelp = `Usage: baked workflow routing [show] [--json]
       baked workflow routing set TARGET MODEL [--effort LEVEL] [--fallback ID,ID] [--context SIZE] [--scope project|global]
       baked workflow routing clear TARGET [--scope project|global]
       baked workflow routing review off|warn|require|provider|unset [--scope project|global]
       baked workflow routing confidence 0..1|unset [--scope project|global]
       baked workflow routing critic off|advise|unset [--scope project|global]
       baked workflow routing specify-sonnet on|off|unset [--scope project|global]
       baked workflow routing web-search on|off|unset [--scope project|global]
       baked workflow routing context default|max|auto|SIZE|unset [--scope project|global]

Changes modelRouting in the project config (.baked/config.json, the default) or the global one
(--scope global), with the checks of the routing screen and the local API: nothing is written
when a check fails, and the reasons are printed with exit code 1.

TARGET is a class ($coding or class:coding), a role (role:reviewer), a profile
(profile:implementer) or a workflow stage (stage:sdd/plan). MODEL is provider/model, or $class
outside a class. --effort is ${RouteEffort.options.join(", ")}; --fallback names up to three
models. review sets independentReview (provider moves reviewers to another vendor's model);
confidence sets reviewMinConfidence, below which review findings stay notes (0.8 by default);
critic sets whether a critic scores every task attempt (unset: only on another vendor);
specify-sonnet on runs the specify stage of a Claude Code Opus run on claude-code/sonnet (off by
default); web-search on lets implementer and acceptance-writer attempts on a Codex model use
Codex's web search (codeWebSearch, off by default; checks keep the policy's network setting);
context sets the context window of every route without its own, and --context that of one route:
default runs the model as named, max its largest window, SIZE (1m, 200k) that window, auto the
model as named until a step does not fit, then its largest window for that step;
unset removes any of them. show prints the modelRouting of both files; "baked workflow route" shows
what each stage resolves to.
`;

export function parseRoutingTarget(text: string): RoutingTarget {
  if (text.startsWith("$")) return { kind: "class", name: text.slice(1) };
  const colon = text.indexOf(":");
  const kind = colon < 0 ? "" : text.slice(0, colon);
  const value = text.slice(colon + 1);
  if (value) {
    if (kind === "class") return { kind: "class", name: value };
    if (kind === "profile") return { kind: "profile", id: value };
    if (kind === "role") {
      const role = ROUTED_ROLES.find((r) => r === value);
      if (role) return { kind: "role", role };
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Unknown role ${value}; use one of ${ROUTED_ROLES.join(", ")}`,
      );
    }
    const slash = value.indexOf("/");
    if (kind === "stage" && slash > 0 && slash < value.length - 1)
      return { kind: "stage", workflowId: value.slice(0, slash), stageId: value.slice(slash + 1) };
  }
  throw new WorkflowFault(
    "INVALID_DEFINITION",
    `Invalid target ${text}; use $class, role:NAME, profile:ID or stage:WORKFLOW/STAGE`,
  );
}

/** Splits positionals from `--name value` flags; booleans are listed in `booleans`. */
function split(
  argv: string[],
  booleans: string[],
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (booleans.includes(name)) flags.set(name, "true");
    else {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined)
        throw new WorkflowFault("INVALID_DEFINITION", `--${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { positional, flags };
}

function only(flags: Map<string, string>, allowed: string[]): void {
  const extra = [...flags.keys()].find((name) => !allowed.includes(name));
  if (extra) throw new WorkflowFault("INVALID_DEFINITION", `Unknown option --${extra}`);
}

export function runRoutingCli(argv: string[], configDir?: string): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(routingHelp);
    return 0;
  }
  const { positional, flags } = split(argv, ["json"]);
  const [command = "show", ...args] = positional;
  const workspace = getCwd();
  const files = routingConfigFiles(workspace, configDir);
  if (command === "show") {
    only(flags, ["json"]);
    if (args.length) throw new WorkflowFault("INVALID_DEFINITION", "show takes no arguments");
    const layers = readRoutingLayers(files);
    const view = { global: layers.global ?? null, project: layers.project ?? null, paths: files };
    process.stdout.write(
      flags.has("json")
        ? `${JSON.stringify(view, null, 2)}\n`
        : `global (${files.global}):\n${JSON.stringify(view.global, null, 2)}\nproject (${files.project}):\n${JSON.stringify(view.project, null, 2)}\n`,
    );
    return 0;
  }
  const scopeText = flags.get("scope") ?? "project";
  if (scopeText !== "project" && scopeText !== "global")
    throw new WorkflowFault("INVALID_DEFINITION", "--scope is project or global");
  const scope: RoutingScope = scopeText;
  let change: RoutingChange;
  if (command === "set") {
    only(flags, ["scope", "effort", "fallback", "context", "json"]);
    const [target, model, ...rest] = args;
    if (!target || model === undefined || rest.length)
      throw new WorkflowFault("INVALID_DEFINITION", "set takes TARGET MODEL");
    const effortText = flags.get("effort");
    const effort = effortText === undefined ? null : RouteEffort.safeParse(effortText);
    if (effort && !effort.success)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `--effort is one of ${RouteEffort.options.join(", ")}`,
      );
    const contextText = flags.get("context");
    const context = contextText === undefined ? null : parseRouteContext(contextText);
    if (contextText !== undefined && context === null)
      throw new WorkflowFault("INVALID_DEFINITION", "--context is default, max, auto or a size");
    change = {
      target: parseRoutingTarget(target),
      route: {
        model,
        effort: effort ? effort.data : null,
        fallback: (flags.get("fallback") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
        context,
      },
    };
  } else if (command === "clear") {
    only(flags, ["scope", "json"]);
    const [target, ...rest] = args;
    if (!target || rest.length) throw new WorkflowFault("INVALID_DEFINITION", "clear takes TARGET");
    change = { target: parseRoutingTarget(target), route: null };
  } else if (command === "review") {
    only(flags, ["scope", "json"]);
    const [mode, ...rest] = args;
    const known = INDEPENDENT_REVIEW_MODES.find((m) => m === mode);
    if (rest.length || !mode || (!known && mode !== "unset"))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `review takes ${INDEPENDENT_REVIEW_MODES.join(", ")} or unset`,
      );
    change = { independentReview: known ?? null };
  } else if (command === "critic") {
    only(flags, ["scope", "json"]);
    const [mode, ...rest] = args;
    const known = CRITIC_MODES.find((m) => m === mode);
    if (rest.length || !mode || (!known && mode !== "unset"))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `critic takes ${CRITIC_MODES.join(", ")} or unset`,
      );
    change = { critic: known ?? null };
  } else if (command === "specify-sonnet") {
    only(flags, ["scope", "json"]);
    const [value, ...rest] = args;
    if (rest.length || !value || !["on", "off", "unset"].includes(value))
      throw new WorkflowFault("INVALID_DEFINITION", "specify-sonnet takes on, off or unset");
    change = { specifyOnSonnet: value === "unset" ? null : value === "on" };
  } else if (command === "web-search") {
    only(flags, ["scope", "json"]);
    const [value, ...rest] = args;
    if (rest.length || !value || !["on", "off", "unset"].includes(value))
      throw new WorkflowFault("INVALID_DEFINITION", "web-search takes on, off or unset");
    change = { codeWebSearch: value === "unset" ? null : value === "on" };
  } else if (command === "context") {
    only(flags, ["scope", "json"]);
    const [value, ...rest] = args;
    const context = value === undefined || value === "unset" ? null : parseRouteContext(value);
    if (rest.length || !value || (value !== "unset" && context === null))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "context takes default, max, auto, a size such as 1m, or unset",
      );
    change = { context };
  } else if (command === "confidence") {
    only(flags, ["scope", "json"]);
    const [value, ...rest] = args;
    const number = Number(value);
    if (rest.length || !value || (value !== "unset" && !(number >= 0 && number <= 1)))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "confidence takes a number from 0 to 1 or unset",
      );
    change = { reviewMinConfidence: value === "unset" ? null : number };
  } else {
    process.stderr.write(`Unknown routing command: ${command}\n\n${routingHelp}`);
    return 1;
  }
  const { problems, file } = saveRoutingChange(workspace, files, scope, change);
  const routing = readRoutingLayers(files)[scope] ?? null;
  if (flags.has("json"))
    process.stdout.write(
      `${JSON.stringify(problems.length ? { saved: false, problems } : { saved: true, file, modelRouting: routing }, null, 2)}\n`,
    );
  else if (problems.length)
    process.stderr.write(`Not saved:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
  else process.stdout.write(`Saved modelRouting in ${file}\n`);
  return problems.length ? 1 : 0;
}
