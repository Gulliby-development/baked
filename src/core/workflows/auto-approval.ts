import { canonical, hashJson } from "../specs/hash.js";
import { WorkflowFault } from "./errors.js";
import { hostGrowth, withoutHostGrowth } from "./host-growth.js";
import { MSBUILD_ACTIVE_PROPERTY } from "./quality/manifest-fields.js";
import { isBoundedLockPath, isManifestPath } from "./quality/manifests.js";
import { unmappedDeliverables } from "./request-coverage.js";
import {
  type ApprovalReview,
  clarificationOf,
  type InputManifest,
  type RunPolicy,
  type Spec,
  type TaskGraph,
} from "./schemas.js";
import { SLICE_PART, SPLIT_PART } from "./sizing.js";
import { stopMode } from "./stop-reasons.js";
import type { ArtifactRow, RequestRow } from "./store.js";
import { hostWritten } from "./task-graph.js";
import type { RuntimeState } from "./types.js";
import { isAcceptanceRequest } from "./v2/acceptance.js";

/** The built-in profile that decides packages `autoApproval.modelReview` sends to it. */
export const APPROVAL_REVIEWER = "approval-reviewer";

export interface AutoApproval {
  mode: "renewal" | "limits" | "model-review";
  /** Hash of the policy bounds the decision was taken under. */
  limitsHash: string;
  /** The reviewer's verdict, for `model-review`. */
  review?: ApprovalReview;
}
export interface AutoApprovalResult {
  approval: AutoApproval | null;
  /** Why the package needs a person; empty when auto approval is approved or disabled. */
  reasons: string[];
  /**
   * The package left the limits only by its task count, file count or paths, and the policy
   * turns on `modelReview`: the approval reviewer may decide it. Never set for always-human
   * writes, deletes, the token budget or renewal problems.
   */
  reviewable?: boolean;
  /** The policy bounds hash a `model-review` approval records, set with `reviewable`. */
  limitsHash?: string;
  /**
   * Task and file limits the package passed while `approval-scope` is in shadow or advisory
   * mode: they did not decline the approval, and the caller records them (#1714).
   */
  wouldStop?: { mode: "shadow" | "advisory"; problems: string[] };
}
/**
 * A policy the operator set with an explicit workflow command (`extend`, or `revise` of a staged
 * candidate). Only the command service writes these records; nothing here comes from model output.
 */
export interface PolicyDecision {
  policyHash: string;
}
type Write = TaskGraph["tasks"][number]["writes"][number];

/** Paths that always need a person, whatever the limits (design section 5.2). */
const alwaysHuman =
  /^(?:\.git|\.baked|baked|specs|\.github|\.gitlab|\.circleci|\.husky)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|constitution\.md|package\.json|bunfig\.toml|Cargo\.toml|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*\.(?:csproj|fsproj|vbproj)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Directory\.(?:Packages|Build)\.props|Directory\.Build\.targets|[^/]*[.-]lock(?:b|\.[^/]*)?|tsconfig[^/]*|biome[^/]*|\.env(?:\.[^/]*)?|\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|[^/]*\.(?:pem|key|crt|cer|p12|pfx|jks|keystore))$/i;

/** Whether writing `path` always needs a person: secrets, CI and deployment config, manifests. */
export function alwaysNeedsPerson(path: string): boolean {
  return alwaysHuman.test(path);
}

/**
 * Project manifests and tool configs. Creating one that does not exist yet is how a scaffold
 * starts and changes nothing a person has reviewed; modifying one stays with a person.
 */
const manifestFile =
  /(?:^|\/)(?:package\.json|bunfig\.toml|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*\.(?:csproj|fsproj|vbproj)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Directory\.(?:Packages|Build)\.props|Directory\.Build\.targets|tsconfig[^/]*|biome[^/]*)$/i;

/**
 * Whether a write needs a person whatever the limits; `exists` tells which files are already there.
 * On a scaffold baseline (no source files) a manifest is edited too: the scaffold holds nothing a
 * person has reviewed yet, and the next task needs its scripts and dev dependencies.
 */
function needsPerson(write: Write, exists?: (path: string) => boolean, scaffold = false): boolean {
  if (!alwaysHuman.test(write.path)) return false;
  if (scaffold && manifestFile.test(write.path) && write.action !== "delete") return false;
  return !(
    write.action === "create" &&
    exists !== undefined &&
    manifestFile.test(write.path) &&
    !exists(write.path)
  );
}

/** What the host knows about the run's package that the graph does not say. */
export interface ApprovalContext {
  /** Whether a path exists in the workspace the tasks will write to. */
  exists?: (path: string) => boolean;
  /**
   * Planned tasks the planner added when it answered a sizing split, fixed at that replan (#1711).
   * Excluded from the planned task count; slices and parts of one task count once anyway.
   */
  hostSplitTasks?: number;
  /** The run's baseline holds no source files (empty or scaffold only). */
  scaffold?: boolean;
  /** The user's request; a spec that leaves one of its deliverables unmapped needs a person. */
  request?: string;
  /**
   * The run's own request text, which `requestedManifestEdits` matches manifest writes against
   * (defaults to `request`). A feature run of an initiative checks deliverables against nothing,
   * since its boundary was approved with the split, but its request still names the manifest its
   * boundary lists (#1394, dieodds cli).
   */
  manifestRequest?: string;
  /**
   * Tokens the host added to the run budget on its own (planning floor, sizing, growth), recorded
   * as policy revisions with `approvedBy: "sizing"`; see `hostBudgetGrowth`.
   */
  hostGrowthTokens?: number;
  /**
   * The run's policy revisions, so a renewal can tell the host's own budget growth from a change a
   * person has to approve (`hostGrowth`).
   */
  policyRevisions?: { artifacts: ArtifactRow[]; read: (artifact: ArtifactRow) => string };
}

