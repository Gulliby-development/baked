import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { detectGates } from "../src/core/workflows/gates.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check, RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";

// Scenario of bench round 90 (#2830). windowfit (Rust), run 74ab5924: the required `cargo fmt
// --check` failed on a trailing blank line, and the stored check artifact's `output` ended with a
// green `+` in escape codes: rustfmt colours its diff whenever `TERM` names a colour terminal,
// whatever `NO_COLOR` and `CARGO_TERM_COLOR` say. The raw output was the input of the
// `decision.would_rerun` record and of every reader of the artifact. Here a stand-in prints
// rustfmt's own bytes (terminfo's `sgr0` is `ESC(B ESC[m` on xterm and ends in a shift-in, 0x0f,
// on others), and where cargo is installed the detected gate runs under a colour terminal.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const DIFF = 'Diff in /work/windowfit/src/main.rs:12:\n     println!("fit");\n }\n-\n+\n';
const COLOURED =
  'Diff in /work/windowfit/src/main.rs:12:\n     println!("fit");\n }\n\u001b(B\u001b[m\u001b[31m-\n\u001b[m\u000f\u001b[32m+\n\u001b[0m';

const standIn: Check = {
  id: "fmt",
  executable: "bun",
  args: ["-e", `process.stdout.write(${JSON.stringify(COLOURED)}); process.exit(1);`],
  cwd: ".",
  timeoutMs: 60000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
};

// Any control character but a newline, a tab and a carriage return.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const CARGO_FILES = {
  "Cargo.toml": '[package]\nname = "windowfit"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/main.rs": 'fn main() {\n    println!("fit");\n}\n\n\n',
};

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-coloured-stored-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function runWith(root: string, checks: Check[]) {
  const policy: RunPolicy = { ...defaultWorkflowPolicy, checks };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, {} as AgentExecutor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Fit windows", ownerLabel: "test", policy });
  const step = service.store.beginStep(run.runId, "fixture");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const scope = new ProcessScope();
  cleanups.push(() => void scope.stop());
  const runner = new CheckRunner(service.store, scope);
  const ran = (check: Check) => runner.run(run.runId, attempt, check, new AbortController().signal, root);
  const stored = (check: Check) =>
    service.store
      .artifacts(run.runId)
      .filter((row) => row.kind === "check" && row.logical_path.startsWith(`checks/${check.id}/`))
      .map((row) => (JSON.parse(service.store.readArtifact(run.runId, row.id)) as { output: string }).output);
  return { runner, ran, stored };
}

describe("scenario: windowfit (bench round 90), a coloured rustfmt diff in the stored check result (#2830)", () => {
  test("the stored artifact, the returned output and a measured output hold no escape codes", async () => {
    const root = project({ "Cargo.toml": CARGO_FILES["Cargo.toml"] });
    const { runner, ran, stored } = await runWith(root, [standIn]);
    const checked = await ran(standIn);
    expect([checked.status, checked.output]).toEqual(["failed", DIFF]);
    expect(stored(standIn)).toEqual([DIFF]);
    const measured = await runner.measure(standIn, new AbortController().signal, root, null);
    expect([measured.status, measured.output]).toEqual(["failed", DIFF]);
  });

  const cargo = spawnSync("cargo", ["fmt", "--version"], { stdio: "ignore" }).status === 0;
  test.skipIf(!cargo)("the detected cargo fmt gate stores a plain diff under a colour terminal", async () => {
    const saved = process.env.TERM;
    process.env.TERM = "xterm-256color";
    try {
      const root = project(CARGO_FILES);
      const gate = detectGates(root).find((s) => s.check.id === "cargo-fmt")?.check;
      expect(gate).toBeDefined();
      const check: Check = { ...(gate as Check), required: true };
      const { ran, stored } = await runWith(root, [check]);
      const checked = await ran(check);
      expect([checked.status, checked.output.includes("Diff in")]).toEqual(["failed", true]);
      expect([checked.output, ...stored(check)].map((output) => CONTROL.test(output))).toEqual([false, false]);
    } finally {
      if (saved === undefined) delete process.env.TERM;
      else process.env.TERM = saved;
    }
  });
});
