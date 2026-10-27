/**
 * Project setup and settings endpoints of the local API: the known-project list, instruction
 * files, global and project config, and provider keys. The contract is `docs/desktop/api.md`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadEffectiveProjectConfig,
  mergeConfigs,
} from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { agentContextPreview } from "../agent-context.js";
import {
  CustomCommandError,
  type CustomCommandScope,
  deleteCustomCommand,
  listCustomCommands,
  readCustomCommandDraft,
  saveCustomCommand,
} from "../commands/custom.js";
import {
  instructionSourceStates,
  isInstructionSource,
  listInstructionFiles,
  sha256,
  toggledInstructionSources,
  writeInstructionFile,
} from "../instruction-files.js";
import { buildInstructionPrompt, loadInstructions } from "../instructions.js";
import {
  CliLoginCodeError,
  cancelCliLogin,
  cliSignInStatus,
  getCliLogin,
  isCliLoginProvider,
  logoutCli,
  startCliLogin,
  submitCliLoginCode,
  switchCliAccount,
} from "../llm/cli-login.js";
import {
  CRITIC_MODES,
  INDEPENDENT_REVIEW_MODES,
  ROUTED_ROLES,
  RouteContext as RouteContextSchema,
  RouteEffort,
} from "../llm/model-routing.js";
import { checkProviders } from "../llm/provider.js";
import { getProviderSecretEntries } from "../llm/providers/index.js";
import { readUsageLimits } from "../llm/usage-limits.js";
import { cachedVendorModels } from "../llm/vendor-models.js";
import { listPackageSkills, type PackageSkill } from "../packages/packages.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import {
  forgetKnownProject,
  type KnownProjectOptions,
  listKnownProjects,
  renameKnownProject,
  setProjectPinned,
} from "../projects/known.js";
import { projectOverview } from "../projects/overview.js";
import { realPath } from "../projects/paths.js";
import { deleteSecret, hasSecret, type SecretKey, setSecret } from "../secrets.js";
import {
  type InstalledSkill,
  listInstalledSkills,
  removeInstalledSkill,
  type SkillCatalog,
  skillCatalog,
} from "../skills/manager.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { WorkflowFault } from "../workflows/errors.js";
import {
  explainRoute,
  independentReviewMode,
  type RouteExplanation,
} from "../workflows/routing.js";
import {
  readConfigObject,
  readRoutingLayers,
  saveRoutingChange,
} from "../workflows/routing-config.js";
import {
  type RoutingChange,
  type RoutingLayers,
  routingOverview,
} from "../workflows/routing-edit.js";
import { PolicySchema } from "../workflows/schemas.js";
import { listDefinitions } from "../workflows/v2/definitions.js";
import type { RouteContext } from "./route-context.js";

export interface SetupRouteContext extends RouteContext {
  workspace: string;
  /** The running server's config; updated in place after a config change. */
  config: AppConfig;
  /** The user configuration directory; tests point it elsewhere. */
  configDir?: string;
  /** The home directory holding global commands and skills; tests point it elsewhere. */
  homeDir?: string;
  /** The skills.sh catalog and installer; tests pass a fake one. */
  skillCatalog?: SkillCatalog;
  /** Runs that froze `absolutePath` as an input and have not ended. */
  runsFreezing(absolutePath: string): string[];
}