/** Budget limits a renewal may keep or lower, never raise, unless the operator raised them. */
const budgetKeys = [
  "maxConcurrentReadAgents",
  "maxAgentSteps",
  "maxAgentCalls",
  "maxTotalTokens",
  "maxActiveMs",
  "maxRepairRounds",
  "maxConvergenceRounds",
  "maxCorrectiveTasks",
] as const;

/** Policy fields that grant capabilities or set review strength; only a person may widen them. */
const capabilityKeys = [
  "allowedTools",
  "network",
  "reviewProfiles",
  "skepticProfileId",
  "forceSecurityReview",
  "sandbox",
] as const;
const networkRank = { deny: 0, ask: 1, allow: 2 } as const;
/** A weaker OS sandbox widens what run processes may touch. */
const sandboxRank = { off: 0, auto: 1, required: 2 } as const;

/**
 * Decides on the host whether a package may be approved without a person. Any doubt returns
 * reasons and no approval, so the run falls back to a human request.
 */
export function evaluateAutoApproval(
  policy: RunPolicy,
  manifest: InputManifest,
  spec: Spec,
  graph: TaskGraph,
  requests: RequestRow[],
  decisions: PolicyDecision[] = [],
  context: ApprovalContext = {},
): AutoApprovalResult {
  const config = policy.autoApproval;
  if (!config) return { approval: null, reasons: [] };
  const writes = graph.tasks.flatMap((task) => task.writes);
  const manifestRequest = context.manifestRequest ?? context.request ?? "";
  const requested = (write: Write) => requestedWriteExempt(policy, write, manifestRequest);
  const ruleOf = (write: Write) => requestedWriteRule(policy, write, manifestRequest);
  const common: string[] = [];
  for (const write of writes)
    if (needsPerson(write, context.exists, context.scaffold) && !requested(write))
      common.push(personText(write, ruleOf(write)));
  // Under `clarification: assume` the run already decides what it may on its own; the deferral is
  // recorded in the approval body and the run report, so it is visible without a person.
  if (
    clarificationOf(policy) !== "assume" &&
    spec.criteria.some((criterion) => criterion.method === "post-release")
  )
    common.push("Deferring post-release criteria needs a person");
  for (const deliverable of unmappedDeliverables(spec, context.request ?? ""))
    common.push(`Request deliverable not covered by the spec: ${deliverable}`);
  const limitsHash = hashJson({ policy: policyBounds(policy) });
  const reasons: string[] = [...common];
  if (config.renewal) {
    const renewal = renewalProblems(
      policy,
      manifest,
      graph,
      requests,
      decisions,
      context.policyRevisions,
    );
    if (!common.length && !renewal.length)
      return { approval: { mode: "renewal", limitsHash }, reasons: [] };
    reasons.push(...renewal.map((reason) => `Renewal: ${reason}`));
  }
  let reviewable = false;
  let wouldStop: AutoApprovalResult["wouldStop"];
  if (config.limits) {
    const limits = config.limits;
    // A manifest edit the request names is in scope even when the allowed paths leave the
    // manifest out, as every update scaffold does (#1547).
    const counted = scopeProblems(limits, graph, context.hostSplitTasks ?? 0, requested, ruleOf);
    // Over the task or file count is a size judgment and can run in shadow; paths and deletes
    // guard what the run may touch and always decline.
    const mode = stopMode(policy, "approval-scope");
    const shadowed = mode === "enforce" ? [] : counted.filter((p) => p.count).map((p) => p.text);
    if (shadowed.length && mode !== "enforce") wouldStop = { mode, problems: shadowed };
    const scope = counted.filter((p) => !shadowed.includes(p.text));
    const problems = scope.map((p) => p.text);
    // Growth the host made itself, up to the policy's own sizing ceiling, is not a budget a person
    // has to approve; only the budget the run started with counts against the limit (#1309).
    const grown = Math.max(0, context.hostGrowthTokens ?? 0);
    const ceiling = Math.max(limits.maxTotalTokens, policy.sizing?.maxRunTokens ?? 0);
    const started = policy.maxTotalTokens - grown;
    if (started > limits.maxTotalTokens)
      problems.push(`the token budget ${policy.maxTotalTokens} exceeds ${limits.maxTotalTokens}`);
    else if (policy.maxTotalTokens > ceiling)
      problems.push(
        `the token budget ${policy.maxTotalTokens} exceeds the sizing ceiling ${ceiling}`,
      );
    if (!common.length && !problems.length)
      return {
        approval: { mode: "limits", limitsHash },
        reasons: [],
        ...(wouldStop ? { wouldStop } : {}),
      };
    reasons.push(...problems.map((reason) => `Limits: ${reason}`));
    reviewable =
      config.modelReview === true &&
      !common.length &&
      problems.length > 0 &&
      problems.length === scope.length &&
      scope.every((p) => p.reviewable);
  }
  return {
    approval: null,
    reasons: [...new Set(reasons)],
    ...(reviewable ? { reviewable, limitsHash } : {}),
    ...(wouldStop ? { wouldStop } : {}),
  };
}

