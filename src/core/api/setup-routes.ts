/**
 * Project setup and settings endpoints of the local API: the known-project list, instruction
 * files, global and project config, and provider keys. The contract is `docs/desktop/api.md`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadEffectiveProjectConfig,
  mergeConfigs,
  migrateLegacyConfigKeys,
} from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { listCustomCommands } from "../commands/custom.js";
import { buildInstructionPrompt, loadInstructions } from "../instructions.js";
import {
  cancelCliLogin,
  cliSignInStatus,
  getCliLogin,
  isCliLoginProvider,
  logoutCli,
  startCliLogin,
} from "../llm/cli-login.js";
import { type ModelRouting, ROUTED_ROLES, RouteEffort } from "../llm/model-routing.js";
import { checkProviders } from "../llm/provider.js";
import { getProviderSecretEntries } from "../llm/providers/index.js";
import { configDir as defaultConfigDir } from "../platform/index.js";
import {
  forgetKnownProject,
  type KnownProjectOptions,
  listKnownProjects,
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
import { explainRoute, type RouteExplanation } from "../workflows/routing.js";
import {
  applyRoutingChange,
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
const InstructionBody = z.strictObject({
  path: z.string().min(1),
  content: z.string().max(1024 * 1024),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
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
      })
      .nullable(),
    create: z.boolean().optional(),
  }),
  z.strictObject({
    scope: z.enum(["global", "project"]),
    workflow: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    independentReview: z.enum(["off", "warn", "require"]).nullable(),
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
const SKILL_ITEM = /^\/v1\/skills\/(project|global)\/([^/]+)$/;
const KeyBody = z.strictObject({ key: z.string().trim().min(1).max(4096) });
const PROVIDER_KEY = /^\/v1\/providers\/([a-z0-9-]+)\/key$/;
const PROVIDER_LOGIN = /^\/v1\/providers\/([a-z0-9-]+)\/(login|logout)$/;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Reads a config file, with legacy keys under their current names. */
function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} does not hold a JSON object`);
  return migrateLegacyConfigKeys(parsed as Record<string, unknown>);
}

/** Answers a setup request, or returns null when the path is not a setup endpoint. */
export async function setupRoute(ctx: SetupRouteContext): Promise<Response | null> {
  const { path, method, workspace } = ctx;
  const dir = ctx.configDir ?? defaultConfigDir();
  const known: KnownProjectOptions = ctx.configDir ? { configDir: ctx.configDir } : {};
  const globalFile = join(dir, "config.json");
  const projectFile = join(workspace, ".baked", "config.json");

  if (
    path === "/v1/projects/pin" ||
    path === "/v1/projects/unpin" ||
    path === "/v1/projects/forget"
  ) {
    ctx.only("POST");
    const body = PathBody.parse(await ctx.readJson());
    if (!isAbsolute(body.path)) ctx.fail(400, "INVALID_REQUEST", "Send the absolute folder path");
    const listed = listKnownProjects(known).some((p) => p.path === realPath(body.path));
    if (!listed) ctx.fail(404, "NOT_FOUND", `${body.path} is not a known project`);
    if (path.endsWith("forget")) forgetKnownProject(body.path, known);
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
    const files = () =>
      loadInstructions(workspace, ctx.config.instructionFiles).map((entry, index) => {
        const absolute = resolve(entry.scope === "project" ? workspace : homedir(), entry.file);
        const bytes = readFileSync(absolute);
        return {
          order: index + 1,
          path: entry.file,
          absolutePath: absolute,
          source: entry.source,
          scope: entry.scope,
          bytes: bytes.byteLength,
          hash: sha256(bytes),
          content: bytes.toString("utf8"),
        };
      });
    if (method === "GET") {
      const list = files();
      return ctx.json(200, {
        files: list,
        promptBytes: Buffer.byteLength(
          buildInstructionPrompt(loadInstructions(workspace, ctx.config.instructionFiles)),
        ),
      });
    }
    const body = InstructionBody.parse(await ctx.readJson());
    const list = files();
    const entry =
      list.find((f) => f.path === body.path && f.scope === "project") ??
      list.find((f) => f.path === body.path);
    if (!entry)
      ctx.fail(404, "NOT_FOUND", `${body.path} is not one of the instruction files agents read`);
    if (entry.hash !== body.expectedHash)
      ctx.fail(409, "INPUT_CHANGED", `${body.path} changed since it was read; read it again`);
    const affectedRuns = ctx.runsFreezing(entry.absolutePath);
    writeFileSync(entry.absolutePath, body.content);
    const updated = files().find((f) => f.absolutePath === entry.absolutePath);
    return ctx.json(200, { ...(updated ?? { ...entry, content: body.content }), affectedRuns });
  }

  if (path === "/v1/commands") {
    ctx.only("GET");
    return ctx.json(200, {
      commands: listCustomCommands(workspace, ctx.homeDir ? { home: ctx.homeDir } : {}).map(
        (command) => ({
          name: command.name,
          scope: command.scope,
          path: command.path,
          description: command.description,
          ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
        }),
      ),
    });
  }

  const skillDirs = { cwd: workspace, ...(ctx.homeDir ? { home: ctx.homeDir } : {}) };
  const installedSkills = () =>
    listInstalledSkills(skillDirs)
      .map(skillEntry)
      .sort((a, b) => a.id.localeCompare(b.id));

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
    const scope = skillItem[1] as InstalledSkill["scope"];
    let name = skillItem[2] ?? "";
    try {
      name = decodeURIComponent(name);
    } catch {}
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
      const global = readJsonFile(globalFile);
      const project = readJsonFile(projectFile);
      const base = ctx.configDir ? ({ ...DEFAULT_CONFIG, ...global } as AppConfig) : loadConfig();
      const effective = mergeConfigs(base, loadEffectiveProjectConfig(workspace));
      return { global, project, effective, paths: { global: globalFile, project: projectFile } };
    };
    if (method === "GET") return ctx.json(200, read());
    const body = ConfigBody.parse(await ctx.readJson());
    const file = body.scope === "global" ? globalFile : projectFile;
    let current: Record<string, unknown>;
    try {
      current = readJsonFile(file);
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
        ? ({ ...DEFAULT_CONFIG, ...readJsonFile(globalFile) } as AppConfig)
        : loadConfig();
      return mergeConfigs(base, loadEffectiveProjectConfig(workspace));
    };
    const layersOf = (): RoutingLayers => ({
      global: readJsonFile(globalFile).modelRouting as ModelRouting | undefined,
      project: readJsonFile(projectFile).modelRouting as ModelRouting | undefined,
    });
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
          explanation = explainRoute(workspace, config, { workflowId, model });
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
      });
    };
    if (method === "GET") {
      const query = ctx.query(RoutingQuery);
      return ctx.json(200, overview(query.workflow, query.model));
    }
    const body = RoutingBody.parse(await ctx.readJson());
    const file = body.scope === "global" ? globalFile : projectFile;
    let current: Record<string, unknown>;
    try {
      current = readJsonFile(file);
    } catch (error) {
      return ctx.fail(409, "INPUT_CHANGED", error instanceof Error ? error.message : String(error));
    }
    const change: RoutingChange =
      "independentReview" in body
        ? { independentReview: body.independentReview }
        : {
            target: body.target,
            route: body.route && {
              model: body.route.model,
              effort: body.route.effort ?? null,
              fallback: body.route.fallback ?? [],
            },
            ...(body.create ? { create: true } : {}),
          };
    const { routing, problems } = applyRoutingChange(layersOf(), body.scope, change);
    if (problems.length)
      return ctx.json(422, {
        error: { code: "ROUTING_REFUSED", message: problems.join("; ") },
        problems,
      });
    const { modelRouting: _previous, ...rest } = current;
    const next = routing ? { ...current, modelRouting: routing } : rest;
    if (body.scope === "global") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else ensurebakedDir(workspace);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    // Only modelRouting changed; the rest of the running config stays as it is.
    const merged = effectiveConfig().modelRouting;
    ctx.config.modelRouting = merged;
    return ctx.json(200, overview(body.workflow, body.model));
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
          source: source === "none" ? null : source === "env" ? "env" : "app",
          ...(secret?.keyUrl ? { keyUrl: secret.keyUrl } : {}),
          ...(isCliLoginProvider(status.id)
            ? { signIn: { ...cliSignInStatus(status.id), login: getCliLogin(status.id) } }
            : {}),
        };
      }),
    });
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
function skillEntry(skill: InstalledSkill) {
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
function replaceInPlace(target: AppConfig, source: AppConfig): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in source)) delete record[key];
  Object.assign(record, source);
}
