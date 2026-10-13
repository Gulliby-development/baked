/**
 * `baked self-check`: exercises the runtime pieces a packaged build must ship
 * (native OpenTUI library, bun:sqlite, worker bundles, tree-sitter WASM, the OS sandbox)
 * without a terminal or a provider key, so CI can smoke-test every build.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { detectSandbox, type SandboxDetection } from "../core/platform/sandbox.js";
import {
  formatSandboxStatus,
  sandboxEnv,
  sandboxLaunch,
  sandboxStatus,
} from "../core/security/sandbox.js";

interface Check {
  name: string;
  run: (workspace: string) => Promise<string>;
}

const CHECK_TIMEOUT_MS = 120_000;

/**
 * The sandbox line: mode and backend, and when a backend works, a trivial command started through
 * the sandbox launcher. A missing backend fails only when the effective mode is `required`;
 * Windows has none yet (#624) and is reported without failing.
 */
export async function sandboxSelfCheck(
  workspace: string,
  detection: SandboxDetection = detectSandbox(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const status = sandboxStatus(process.cwd(), detection);
  const [mode, backend] = formatSandboxStatus(status);
  const summary = `${mode}; ${backend}`;
  if (platform === "win32") return `${summary}; not supported on Windows`;
  if (!detection.available) {
    if (status.effectiveMode === "required") throw new Error(`${summary}; commands are refused`);
    return `${summary}; commands run without OS sandbox`;
  }
  const launch = sandboxLaunch(
    "/bin/sh",
    ["-c", "true"],
    {
      mode: "required",
      surface: "chat",
      writable: [workspace],
      workspaces: [workspace],
      network: false,
    },
    workspace,
    detection,
  );
  const result = spawnSync(launch.executable, launch.args, {
    cwd: workspace,
    env: sandboxEnv(process.env, launch),
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const why = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
    throw new Error(`${summary}; a sandboxed command did not start: ${why}`);
  }
  return `${summary}; a sandboxed command started`;
}

const checks: Check[] = [
  {
    name: "sqlite",
    run: async () => {
      const db = new Database(":memory:");
      try {
        const row = db.query("select sqlite_version() as v").get() as { v: string };
        return `SQLite ${row.v}`;
      } finally {
        db.close();
      }
    },
  },
  {
    name: "opentui native library",
    run: async () => {
      const { resolveRenderLib } = await import("@opentui/core");
      resolveRenderLib();
      return "loaded";
    },
  },
  {
    name: "io worker",
    run: async (workspace) => {
      const { IOClient } = await import("../core/workers/io-client.js");
      const client = new IOClient();
      try {
        const result = await client.readFileNumbered(join(workspace, "greet.ts"));
        if (!("ok" in result)) throw new Error(`readFileNumbered returned ${result.error}`);
        return `${result.totalLines} lines read`;
      } finally {
        client.dispose();
      }
    },
  },
  {
    name: "intelligence worker + tree-sitter",
    run: async (workspace) => {
      const { IntelligenceClient } = await import("../core/workers/intelligence-client.js");
      const client = new IntelligenceClient(workspace);
      try {
        await client.scan();
        const symbols = await client.getFileSymbols("greet.ts");
        if (!symbols.some((s) => s.name === "greet")) {
          throw new Error(`symbol "greet" not indexed (got ${symbols.length} symbols)`);
        }
        return `${symbols.length} symbols indexed`;
      } finally {
        await client.close();
      }
    },
  },
  { name: "sandbox", run: (workspace) => sandboxSelfCheck(workspace) },
  {
    name: "workflow worker",
    run: async (workspace) => {
      const { WorkflowClient } = await import("../core/workers/workflow-client.js");
      const client = new WorkflowClient(workspace, loadConfig());
      try {
        const runs = await client.list();
        return `${runs.length} runs`;
      } finally {
        await client.shutdown().catch(() => {});
        client.close();
      }
    },
  },
];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runSelfCheck(): Promise<number> {
  const workspace = mkdtempSync(join(tmpdir(), "baked-self-check-"));
  writeFileSync(
    join(workspace, "greet.ts"),
    'export function greet(name: string): string {\n  return "hello " + name;\n}\n',
  );
  writeFileSync(
    join(workspace, "main.ts"),
    'import { greet } from "./greet";\n\nconsole.log(greet("baked"));\n',
  );

  let failed = 0;
  try {
    for (const check of checks) {
      try {
        const detail = await withTimeout(check.run(workspace), CHECK_TIMEOUT_MS);
        process.stdout.write(`ok   ${check.name}: ${detail}\n`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stdout.write(`FAIL ${check.name}: ${msg}\n`);
      }
    }
  } finally {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // Windows can hold SQLite files briefly after a worker exits.
    }
  }
  process.stdout.write(failed === 0 ? "self-check passed\n" : `self-check: ${failed} failed\n`);
  return failed === 0 ? 0 : 1;
}