type Limits = NonNullable<NonNullable<RunPolicy["autoApproval"]>["limits"]>;

const partOf = new RegExp(
  `(?:${[SPLIT_PART, SLICE_PART].map((note) => note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[^\n]*?other parts of (T\\d+)`,
);

/**
 * The planned task a task belongs to: the task sizing cut it from (`sizingSlice.taskId`, or the
 * task its by-file part note names), else itself. Slices keep their group through every later
 * plan, so the same graph counts the same on every planning pass (#1711).
 */
export function plannedTaskKey(
  task: Pick<TaskGraph["tasks"][number], "id" | "description" | "sizingSlice">,
): string {
  return task.sizingSlice?.taskId ?? partOf.exec(task.description)?.[1] ?? task.id;
}

/**
 * The tasks an agent runs, against the task limit: one per planned task, so the slices and
 * by-file parts sizing cut from one task count once (url-shortener and md-site, bench round 51,
 * were declined with 9 and 14 tasks of 8 and 7 planned ones, #1711); without the tasks the host
 * writes from the plan's content (an empty `__init__.py`, a fixed stub; no attempt, no tokens,
 * #1658); and without the tasks the planner added answering a sizing split (`sizingTasks`, #1627).
 * Their files still count against `maxFiles`.
 */
export function agentTaskCount(
  graph: Pick<TaskGraph, "tasks">,
  sizingTasks = 0,
): { agent: number; host: number; slices: number } {
  const agentTasks = graph.tasks.filter((task) => !hostWritten(task));
  const groups = new Set(agentTasks.map(plannedTaskKey)).size;
  return {
    agent: Math.max(0, groups - sizingTasks),
    host: graph.tasks.length - agentTasks.length,
    slices: agentTasks.length - groups,
  };
}

/**
 * Where a task graph leaves the limits' scope: task and file counts, paths and deletions. A
 * deletion is never left to the approval reviewer, and neither is a request-named manifest or tool
 * config that `ruleOf` keeps with a person: its message names that rule, not the allowed paths.
 */
function scopeProblems(
  limits: Limits,
  graph: TaskGraph,
  hostSplitTasks = 0,
  required: (write: Write) => boolean = () => false,
  ruleOf: (write: Write) => string | undefined = () => undefined,
): { text: string; reviewable: boolean; count?: true }[] {
  const writes = graph.tasks.flatMap((task) => task.writes);
  const problems: { text: string; reviewable: boolean; count?: true }[] = [];
  const { agent: planned, host, slices } = agentTaskCount(graph, hostSplitTasks);
  if (planned > limits.maxTasks) {
    const left = [
      ...(slices ? [`${slices} sizing ${slices === 1 ? "slice" : "slices"}`] : []),
      ...(hostSplitTasks ? [`${hostSplitTasks} added for sizing`] : []),
      ...(host ? [`${host} host-written`] : []),
    ];
    problems.push({
      text: `${planned} tasks exceed ${limits.maxTasks}${left.length ? ` (${left.join(", ")} not counted)` : ""}`,
      reviewable: true,
      count: true,
    });
  }
  const files = new Set(writes.map((write) => write.path.toLowerCase()));
  if (files.size > limits.maxFiles)
    problems.push({
      text: `${files.size} files exceed ${limits.maxFiles}`,
      reviewable: true,
      count: true,
    });
  const globs = limits.allowedPaths.map((pattern) => new Bun.Glob(pattern.toLowerCase()));
  for (const write of writes) {
    if (required(write)) continue;
    if (!globs.some((glob) => glob.match(write.path.toLowerCase()))) {
      const rule = ruleOf(write);
      problems.push(
        rule
          ? { text: personText(write, rule), reviewable: false }
          : { text: `${write.path} is outside the allowed paths`, reviewable: true },
      );
    }
    if (write.action === "delete" && !limits.allowDelete)
      problems.push({ text: `${write.path} would be deleted`, reviewable: false });
  }
  return problems;
}

/**
 * The scope the host approves without a person, for the planner: without it the planner picks
 * its writes blind to the limits, and an optional extra file sends the plan to a person.
 */
export function plannerApprovalLimits(policy: RunPolicy): {
  maxTasks: number;
  maxFiles: number;
  allowedPaths: string[];
  allowDelete: boolean;
  alwaysHuman: string;
} | null {
  const limits = policy.autoApproval?.limits;
  if (!limits) return null;
  return {
    maxTasks: limits.maxTasks,
    maxFiles: limits.maxFiles,
    allowedPaths: limits.allowedPaths,
    allowDelete: limits.allowDelete,
    alwaysHuman: `repository metadata (.git, .github and other CI folders, .baked, specs), agent instructions, package manifests that already exist (creating one is allowed, and editing one on a workspace without source files${policy.autoApproval?.requestedManifestEdits ? " or one the request names: a dependency manifest, a solution or go.work file, or a Directory.Build.props, Directory.Build.targets, Directory.Packages.props, global.json, NuGet.config, gradle.properties, .mvn/maven.config or rust-toolchain.toml the plan writes whole in a host-written task with plain properties only, or a Cargo.lock, package-lock.json, uv.lock or Gemfile.lock that changes only the project's own entry" : ""}), lockfiles, tool configs (tsconfig, biome), .env files and keys`,
  };
}

