#!/usr/bin/env bun

globalThis.AI_SDK_LOG_WARNINGS = false;

// Map legacy `baked_*` environment variables before any module reads them.
import "./core/legacy-env.js";
// Reap orphaned LSP processes from previous sessions BEFORE anything else.
// Synchronous so a crashed-during-boot run still cleans up its predecessors.
import { reapOrphanedLspProcesses } from "./core/intelligence/backends/lsp/pid-tracker.js";
// Replace Bun's native fetch with undici before any provider/module loads.
// See src/core/llm/http-agent.ts for rationale.
import { installGlobalFetch } from "./core/llm/http-agent.js";
// Self-heal the per-user data dir from `deps/` sibling to the .exe.
// No-op when running from source or as `dist/index.js` under bun.
import { hydrateCompiledRuntime } from "./core/utils/hydrate-runtime.js";

installGlobalFetch();
reapOrphanedLspProcesses();
hydrateCompiledRuntime();

const cliArgs = process.argv.slice(2);

// Honour --cwd before any module reads process.cwd(). One process = one cwd:
// every downstream consumer (config, repo map / Baked map, intelligence,
// memory, all tools) inherits it for free via process.cwd().
resolveCwdFromArgv(cliArgs);

if (cliArgs[0] === "workflow" || cliArgs[0] === "doctor" || cliArgs[0] === "quick") {
  const { runWorkflowCli } = await import("./headless/workflow.js");
  // `baked doctor` and `baked quick TEXT` are short for `baked workflow doctor` and `quick TEXT`.
  process.exit(await runWorkflowCli(cliArgs[0] === "workflow" ? cliArgs.slice(1) : cliArgs));
}

