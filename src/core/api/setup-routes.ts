/**
 * Project setup and settings endpoints of the local API: the known-project list, instruction
 * files, global and project config, and provider keys. The contract is `design/desktop-api.md`.
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
} from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { buildInstructionPrompt, loadInstructions } from "../instructions.js";
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
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import type { RouteContext } from "./route-context.js";

export interface SetupRouteContext extends RouteContext {
  workspace: string;
  /** The running server's config; updated in place after a config change. */
  config: AppConfig;
  /** The user configuration directory; tests point it elsewhere. */
  configDir?: string;
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
const KeyBody = z.strictObject({ key: z.string().trim().min(1).max(4096) });
const PROVIDER_KEY = /^\/v1\/providers\/([a-z0-9-]+)\/key$/;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} does not hold a JSON object`);
  return parsed as Record<string, unknown>;
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
    writeFileSync(entry.absolutePath, body.content);
    const updated = files().find((f) => f.absolutePath === entry.absolutePath);
    return ctx.json(200, updated ?? { ...entry, content: body.content });
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
        };
      }),
    });
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

/** Makes `target` equal `source` while keeping the object every reader holds. */
function replaceInPlace(target: AppConfig, source: AppConfig): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in source)) delete record[key];
  Object.assign(record, source);
}