/** Test files that .NET project templates create and a plan replaces with real tests. */
const templatePlaceholder = /(?:^|\/)(?:UnitTest1|Class1)\.(?:cs|fs|vb)$/i;

/**
 * A write the planner cannot drop: the request names its file, or it deletes a project template's
 * placeholder. Advising against it only makes the planner submit the same plan again (#1111).
 */
function requiredByRequest(write: Write, request: string): boolean {
  if (write.action === "delete" && templatePlaceholder.test(write.path)) return true;
  const text = request.toLowerCase();
  const path = write.path.toLowerCase();
  const name = path.split("/").at(-1) ?? path;
  return text.includes(path) || (name.includes(".") && text.includes(name));
}

/**
 * A write the request names that the approval takes as asked for, whatever the always-human rule
 * and the allowed paths say: a manifest or tool config whose kind is exempt under
 * `autoApproval.requestedManifestEdits` (see `CONFIG_KINDS`). The always-human test, the limits'
 * scope check and the planner's advice all use it, so the advice never calls a write fine that
 * the approval declines (spdxok b270088e, bench round 45: the `pyproject.toml` edit the brief
 * named passed the first and failed the second, #1547).
 */
function requestedWriteExempt(policy: RunPolicy, write: Write, request: string): boolean {
  return (
    policy.autoApproval?.requestedManifestEdits === true && namedConfigRule(write, request) === null
  );
}

/**
 * The planned manifest and tool config writes the approval takes as asked for because the request
 * names them (#1547). The approval sees their paths only, so the manifest field check holds their
 * executable fields to what the request names (#1793).
 */
export function requestExemptPaths(policy: RunPolicy, graph: TaskGraph, request: string): string[] {
  return [
    ...new Set(
      graph.tasks
        .flatMap((task) => task.writes)
        .filter((write) => requestedWriteExempt(policy, write, request))
        .map((write) => write.path),
    ),
  ];
}

/**
 * The rule that keeps a request-named manifest or tool config with a person under
 * `autoApproval.requestedManifestEdits`, so the approval and the planner's advice say the same
 * sentence instead of "outside the allowed paths" (#1710). Undefined when the write is exempt, the
 * request does not name it, or the setting is off.
 */
function requestedWriteRule(policy: RunPolicy, write: Write, request: string): string | undefined {
  if (policy.autoApproval?.requestedManifestEdits !== true) return undefined;
  return namedConfigRule(write, request) ?? undefined;
}

function personText(write: Write, rule: string | undefined): string {
  return rule ? `${write.path} needs a person: ${rule}` : `${write.path} always needs a person`;
}

/**
 * A manifest or tool config a request may name. A kind without `rule` is exempt when named: the
 * dependency check reads it (#802), or it only lists projects. A kind with `inert` is exempt when
 * the plan holds the write's whole content (a host-written task) and that content runs no code and
 * fetches nothing; any other write of it keeps its rule.
 */
interface ConfigKind {
  matches: (path: string) => boolean;
  rule?: string;
  inert?: (content: string) => boolean;
}

const named = (pattern: RegExp) => (path: string) => pattern.test(path);

const MSBUILD_RULE =
  "MSBuild props and targets run build logic; one is approved only when the plan writes it whole with PropertyGroup properties alone";