const PathBody = z.strictObject({ path: z.string().min(1) });
/** An empty name restores the manifest or folder name. */
const RenameBody = z.strictObject({ path: z.string().min(1), name: z.string().max(120) });
const InstructionBody = z.strictObject({
  path: z.string().min(1),
  content: z.string().max(1024 * 1024),
  /** null creates a project file at a path an instruction source reads. */
  expectedHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
const InstructionSourceBody = z.strictObject({
  source: z.string().min(1).max(64),
  enabled: z.boolean(),
  scope: z.enum(["global", "project"]).optional(),
});
const ConfigKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const ConfigBody = z
  .strictObject({
    scope: z.enum(["global", "project"]),
    set: z.record(ConfigKey, z.unknown()).optional(),
    remove: z.array(ConfigKey).max(100).optional(),
  })
  .refine((body) => Object.keys(body.set ?? {}).length > 0 || (body.remove?.length ?? 0) > 0, {
    message: "Name keys to set or remove",
  });
const RoutingQuery = z.strictObject({
  workflow: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
});
const RoutingTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("class"), name: z.string().max(64) }),
  z.strictObject({ kind: z.literal("role"), role: z.enum(ROUTED_ROLES) }),
  z.strictObject({ kind: z.literal("profile"), id: z.string().min(1).max(200) }),
  z.strictObject({
    kind: z.literal("stage"),
    workflowId: z.string().min(1).max(200),
    stageId: z.string().min(1).max(200),
  }),
]);
const RoutingBody = z.union([
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    target: RoutingTargetSchema,
    route: z
      .strictObject({
        model: z.string().max(200),
        effort: RouteEffort.nullable().optional(),
        fallback: z.array(z.string().max(200)).max(10).optional(),
        context: RouteContextSchema.nullable().optional(),
      })
      .nullable(),
    create: z.boolean().optional(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    independentReview: z.enum(INDEPENDENT_REVIEW_MODES).nullable(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    reviewMinConfidence: z.number().min(0).max(1).nullable(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    critic: z.enum(CRITIC_MODES).nullable(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    specifyOnSonnet: z.boolean().nullable(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    codeWebSearch: z.boolean().nullable(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    context: RouteContextSchema.nullable(),
  }),
]);
const SkillQuery = z.strictObject({ q: z.string().max(200).optional() });
const SkillInstallBody = z.strictObject({
  source: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/, "Send the catalog source, e.g. owner/repo"),
  skillId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/, "Send the catalog skill ID"),
  scope: z.enum(["project", "global"]),
});
const SKILL_ITEM = /^\/v1\/skills\/(project|global|package)\/([^/]+)$/;
const CommandFields = {
  name: z.string().max(200),
  description: z.string().max(400).optional(),
  argumentHint: z.string().max(200).optional(),
  body: z.string().max(64 * 1024),
};
const CommandCreateBody = z.strictObject({
  scope: z.enum(["project", "global"]),
  ...CommandFields,
});
const CommandUpdateBody = z.strictObject(CommandFields);
const COMMAND_ITEM = /^\/v1\/commands\/(project|global)\/([^/]+)$/;
const KeyBody = z.strictObject({ key: z.string().trim().min(1).max(4096) });
const PROVIDER_KEY = /^\/v1\/providers\/([a-z0-9-]+)\/key$/;
const PROVIDER_LOGIN = /^\/v1\/providers\/([a-z0-9-]+)\/(login|logout|switch)$/;
const PROVIDER_LOGIN_CODE = /^\/v1\/providers\/([a-z0-9-]+)\/login\/code$/;
const LoginCodeBody = z.strictObject({ code: z.string().trim().min(1).max(4096) });

/** Answers a setup request, or returns null when the path is not a setup endpoint. */
export async function setupRoute(ctx: SetupRouteContext): Promise<Response | null> {
  const { path, method, workspace } = ctx;
  const dir = ctx.configDir ?? defaultConfigDir();
  const known: KnownProjectOptions = ctx.configDir ? { configDir: ctx.configDir } : {};
  const globalFile = join(dir, "config.json");
  const projectFile = join(workspace, ".baked", "config.json");
  const instructionFiles = () =>
    listInstructionFiles(
      workspace,
      ctx.config.instructionFiles,
      ctx.homeDir ? { homeDir: ctx.homeDir } : {},
    );
  /** The config file that sets `instructionFiles`: the project's when it does, else the global one. */
  const instructionScope = (): "global" | "project" => {
    const has = (file: string) => {
      try {
        return Array.isArray(readConfigObject(file).instructionFiles);
      } catch {
        return false;
      }
    };
    return has(projectFile) || !has(globalFile) ? "project" : "global";
  };
  const instructionList = () => ({
    files: instructionFiles(),
    sources: instructionSourceStates(ctx.config.instructionFiles),
    sourcesScope: instructionScope(),
    promptBytes: Buffer.byteLength(
      buildInstructionPrompt(
        loadInstructions(
          workspace,
          ctx.config.instructionFiles,
          ctx.homeDir ? { homeDir: ctx.homeDir } : {},
        ),
      ),
    ),
  });

  if (
    path === "/v1/projects/pin" ||
    path === "/v1/projects/unpin" ||
    path === "/v1/projects/forget" ||
    path === "/v1/projects/rename"
  ) {
    ctx.only("POST");
    const raw = await ctx.readJson();
    const rename = path.endsWith("/rename") ? RenameBody.parse(raw) : null;
    const body = rename ?? PathBody.parse(raw);
    if (!isAbsolute(body.path)) ctx.fail(400, "INVALID_REQUEST", "Send the absolute folder path");
    const listed = listKnownProjects(known).some((p) => p.path === realPath(body.path));
    if (!listed) ctx.fail(404, "NOT_FOUND", `${body.path} is not a known project`);
    if (rename) renameKnownProject(rename.path, rename.name, known);
    else if (path.endsWith("forget")) forgetKnownProject(body.path, known);
    else setProjectPinned(body.path, path.endsWith("/pin"), known);
    const here = realPath(workspace);
    return ctx.json(200, {
      projects: listKnownProjects(known).map((project) => ({
        ...project,
        current: project.path === here,
        overview: projectOverview(project.path),
      })),
    });
  }

  if (path === "/v1/projects/current/instructions") {
    ctx.only("GET", "PUT");
    if (method === "GET") return ctx.json(200, instructionList());
    const body = InstructionBody.parse(await ctx.readJson());
    const written = writeInstructionFile(
      workspace,
      instructionFiles(),
      body.path,
      body.content,
      body.expectedHash,
    );
    if (written.status === "unknown") ctx.fail(404, "NOT_FOUND", written.message);
    if (written.status === "changed") ctx.fail(409, "INPUT_CHANGED", written.message);
    const affectedRuns = ctx.runsFreezing(written.absolutePath);
    const updated = instructionFiles().find((f) => f.absolutePath === written.absolutePath);
    // An emptied file is no longer listed: agents skip empty instruction files.
    return ctx.json(200, {
      ...(updated ?? {
        order: null,
        path: body.path,
        absolutePath: written.absolutePath,
        source: "",
        sourceLabel: "",
        scope: "project",
        enabled: false,
        bytes: Buffer.byteLength(body.content),
        hash: sha256(body.content),
        content: body.content,
      }),
      affectedRuns,
    });
  }

  if (path === "/v1/projects/current/instructions/sources") {
    ctx.only("PUT");
    const body = InstructionSourceBody.parse(await ctx.readJson());
    if (!isInstructionSource(body.source))
      ctx.fail(404, "NOT_FOUND", `${body.source} is not an instruction source`);
    const scope = body.scope ?? instructionScope();
    const file = scope === "global" ? globalFile : projectFile;
    let current: Record<string, unknown>;
    try {
      current = readConfigObject(file);
    } catch (error) {
      return ctx.fail(409, "INPUT_CHANGED", error instanceof Error ? error.message : String(error));
    }
    const layer = Array.isArray(current.instructionFiles)
      ? (current.instructionFiles as string[])
      : ctx.config.instructionFiles;
    const next = {
      ...current,
      instructionFiles: toggledInstructionSources(layer, body.source, body.enabled),
    };
    if (scope === "global") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else ensurebakedDir(workspace);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    // Only instructionFiles changed; the rest of the running config stays as it is.
    const effective = mergeConfigs(
      ctx.configDir
        ? ({ ...DEFAULT_CONFIG, ...readConfigObject(globalFile) } as AppConfig)
        : loadConfig(),
      loadEffectiveProjectConfig(workspace),
    );
    ctx.config.instructionFiles = effective.instructionFiles;
    return ctx.json(200, instructionList());
  }

  if (path === "/v1/projects/current/context") {
    ctx.only("GET");
    return ctx.json(
      200,
      agentContextPreview(
        workspace,
        ctx.config.instructionFiles,
        ctx.homeDir ? { homeDir: ctx.homeDir } : {},
      ),
    );
  }

  const commandHome = ctx.homeDir ? { home: ctx.homeDir } : {};
  const commandList = () => ({
    commands: listCustomCommands(workspace, commandHome).map((command) => ({
      name: command.name,
      scope: command.scope,
      path: command.path,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })),
  });
  /** Runs a command write; a rejected name or a missing command answers with its status. */
  const commandWrite = <T>(write: () => T): T => {
    try {
      return write();
    } catch (error) {
      if (!(error instanceof CustomCommandError)) throw error;
      return ctx.fail(
        error.status,
        error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "INVALID_COMMAND",
        error.message,
      );
    }
  };

  if (path === "/v1/commands") {
    ctx.only("GET", "POST");
    if (method === "GET") return ctx.json(200, commandList());
    const { scope, ...draft } = CommandCreateBody.parse(await ctx.readJson());
    const command = commandWrite(() => saveCustomCommand(workspace, scope, draft, commandHome));
    return ctx.json(201, {
      command: { name: command.name, scope, path: command.path },
      ...commandList(),
    });
  }

  const commandItem = COMMAND_ITEM.exec(path);
  if (commandItem) {
    ctx.only("GET", "PUT", "DELETE");
    const scope = commandItem[1] as CustomCommandScope;
    let name = commandItem[2] ?? "";
    try {
      name = decodeURIComponent(name);
    } catch {}
    if (method === "GET")
      return ctx.json(200, {
        scope,
        ...commandWrite(() => readCustomCommandDraft(workspace, scope, name, commandHome)),
      });
    if (method === "DELETE") {
      commandWrite(() => deleteCustomCommand(workspace, scope, name, commandHome));
      return ctx.json(200, commandList());
    }
    const draft = CommandUpdateBody.parse(await ctx.readJson());
    const command = commandWrite(() =>
      saveCustomCommand(workspace, scope, draft, { ...commandHome, previous: name }),
    );
    return ctx.json(200, {
      command: { name: command.name, scope, path: command.path },
      ...commandList(),
    });
  }

  const skillDirs = { cwd: workspace, ...(ctx.homeDir ? { home: ctx.homeDir } : {}) };
  // Package skills follow the project and global ones; they cannot be removed one by one.
  const installedSkills = () => [
    ...listInstalledSkills(skillDirs)
      .map(skillEntry)
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...listPackageSkills(workspace).map((skill) => ({
      ...skillEntry(skill),
      package: skill.package,
    })),
  ];

  if (path === "/v1/skills") {
    ctx.only("GET", "POST");
    if (method === "GET") return ctx.json(200, { skills: installedSkills() });
    const body = SkillInstallBody.parse(await ctx.readJson());
    const catalog = ctx.skillCatalog ?? skillCatalog;
    let result: Awaited<ReturnType<SkillCatalog["install"]>>;
    try {
      result = await catalog.install(body.source, body.skillId, body.scope === "global", skillDirs);
    } catch (error) {
      result = { installed: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!result.installed)
      ctx.fail(422, "INSTALL_FAILED", result.error ?? `${body.skillId} was not installed`);
    const skills = installedSkills();
    return ctx.json(200, { skill: skills.find((s) => s.id === result.name) ?? null, skills });
  }

  if (path === "/v1/skills/catalog") {
    ctx.only("GET");
    const { q } = ctx.query(SkillQuery);
    const catalog = ctx.skillCatalog ?? skillCatalog;
    try {
      const found = await catalog.search(q ?? "");
      return ctx.json(200, {
        skills: found.map((skill) => ({
          id: skill.id,
          skillId: skill.skillId,
          name: skill.name,
          source: skill.source,
          installs: skill.installs,
        })),
      });
    } catch (error) {
      ctx.fail(
        502,
        "CATALOG_UNAVAILABLE",
        `The skills.sh catalog did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const skillItem = SKILL_ITEM.exec(path);
  if (skillItem) {
    ctx.only("GET", "DELETE");
    const scope = skillItem[1] as InstalledSkill["scope"] | PackageSkill["scope"];
    let name = skillItem[2] ?? "";
    try {
      name = decodeURIComponent(name);
    } catch {}
    if (scope === "package") {
      const skill = listPackageSkills(workspace).find((s) => s.name === name);
      if (!skill) ctx.fail(404, "NOT_FOUND", `No installed package has a skill named ${name}`);
      if (method === "DELETE")
        ctx.fail(
          409,
          "NOT_REMOVABLE",
          `${name} belongs to the package ${skill.package}; remove the package to remove it`,
        );
      const content = readFileSync(skill.path, "utf8");
      return ctx.json(200, {
        ...skillEntry(skill),
        package: skill.package,
        content: content.slice(0, 256 * 1024),
      });
    }
    const skill = listInstalledSkills(skillDirs).find((s) => s.name === name && s.scope === scope);
    if (!skill) ctx.fail(404, "NOT_FOUND", `No ${scope} skill named ${name} is installed`);
    if (method === "GET") {
      const content = readFileSync(skill.path, "utf8");
      return ctx.json(200, { ...skillEntry(skill), content: content.slice(0, 256 * 1024) });
    }
    if (!removeInstalledSkill(skill))
      ctx.fail(
        409,
        "NOT_REMOVABLE",
        `${skill.path} is not in its own skill folder; remove it by hand`,
      );
    return ctx.json(200, { skills: installedSkills() });
  }

  if (path === "/v1/config") {
    ctx.only("GET", "PATCH");
    const read = () => {
      const global = readConfigObject(globalFile);
      const project = readConfigObject(projectFile);
      const base = ctx.configDir ? ({ ...DEFAULT_CONFIG, ...global } as AppConfig) : loadConfig();
      const effective = mergeConfigs(base, loadEffectiveProjectConfig(workspace));
      return { global, project, effective, paths: { global: globalFile, project: projectFile } };
    };
    if (method === "GET") return ctx.json(200, read());
    const body = ConfigBody.parse(await ctx.readJson());
    const file = body.scope === "global" ? globalFile : projectFile;
    let current: Record<string, unknown>;
    try {
      current = readConfigObject(file);
    } catch (error) {
      return ctx.fail(409, "INPUT_CHANGED", error instanceof Error ? error.message : String(error));
    }
    const next = { ...current, ...(body.set ?? {}) };
    for (const key of body.remove ?? []) delete next[key];
    if (body.scope === "global") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else ensurebakedDir(workspace);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    const result = read();
    replaceInPlace(ctx.config, result.effective);
    return ctx.json(200, result);
  }

  if (path === "/v1/workflow/routing") {
    ctx.only("GET", "PATCH");
    const effectiveConfig = (): AppConfig => {
      const base = ctx.configDir
        ? ({ ...DEFAULT_CONFIG, ...readConfigObject(globalFile) } as AppConfig)
        : loadConfig();
      return mergeConfigs(base, loadEffectiveProjectConfig(workspace));
    };
    const layersOf = (): RoutingLayers =>
      readRoutingLayers({ global: globalFile, project: projectFile });
    // Routes resolve with the config the server starts runs with.
    const overview = (workflow: string | undefined, model: string | undefined) => {
      const config = ctx.config;
      const policy = PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy);
      const workflows = listDefinitions(workspace, policy).map((d) => d.id);
      const workflowId = workflow ?? (workflows.includes("sdd") ? "sdd" : (workflows[0] ?? null));
      let explanation: RouteExplanation | null = null;
      let error: string | null = workflowId ? null : "No workflow definitions found";
      if (workflowId)
        try {
          explanation = explainRoute(workspace, config, {
            workflowId,
            model,
            availableModels: cachedVendorModels(),
          });
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
      const runModel = model ?? config.defaultModel;
      return routingOverview({
        layers: layersOf(),
        workflows,
        workflowId,
        runModel: runModel?.trim() && runModel.trim() !== "none" ? runModel : null,
        legacy: {
          coding: config.taskRouter?.ember ?? config.taskRouter?.coding ?? undefined,
          review: config.taskRouter?.verify ?? undefined,
        },
        explanation,
        error,
        reviewMode: independentReviewMode(config),
      });
    };
    if (method === "GET") {
      const query = ctx.query(RoutingQuery);
      return ctx.json(200, overview(query.workflow, query.model));
    }
    const body = RoutingBody.parse(await ctx.readJson());
    const change: RoutingChange =
      "independentReview" in body
        ? { independentReview: body.independentReview }
        : "reviewMinConfidence" in body
          ? { reviewMinConfidence: body.reviewMinConfidence }
          : "critic" in body
            ? { critic: body.critic }
            : "specifyOnSonnet" in body
              ? { specifyOnSonnet: body.specifyOnSonnet }
              : "codeWebSearch" in body
                ? { codeWebSearch: body.codeWebSearch }
                : "context" in body
                  ? { context: body.context }
                  : {
                      target: body.target,
                      route: body.route && {
                        model: body.route.model,
                        effort: body.route.effort ?? null,
                        fallback: body.route.fallback ?? [],
                        context: body.route.context ?? null,
                      },
                      ...(body.create ? { create: true } : {}),
                    };
    let problems: string[];
    try {
      ({ problems } = saveRoutingChange(
        workspace,
        { global: globalFile, project: projectFile },
        body.scope,
        change,
      ));
    } catch (error) {
      if (error instanceof WorkflowFault && error.code === "INPUT_CHANGED")
        return ctx.fail(409, "INPUT_CHANGED", error.message);
      throw error;
    }
    if (problems.length)
      return ctx.json(422, {
        error: { code: "ROUTING_REFUSED", message: problems.join("; ") },
        problems,
      });
    // Only modelRouting changed; the rest of the running config stays as it is.
    const merged = effectiveConfig().modelRouting;
    ctx.config.modelRouting = merged;
    return ctx.json(200, overview(body.workflow, body.model));
  }

  if (path === "/v1/providers/limits") {
    ctx.only("GET");
    return ctx.json(200, { limits: await readUsageLimits() });
  }
  if (path === "/v1/providers") {
    ctx.only("GET");
    const secrets = new Map(getProviderSecretEntries().map((e) => [e.providerId, e]));
    const statuses = await checkProviders();
    return ctx.json(200, {
      providers: statuses.map((status) => {
        const secret = secrets.get(status.id);
        const source = secret ? hasSecret(secret.secretKey as SecretKey).source : "none";
        return {
          id: status.id,
          name: status.name,
          configured: status.available,
          acceptsKey: Boolean(secret),
          source: status.detected
            ? "detected"
            : source === "none"
              ? null
              : source === "env"
                ? "env"
                : "app",
          ...(status.detected ? { detectedFrom: status.detected } : {}),
          ...(secret?.keyUrl ? { keyUrl: secret.keyUrl } : {}),
          ...(isCliLoginProvider(status.id)
            ? { signIn: { ...cliSignInStatus(status.id), login: getCliLogin(status.id) } }
            : {}),
        };
      }),
    });
  }
  const codeMatch = PROVIDER_LOGIN_CODE.exec(path);
  if (codeMatch?.[1]) {
    const id = codeMatch[1];
    if (!isCliLoginProvider(id))
      ctx.fail(404, "NOT_FOUND", `Provider ${id} does not sign in through a CLI`);
    ctx.only("POST");
    const body = LoginCodeBody.parse(await ctx.readJson());
    try {
      return ctx.json(202, { login: submitCliLoginCode(id, body.code) });
    } catch (error) {
      if (error instanceof CliLoginCodeError) ctx.fail(409, "CONFLICT", error.message);
      throw error;
    }
  }
  const loginMatch = PROVIDER_LOGIN.exec(path);
  if (loginMatch?.[1]) {
    const id = loginMatch[1];
    if (!isCliLoginProvider(id))
      ctx.fail(404, "NOT_FOUND", `Provider ${id} does not sign in through a CLI`);
    if (loginMatch[2] === "logout") {
      ctx.only("POST");
      return ctx.json(200, await logoutCli(id));
    }
    if (loginMatch[2] === "switch") {
      ctx.only("POST");
      const result = await switchCliAccount(id);
      return ctx.json(result.login ? 202 : 200, result);
    }
    ctx.only("GET", "POST", "DELETE");
    if (method === "POST") return ctx.json(202, { login: startCliLogin(id) });
    if (method === "DELETE") return ctx.json(200, { login: await cancelCliLogin(id) });
    return ctx.json(200, { login: getCliLogin(id) });
  }
  const keyMatch = PROVIDER_KEY.exec(path);
  if (keyMatch?.[1]) {
    ctx.only("PUT", "DELETE");
    const entry = getProviderSecretEntries().find((e) => e.providerId === keyMatch[1]);
    if (!entry) ctx.fail(404, "NOT_FOUND", `Provider ${keyMatch[1]} does not take an API key`);
    const key = entry.secretKey as SecretKey;
    if (method === "DELETE") {
      deleteSecret(key);
      return new Response(null, { status: 204 });
    }
    const body = KeyBody.parse(await ctx.readJson());
    const result = setSecret(key, body.key);
    return ctx.json(200, { configured: result.success, storage: result.storage });
  }
  return null;
}

/** The `description` of a SKILL.md front matter, if it has one. */
function skillEntry(skill: InstalledSkill | PackageSkill) {
  const description = skillDescription(skill.path);
  return {
    id: skill.name,
    scope: skill.scope,
    path: skill.path,
    ...(description ? { description } : {}),
  };
}

function skillDescription(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8").slice(0, 8192);
  } catch {
    return undefined;
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const line = front?.split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  const value = line
    ?.replace(/^description\s*:\s*/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
  return value ? value : undefined;
}

/** Makes `target` equal `source` while keeping the object every reader holds. */
export function replaceInPlace(target: AppConfig, source: AppConfig): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in source)) delete record[key];
  Object.assign(record, source);
}