if (cliArgs[0] === "telemetry") {
  const { runTelemetryCli } = await import("./core/telemetry.js");
  process.exit(await runTelemetryCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "projects") {
  const { runProjectsCli } = await import("./headless/projects.js");
  process.exit(await runProjectsCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "project") {
  const { runProjectCli } = await import("./headless/project.js");
  process.exit(await runProjectCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "mcp") {
  const { runMcpCli } = await import("./headless/mcp.js");
  process.exit(await runMcpCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "lsp") {
  const { runLspCli } = await import("./headless/lsp.js");
  process.exit(await runLspCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "session") {
  const { runSessionCli } = await import("./headless/session.js");
  process.exit(await runSessionCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "usage" || cliArgs[0] === "attention") {
  const { runAttentionCli, runUsageCli } = await import("./headless/overview.js");
  const run = cliArgs[0] === "usage" ? runUsageCli : runAttentionCli;
  process.exit(await run(cliArgs.slice(1)));
}

if (cliArgs[0] === "login" || cliArgs[0] === "logout") {
  const { runLoginCli } = await import("./headless/login.js");
  process.exit(await runLoginCli(cliArgs[0], cliArgs.slice(1)));
}

if (cliArgs[0] === "serve") {
  const { runServeCli } = await import("./headless/serve.js");
  process.exit(await runServeCli(cliArgs.slice(1)));
}

if (cliArgs[0] === "self-check") {
  const { runSelfCheck } = await import("./headless/self-check.js");
  process.exit(await runSelfCheck());
}

const hasCli =
  cliArgs.includes("--headless") ||
  cliArgs.includes("--list-providers") ||
  cliArgs.includes("--list-models") ||
  cliArgs.includes("--set-key") ||
  cliArgs.includes("--remove-key") ||
  cliArgs.includes("--version") ||
  cliArgs.includes("-v") ||
  cliArgs.includes("--help") ||
  cliArgs.includes("-h");

if (hasCli) {
  const { parseHeadlessArgs, runHeadless } = await import("./headless/index.js");
  const action = await parseHeadlessArgs(cliArgs);
  if (action) await runHeadless(action);
  process.exit(0);
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists, configDir, dataDir, isCompiledBinary } from "./core/platform/index.js";

const IS_COMPILED = isCompiledBinary(import.meta.url);
if (IS_COMPILED) {
  const bundledWorker = join(dataDir(), "opentui-assets", "parser.worker.js");
  if (!process.env.OTUI_TREE_SITTER_WORKER_PATH && existsSync(bundledWorker)) {
    process.env.OTUI_TREE_SITTER_WORKER_PATH = bundledWorker;
  }
}

import { getCwd } from "./core/cwd.js";
import { applyTheme, getThemeTokens } from "./core/theme/index.js";
import { supportsTruecolor } from "./core/utils/bake-art.js";
import { BOOT_SPLASH_PAINTER, bootSplashFrames } from "./core/utils/boot-splash.js";
import { reducedMotion, setMotion } from "./core/utils/motion.js";
import { resolveCwdFromArgv } from "./core/utils/resolve-cwd.js";
import { logBackgroundError } from "./stores/errors.js";

// Sync-load theme name from config before React mounts
try {
  const raw = readFileSync(join(configDir(), "config.json"), "utf-8");
  const cfg = JSON.parse(raw);
  setMotion(cfg.motion);
  if (cfg.theme?.name)
    applyTheme(cfg.theme.name, cfg.theme?.transparent, {
      userMessageOpacity: cfg.theme?.userMessageOpacity,
      diffOpacity: cfg.theme?.diffOpacity,
      borderStrength: cfg.theme?.borderStrength,
    });
} catch {
  applyTheme("dark", false);
}

const cols = process.stdout.columns ?? 80;
const rows = process.stdout.rows ?? 24;

// ── Boot splash: the BAKED slab and dough that rises with startup progress ──
// A child process paints it because this thread is blocked on module imports. Frames are
// pre-rendered here and sent over stdin, so the painter only picks which one to show.

function killSpinner(): void {
  try {
    spinnerProc?.kill();
  } catch {}
}
process.on("exit", killSpinner);
process.on("SIGINT", killSpinner);
process.on("SIGTERM", killSpinner);

const spinnerProc = Bun.spawn([process.execPath, "-e", BOOT_SPLASH_PAINTER], {
  stdin: "pipe",
  stdout: "inherit",
  stderr: "ignore",
  env: { ...process.env, BUN_BE_BUN: "1" },
  windowsHide: true,
});

process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
spinnerProc.stdin.write(
  `${JSON.stringify(
    bootSplashFrames(cols, rows, getThemeTokens(), {
      reduced: reducedMotion(),
      truecolor: supportsTruecolor(),
    }),
  )}\n`,
);

/** Reports a startup step; `progress` runs from 0 to 1 and never moves back. */
function status(progress: number, ...msgs: string[]): void {
  spinnerProc.stdin.write(`${JSON.stringify([progress, ...msgs])}\n`);
}

function stopSpinner(): void {
  spinnerProc.stdin.write("EXIT\n");
  spinnerProc.stdin.end();
  // Remove early-boot signal handlers — index.tsx takes over cleanup from here.
  process.removeListener("exit", killSpinner);
  process.removeListener("SIGINT", killSpinner);
  process.removeListener("SIGTERM", killSpinner);
}

const earlyModules = Promise.all([
  import("./config/index.js"),
  import("./core/icons.js"),
  import("./core/setup/install.js"),
]);

// App.tsx pulls in the entire tool/hook/AI SDK module graph (~3s).
// Kick it off here so the spinner (child process) shows progress.

status(0.05, "Loading BAKED");
const appReady = import("./components/App.js");
const [configMod, , installMod] = await earlyModules;

const { loadConfig, loadEffectiveProjectConfig } = configMod;

const { getVendoredPath, installRipgrep, installFd, installAstGrep } = installMod;

let resumeSessionId: string | undefined;
let forceWizard = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--session" || arg === "--resume" || arg === "-s") {
    resumeSessionId = args[i + 1];
    i++;
  } else if (arg?.startsWith("--session=")) {
    resumeSessionId = arg.slice("--session=".length);
  } else if (arg?.startsWith("--resume=")) {
    resumeSessionId = arg.slice("--resume=".length);
  } else if (arg === "--wizard") {
    forceWizard = true;
  }
}

status(0.2, "Reading settings");
// The project list behind the project picker; a failed write never blocks startup.
import("./core/projects/known.js")
  .then(({ recordProjectOpen }) => recordProjectOpen(getCwd()))
  .catch(() => {});
// Sets up the opened folder as a project before settings are read, keeping existing files.
{
  const { scaffoldProjectQuietly } = await import("./core/projects/scaffold.js");
  scaffoldProjectQuietly(getCwd());
}
const config = loadConfig();
const projectConfig = loadEffectiveProjectConfig(getCwd());

{
  const priority = projectConfig?.keyPriority ?? config.keyPriority;
  if (priority) {
    const { setDefaultKeyPriority } = await import("./core/secrets.js");
    setDefaultKeyPriority(priority);
  }
}

{
  // Sync provider secret keys into the secrets system (single source of truth)
  const { getProviderSecretEntries } = await import("./core/llm/providers/index.js");
  const { registerProviderSecrets } = await import("./core/secrets.js");
  registerProviderSecrets(getProviderSecretEntries());
}

// Pre-init ContextManager async — yields between heavy sync steps so the spinner stays alive.
const repoMapEnabled = (projectConfig?.repoMap ?? config.repoMap) !== false;
const contextManagerReady = import("./core/context/manager.js").then(({ ContextManager }) =>
  ContextManager.createAsync(getCwd(), (step) => status(0.35, step), { repoMapEnabled }),
);

if (!getVendoredPath("rg")) {
  status(0.4, "Installing ripgrep");
  installRipgrep().catch((err) => {
    logBackgroundError(
      "boot",
      `ripgrep install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

if (!getVendoredPath("fd")) {
  status(0.45, "Installing fd");
  installFd().catch((err) => {
    logBackgroundError(
      "boot",
      `fd install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

// ast-grep powers structural_edit (polyglot AST edits) — a first-class edit
// tool, so vendor it eagerly like rg/fd. Skipped if a system copy is on PATH.
if (!getVendoredPath("ast-grep") && !commandExists("ast-grep") && !commandExists("sg")) {
  status(0.5, "Installing ast-grep");
  installAstGrep().catch((err) => {
    logBackgroundError(
      "boot",
      `ast-grep install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

status(0.55, "Checking providers and keys");
const { checkProviders, notifyProviderSwitch } = await import("./core/llm/provider.js");
const { checkPrerequisites } = await import("./core/setup/prerequisites.js");
const { prewarmAllModels } = await import("./core/llm/models.js");
const [bootProviders, bootPrereqs] = await Promise.all([
  checkProviders(),
  Promise.resolve(checkPrerequisites()),
]);
{
  const bootModel = projectConfig?.defaultModel ?? config.defaultModel;
  if (bootModel && bootModel !== "none") {
    notifyProviderSwitch(bootModel).catch((err) => {
      logBackgroundError(
        "boot",
        `provider activation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
// Fire-and-forget — populates caches in background so Ctrl+L opens instantly.
prewarmAllModels();

// Fire-and-forget — keep a long-lived PowerShell process ready to serve
// clipboard image reads via stdin/stdout. After the one-time ~500-1500ms
// boot startup, each Ctrl+V image paste is ~50-200ms (just GetImage +
// PNG encode), not the 2-3s spawn-per-paste cost. On non-Windows no-op.
{
  const { startClipboardDaemon } = await import("./core/platform/clipboard.js");
  startClipboardDaemon();
}

status(0.7, "Warming up code intelligence");
// Ensure setIntelligenceClient() has run before warmup to avoid spawning
// duplicate LSP servers on both main thread and worker.
contextManagerReady
  .then(() => import("./core/intelligence/index.js"))
  .then(({ warmupIntelligence }) => warmupIntelligence(getCwd(), config.codeIntelligence))
  .catch((err) => {
    logBackgroundError(
      "boot",
      `intelligence warmup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

status(0.8, "Loading the interface", "Almost baked");
const [{ App }, contextManager] = await Promise.all([appReady, contextManagerReady]);
// Instant — App.tsx already pulled these into the module cache
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { start } = await import("./index.js");

status(1, "Ready");

stopSpinner();
process.stdout.write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H");

await start({
  App,
  createCliRenderer,
  createRoot,
  config,
  projectConfig,
  resumeSessionId,
  forceWizard,
  bootProviders,
  bootPrereqs,
  contextManager,
});