const MSBUILD_PROPERTY =
  /<([\w.-]+)((?:\s+(?:Condition|Label)\s*=\s*"[^"]*")*)\s*>([^<]*)<\/\1\s*>/g;
const MSBUILD_PIN =
  /<PackageVersion(?:\s+(?:Include|Version|VersionOverride|Condition)\s*=\s*"[^"]*")+\s*\/>/g;
const MSBUILD_GROUP =
  /<(PropertyGroup|ItemGroup)((?:\s+(?:Condition|Label)\s*=\s*"[^"]*")*)\s*>([\s\S]*?)<\/\1\s*>/g;

/**
 * MSBuild content that only sets properties (and, in `Directory.Packages.props`, pins package
 * versions): no `Import`, `Target`, `Exec`, `UsingTask`, `PackageReference`, `Sdk` attribute,
 * property function or property that hooks a command or target into the build.
 */
function msbuildInert(pins: boolean) {
  return (content: string): boolean => {
    const xml = content
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^﻿?\s*<\?xml[^>]*\?>/, "")
      .trim();
    const root = /^<Project((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*>([\s\S]*)<\/Project\s*>$/.exec(xml);
    if (!root) return false;
    const attributes = [...(root[1] ?? "").matchAll(/([\w:.-]+)\s*=/g)].map((m) => m[1] ?? "");
    if (!attributes.every((name) => /^(?:xmlns(?::\w+)?|ToolsVersion)$/.test(name))) return false;
    let inert = true;
    const rest = (root[2] ?? "").replace(
      MSBUILD_GROUP,
      (_, group: string, _attrs, body: string) => {
        if (group === "ItemGroup" && !pins) inert = false;
        const left =
          group === "ItemGroup"
            ? body.replace(MSBUILD_PIN, "")
            : body.replace(MSBUILD_PROPERTY, (_m, name: string, _a, value: string) => {
                if (MSBUILD_ACTIVE_PROPERTY.test(name) || value.includes("$([")) inert = false;
                return "";
              });
        if (left.trim()) inert = false;
        return "";
      },
    );
    return inert && !rest.trim();
  };
}

/** Lines of `key = value` (or `key: value`) and `[section]` headers, with comments. */
function keyValue(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[#;!]/.test(line))
    .every((line) => /^(?:\[[\w.-]+\]|[\w.-]+\s*[=:]\s*.*)$/.test(line));
}

/**
 * Every manifest and tool config kind a request may name, with the rule for a request-named write
 * of it (#1710). One table for every toolchain, so the approval, the scope check and the planner's
 * advice cannot drift apart for one kind.
 */
const CONFIG_KINDS: readonly ConfigKind[] = [
  {
    matches: named(/(?:^|\/)Directory\.Build\.(?:props|targets)$/i),
    rule: MSBUILD_RULE,
    inert: msbuildInert(false),
  },
  {
    matches: named(/(?:^|\/)Directory\.Packages\.props$/i),
    rule: `${MSBUILD_RULE} and PackageVersion pins`,
    inert: msbuildInert(true),
  },
  { matches: isManifestPath },
  { matches: named(/(?:^|\/)(?:[^/]+\.slnx?|go\.work)$/i) },
  {
    matches: named(/(?:^|\/)global\.json$/i),
    rule: "global.json msbuild-sdks load build code",
    inert: (content) => {
      try {
        const parsed: unknown = JSON.parse(content);
        return typeof parsed === "object" && parsed !== null && !("msbuild-sdks" in parsed);
      } catch {
        return false;
      }
    },
  },
  {
    matches: named(/(?:^|\/)nuget\.config$/i),
    rule: "NuGet.config package sources and credentials decide where packages come from",
    inert: (content) =>
      /^\s*(?:<\?xml[^>]*\?>\s*)?<configuration\b/.test(content) &&
      !/packageSource|credential|<add\s[^>]*value\s*=\s*"[a-z]+:/i.test(content),
  },
  {
    matches: named(/(?:^|\/)gradle\.properties$/i),
    rule: "gradle.properties passes JVM options to every build; only plain properties without agents are approved",
    inert: (content) => keyValue(content) && !/-(?:javaagent|agentpath|agentlib)/i.test(content),
  },
  {
    matches: named(/(?:^|\/)\.mvn\/maven\.config$/i),
    rule: "maven.config passes options to every Maven build; only -D properties, -P profiles and -T, -B, -q, -e, -ntp are approved",
    inert: (content) =>
      content
        .split(/\s+/)
        .filter(Boolean)
        .every((token) =>
          /^(?:-D[\w.-]+(?:=\S*)?|-P\S+|-T\S+|-B|--batch-mode|-ntp|--no-transfer-progress|-q|--quiet|-e|--errors)$/.test(
            token,
          ),
        ),
  },
  {
    matches: named(/(?:^|\/)rust-toolchain(?:\.toml)?$/i),
    rule: "rust-toolchain selects the compiler; a toolchain path runs any binary",
    inert: (content) =>
      /^\s*[\w.-]+\s*$/.test(content) || (keyValue(content) && !/^\s*path\s*=/m.test(content)),
  },
  {
    matches: named(/(?:^|\/)\.cargo\/config(?:\.toml)?$/i),
    rule: "Cargo config sets linkers, runners and compiler flags for every build",
  },
  { matches: named(/(?:^|\/)setup\.py$/i), rule: "setup.py is Python code the install runs" },
  { matches: named(/(?:^|\/)tox\.ini$/i), rule: "tox.ini runs commands" },
  { matches: named(/(?:^|\/)[^/]+\.gemspec$/i), rule: "a gemspec is Ruby code" },
  {
    matches: named(/(?:^|\/)bunfig\.toml$/i),
    rule: "bunfig.toml sets preload scripts and package registries",
  },
  {
    matches: named(/(?:^|\/)(?:tsconfig|biome)[^/]*$/i),
    rule: "tsconfig and biome configs set what the checks enforce",
  },
  // A lock that records the project's own version, named beside a version bump: the manifest
  // field check holds every other entry of it to what it was (#1934).
  { matches: isBoundedLockPath },
  {
    matches: named(/(?:^|\/)(?:[^/]*[.-]lock(?:b|\.[^/]*)?|go\.sum)$/i),
    rule: "lock files are written by the package manager",
  },
];

/** The manifest or tool config kind of a path, if it is one. */
function configKind(path: string): ConfigKind | undefined {
  const normalized = path.replaceAll("\\", "/");
  return CONFIG_KINDS.find((kind) => kind.matches(normalized));
}

/**
 * For a manifest or tool config the request names as one to change: null when its kind exempts
 * the write, else the rule that keeps it with a person. Undefined for a delete, another file, or a
 * file the request does not name.
 */
function namedConfigRule(write: Write, request: string): string | null | undefined {
  if (write.action === "delete") return undefined;
  const kind = configKind(write.path);
  if (!kind || !requestNamesManifest(write, request)) return undefined;
  if (!kind.rule) return null;
  if (kind.inert && write.content !== undefined && kind.inert(write.content)) return null;
  return kind.rule;
}

/** Manifest names every package of a monorepo repeats; the request names one only by its path. */
const SHARED_MANIFEST =
  /^(?:package\.json|pyproject\.toml|requirements[\w.-]*\.txt|cargo\.toml|go\.mod|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|gemfile)$/;
/** A sentence that tells the run to leave a file alone ("keep package.json as is"). */
const LEAVE_ALONE =
  /\b(?:do not|don't|never|must not|should not|without (?:changing|editing|modifying|touching|updating))\b|\b(?:keep|leave)\b.*\b(?:as[ -]is|unchanged|untouched|intact|alone)\b/;
const PATH_CHAR = "[\\w./-]";

/** The request's sentences as `requestNamesManifest` reads them, with the leave-alone ones out. */
const changeSentences = (request: string): string[] =>
  request
    .toLowerCase()
    .replaceAll("\\", "/")
    .replaceAll("\u2019", "'")
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((sentence) => !LEAVE_ALONE.test(sentence));

/**
 * The file names and paths a request names in sentences that do not tell the run to leave them
 * alone, one per line of the result: all `requestNamesManifest` reads of a request. A bench trace
 * keeps them in place of the request's prose, so the replay decides request-named manifest edits
 * as the run did (#1707).
 */
export function requestedPathTokens(request: string): string[] {
  return [
    ...new Set(
      changeSentences(request).flatMap((sentence) =>
        (sentence.match(/[\w./-]+/g) ?? [])
          .map((token) => token.replace(/\.+$/, ""))
          .filter((token) => /\w\.\w/.test(token) || manifestFile.test(token)),
      ),
    ),
  ];
}

/**
 * Whether the request names a manifest as one to change (#1428). Unlike `requiredByRequest`,
 * which only shapes the planner's advice, this decides an approval: the manifest's path must
 * appear as a whole token (`package.json` is not part of `packages/api/package.json`), its bare
 * file name counts only for a name no other package repeats (`Api.csproj`, not `package.json`),
 * and a sentence that tells the run to leave the file alone does not count.
 */
function requestNamesManifest(write: Write, request: string): boolean {
  const path = write.path.toLowerCase();
  const name = path.split("/").at(-1) ?? path;
  const tokens = SHARED_MANIFEST.test(name) ? [path] : [path, name];
  const whole = tokens.map(
    (token) =>
      new RegExp(
        `(?:^|[^\\w./-])(?:\\./)?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${PATH_CHAR}*\\w)`,
      ),
  );
  return changeSentences(request).some((sentence) => whole.some((re) => re.test(sentence)));
}

/**
 * Why a submitted plan would not be approved within the limits. The planner gets these once per
 * run as advice: a plan that still needs such a write is accepted and goes to a person at
 * approval. Writes the request requires are left out, since dropping them is not an option.
 */
export function planScopeAdvice(
  policy: RunPolicy,
  graph: TaskGraph,
  exists?: (path: string) => boolean,
  scaffold = false,
  request = "",
  hostSplitTasks = 0,
): string[] {
  const limits = policy.autoApproval?.limits;
  if (!limits) return [];
  // A manifest or tool config counts as required only when the request names it as one to
  // change, by the rule the approval applies (#1547); one whose kind keeps it with a person is
  // reported with that rule, word for word as the approval declines it (#1710). Any other file the
  // request names cannot be dropped (#1111).
  const ruleOf = (write: Write) => requestedWriteRule(policy, write, request);
  const required = (write: Write) =>
    configKind(write.path)
      ? write.action !== "delete" &&
        requestNamesManifest(write, request) &&
        ruleOf(write) === undefined
      : requiredByRequest(write, request);
  const always = graph.tasks
    .flatMap((task) => task.writes)
    .filter((write) => !required(write) && needsPerson(write, exists, scaffold))
    .map((write) => personText(write, ruleOf(write)));
  const problems = [
    ...new Set([
      ...always,
      ...scopeProblems(limits, graph, hostSplitTasks, required, ruleOf).map((p) => p.text),
    ]),
  ];
  if (!problems.length) return [];
  return [
    `This plan needs a person at approval: ${problems.join("; ")}. Automatic approval covers at most ${limits.maxTasks} tasks (slices of one task count once; tasks the host writes from their content do not count) and ${limits.maxFiles} files under ${limits.allowedPaths.join(", ")}${limits.allowDelete ? "" : " without deletions"}. Drop writes the requirements do not need (an optional refactor, a type or helper that can live in a file already written) and merge small tasks. If every listed write is needed, submit the plan again unchanged: it is accepted and a person approves it once at approval, which authorizes every write it lists. Do not mention approval in task descriptions or rationales; the tasks run only after the person approved.`,
  ];
}

const APPROVAL = /\bapprov/i;
const GATE =
  /\b(human|person|people|manual(ly)?|requires?|required|needs?|needed|waits?|pending|until|before|without|not (been )?(given|provided|granted))\b/i;

/** A text without the sentences that make a step wait for an approval (#797). */
function withoutApproval(text: string, fallback: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !(APPROVAL.test(sentence) && GATE.test(sentence)))
    .join(" ")
    .trim();
  return kept || fallback;
}

/**
 * Task descriptions and rationales without approval remarks. A planner told that a write needs a
 * person copied that into the task ("this workflow path requires human approval"), and the
 * implementer then refused the write after the person had approved the plan (R12 url-shortener
 * c86f72da). A task only runs after its plan was approved, so such a remark is never true there.
 */
export function withoutApprovalRemarks(graph: TaskGraph): TaskGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => ({
      ...task,
      description: withoutApproval(task.description, task.title),
      rationale: withoutApproval(task.rationale, "Required by the approved plan"),
    })),
  };
}

/**
 * A renewal stays within the latest human approval: the same or fewer writes, the same task
 * profiles and frozen inputs, and no wider capabilities. The remaining policy settings (checks,
 * budgets, auto approval) must match that approval, or match the policy the operator set later
 * with an explicit command, because that command is itself a human decision. Budget growth the
 * host made on its own after either (`hostGrowth`) is not a change: the renewal compares the limits
 * as they were before it. A renewal refused "maxTotalTokens grew" after the host grew the budget
 * past a revise, and since the cost cap grows too, "checks or other policy settings changed"
 * (#1430).
 */
function renewalProblems(
  policy: RunPolicy,
  manifest: InputManifest,
  graph: TaskGraph,
  requests: RequestRow[],
  decisions: PolicyDecision[],
  revisions?: ApprovalContext["policyRevisions"],
): string[] {
  const previous = requests.filter(
    (request) =>
      request.kind === "approval" &&
      request.status === "accepted" &&
      request.actor === "user" &&
      !isAcceptanceRequest(request),
  );
  const last = previous.at(-1);
  if (!last) return ["no earlier human approval in this run"];
  const body = JSON.parse(last.body_json) as {
    manifest?: InputManifest;
    writes?: Write[];
    policy?: RunPolicy;
    profiles?: string[];
  };
  if (!body.manifest || !body.writes || !body.policy)
    return ["the earlier approval does not record its scope"];
  const approved = body.policy;
  const problems = capabilityProblems(policy, approved);
  // A run's policy changes only through operator commands, and each records a decision. A policy
  // in force that a decision names is therefore the operator's latest choice; an approval taken
  // after that decision was taken under the same policy, so their order does not matter.
  const current = hashJson(policy);
  const growth = revisions
    ? hostGrowth(
        revisions.artifacts,
        revisions.read,
        current,
        new Set([hashJson(approved), ...decisions.map((decision) => decision.policyHash)]),
      )
    : null;
  const set = growth ? withoutHostGrowth(policy, growth) : policy;
  const operatorSet = decisions.some(
    (decision) => decision.policyHash === current || decision.policyHash === growth?.baseHash,
  );
  if (!operatorSet) {
    if (canonical(settings(set)) !== canonical(settings(approved)))
      problems.push("checks or other policy settings changed without an operator decision");
    for (const key of budgetKeys)
      if (set[key] > approved[key])
        problems.push(`${key} grew from ${approved[key]} to ${set[key]}`);
  }
  for (const key of ["workflowHash", "profileHashes", "skillHashes"] as const)
    if (canonical(manifest[key]) !== canonical(body.manifest[key])) problems.push(`${key} changed`);
  if (!body.profiles) problems.push("the earlier approval does not record its task profiles");
  else
    for (const profile of new Set(graph.tasks.map((task) => task.profileId)))
      if (!body.profiles.includes(profile))
        problems.push(`task profile ${profile} was not approved`);
  for (const write of graph.tasks.flatMap((task) => task.writes)) {
    const path = write.path.toLowerCase();
    const covered = body.writes.some(
      (w) =>
        w.path.toLowerCase() === path &&
        (write.action === "delete" ? w.action === "delete" : w.action !== "delete"),
    );
    if (!covered) problems.push(`${write.action} ${write.path} was not approved`);
  }
  return problems;
}

/** Capabilities may stay or shrink after a human approval, whoever changed them. */
function capabilityProblems(policy: RunPolicy, approved: RunPolicy): string[] {
  const problems: string[] = [];
  for (const tool of policy.allowedTools)
    if (!approved.allowedTools.includes(tool)) problems.push(`tool ${tool} was added`);
  if (networkRank[policy.network] > networkRank[approved.network])
    problems.push(`network widened from ${approved.network} to ${policy.network}`);
  if (
    canonical(policy.reviewProfiles) !== canonical(approved.reviewProfiles) ||
    policy.skepticProfileId !== approved.skepticProfileId
  )
    problems.push("review profiles changed");
  if (approved.forceSecurityReview && !policy.forceSecurityReview)
    problems.push("forced security review was turned off");
  const sandbox = policy.sandbox ?? "off";
  const approvedSandbox = approved.sandbox ?? "off";
  if (sandboxRank[sandbox] < sandboxRank[approvedSandbox])
    problems.push(`sandbox weakened from ${approvedSandbox} to ${sandbox}`);
  return problems;
}

/** Policy settings other than budgets and capabilities. */
function settings(policy: RunPolicy): Record<string, unknown> {
  const copy = policyBounds(policy, false);
  for (const key of capabilityKeys) delete copy[key];
  return copy;
}

/** Policy without its budget numbers, or all of it. */
function policyBounds(policy: RunPolicy, withBudget = true): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...policy };
  if (!withBudget) for (const key of budgetKeys) delete copy[key];
  return copy;
}

