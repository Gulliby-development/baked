import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSandbox, type SandboxDetection } from "../src/core/platform/sandbox.js";
import { setSandboxOverride } from "../src/core/security/sandbox.js";
import { runSelfCheck, sandboxSelfCheck } from "../src/headless/self-check.js";

describe("self-check", () => {
  test("passes against the source tree", async () => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runSelfCheck();
    } finally {
      process.stdout.write = write;
    }
    expect(lines.join("")).not.toContain("FAIL");
    expect(code).toBe(0);
  }, 120_000);
});

describe("self-check sandbox line", () => {
  const missing: SandboxDetection = {
    backend: "bwrap",
    available: false,
    path: null,
    reason: "bwrap is not installed (apt install bubblewrap)",
  };
  const withWorkspace = async (body: (workspace: string) => Promise<void>) => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-self-check-sandbox-"));
    try {
      await body(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  };

  afterEach(() => setSandboxOverride(undefined));

  test("reports the mode and a missing backend without failing unless the mode is required", async () => {
    await withWorkspace(async (workspace) => {
      setSandboxOverride("auto");
      expect(await sandboxSelfCheck(workspace, missing, "linux")).toBe(
        "Sandbox mode: auto (command-line override); Backend: unavailable: bwrap is not installed (apt install bubblewrap); commands run without OS sandbox",
      );
      setSandboxOverride("required");
      await expect(sandboxSelfCheck(workspace, missing, "linux")).rejects.toThrow(
        "commands are refused",
      );
    });
  });

  test("Windows is reported as not supported without failing", async () => {
    await withWorkspace(async (workspace) => {
      const windows: SandboxDetection = { ...missing, backend: "none", reason: "no backend" };
      expect(await sandboxSelfCheck(workspace, windows, "win32")).toEndWith(
        "; not supported on Windows",
      );
    });
  });

  test.skipIf(process.platform === "win32")(
    "starts a command through the backend and fails when it cannot",
    async () => {
      await withWorkspace(async (workspace) => {
        const broken: SandboxDetection = {
          backend: process.platform === "darwin" ? "seatbelt" : "bwrap",
          available: true,
          path: join(workspace, "no-such-sandbox"),
          reason: null,
        };
        await expect(sandboxSelfCheck(workspace, broken)).rejects.toThrow(
          "a sandboxed command did not start",
        );
        const detection = detectSandbox();
        if (detection.available)
          expect(await sandboxSelfCheck(workspace, detection)).toEndWith(
            "; a sandboxed command started",
          );
      });
    },
  );
});