/**
 * The operator's policy decisions of a run: the `policy-revision` artifacts the
 * command service writes for `extend` and `revise`. A record that does not name the user as its
 * approver is ignored.
 */
export function policyDecisions(
  artifacts: ArtifactRow[],
  read: (artifact: ArtifactRow) => string,
): PolicyDecision[] {
  const decisions: PolicyDecision[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "policy-revision") continue;
    const body = JSON.parse(read(artifact)) as { approvedBy?: unknown; policyHash?: unknown };
    if (body.approvedBy === "user" && typeof body.policyHash === "string")
      decisions.push({ policyHash: body.policyHash });
  }
  return decisions;
}

/**
 * Tokens the host added to the run budget without a person: the sum of the `maxTotalTokens`
 * increases of policy revisions with `approvedBy: "sizing"` (planning floor, sizing, growth).
 */
export function hostBudgetGrowth(
  artifacts: ArtifactRow[],
  read: (artifact: ArtifactRow) => string,
): number {
  let grown = 0;
  for (const artifact of artifacts) {
    if (artifact.kind !== "policy-revision") continue;
    const body = JSON.parse(read(artifact)) as {
      approvedBy?: unknown;
      previous?: { maxTotalTokens?: unknown };
      next?: { maxTotalTokens?: unknown };
    };
    const before = body.previous?.maxTotalTokens;
    const after = body.next?.maxTotalTokens;
    if (body.approvedBy === "sizing" && typeof before === "number" && typeof after === "number")
      grown += Math.max(0, after - before);
  }
  return grown;
}

/**
 * The plan approval's host decision from the run state the scheduler holds at the approval: the
 * request texts, the planner-added sizing tasks and the host's budget growth and policy decisions
 * in the run's artifacts. `workspace` says what the run's tree holds. The bench-trace replay asks
 * it again with the state a recorded run kept (#1707), whose request has no text left to cover
 * (`coverage: false`).
 */
export function planApprovalDecision(
  policy: RunPolicy,
  state: Pick<
    RuntimeState,
    "manifest" | "hostSplitTasks" | "hostDependencies" | "requestText" | "prompt"
  > & {
    spec: Spec;
    graph: TaskGraph;
  },
  requests: RequestRow[],
  artifacts: ArtifactRow[],
  read: (artifact: ArtifactRow) => string,
  workspace: { scaffold: boolean; exists: (path: string) => boolean; coverage?: boolean },
): AutoApprovalResult {
  return evaluateAutoApproval(
    policy,
    state.manifest,
    state.spec,
    state.graph,
    requests,
    policyDecisions(artifacts, read),
    {
      request: state.hostDependencies || workspace.coverage === false ? "" : state.requestText,
      manifestRequest: state.requestText || state.prompt,
      hostSplitTasks: state.hostSplitTasks,
      scaffold: workspace.scaffold,
      hostGrowthTokens: hostBudgetGrowth(artifacts, read),
      policyRevisions: { artifacts, read },
      exists: workspace.exists,
    },
  );
}

/** What an approval request's `autoApproval` says about the approval reviewer, in one line. */
export function approvalReviewText(autoApproval: {
  review?: ApprovalReview;
  reviewError?: string;
}): string | null {
  if (autoApproval.reviewError)
    return `The approval reviewer could not decide (${autoApproval.reviewError}), so it waits for you.`;
  const review = autoApproval.review;
  if (!review) return null;
  return `The approval reviewer ${review.verdict === "approve" ? "would approve" : "escalated"} at ${review.risk} risk: ${review.reasons.join(" ")}`;
}

/** The policy with the approval reviewer turned on (`--approval-review`); it needs limits. */
export function withModelReview(policy: RunPolicy): RunPolicy {
  const config = policy.autoApproval;
  if (!config?.limits)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "--approval-review needs auto approval limits (workflows.policy.autoApproval.limits)",
    );
  return { ...policy, autoApproval: { ...config, modelReview: true } };
}

/**
 * Why a v2 approval stage marked human waits for a person, and how to approve automatically: the
 * project policy's `autoApproval` applies only to schema 1 workflows, so an operator who set it
 * for `sdd` would otherwise not know why a `quick` run waits.
 */
export function humanApprovalReason(workflowId: string, stageId: string): string {
  return `Stage ${stageId} of workflow ${workflowId} asks a person; the project policy's autoApproval applies only to schema 1 workflows such as sdd. To approve automatically, copy it (baked workflow define ID --from ${workflowId}), set the stage to auto, start the copy with --confirm-auto-approval HASH, and for baked quick set workflows.quickWorkflow to ID.`;
}
