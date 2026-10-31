import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { GATE_PREREQUISITES, pendingPrerequisite } from "../src/core/workflows/gate-prerequisites.js";
import { cmakeGates } from "../src/core/workflows/gates.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check, RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";

// Scenario of bench round 82 (#2526). tinyflate (C, CMake): in a fresh task worktree, which has no
// `build/` tree, `cmake-build` ran before `cmake-configure` 12 times, each a failed required check
// ("<worktree>/build is not a directory") the worker read and then repeated in the other order.
// Here stand-ins for the two gates: configure writes build/CMakeCache.txt, the build fails as
// cmake does without it.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const command = (id: string, script: string): Check => ({
  id,
  executable: "bun",
  args: ["-e", script],
  cwd: ".",
  timeoutMs: 60000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
});
const configure = command(
  "cmake-configure",
  "const fs = require('node:fs'); fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/CMakeCache.txt', 'CMAKE_BUILD_TYPE:STRING=Debug\\n');",
);
const build = command(
  "cmake-build",
  "if (!require('node:fs').existsSync('build/CMakeCache.txt')) { console.error('Error: ' + process.cwd() + '/build is not a directory'); process.exit(1); } console.log('[100%] Built target tinyflate');",
);
const failingConfigure = command(
  "cmake-configure",
  "console.error('CMake Error at CMakeLists.txt:3 (add_executable): Cannot find source file: src/main.c'); process.exit(1);",
);

async function runWith(checks: Check[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-gate-prerequisite-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(tinyflate C)\n");
  const policy: RunPolicy = { ...defaultWorkflowPolicy, checks };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, {} as AgentExecutor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Inflate a stream", ownerLabel: "test", policy });
  const step = service.store.beginStep(run.runId, "fixture");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const scope = new ProcessScope();
  cleanups.push(() => void scope.stop());
  const runner = new CheckRunner(service.store, scope);
  const ran = (check: Check) => runner.run(run.runId, attempt, check, new AbortController().signal, root);
  const recorded = () => service.store.checks(run.runId).map((c) => [c.check_id, c.status]);
  return { root, ran, recorded };
}

describe("scenario: tinyflate (bench round 82), a build gate run before configure in a fresh worktree (#2526)", () => {
  test("the build alone runs configure first, records it, and passes", async () => {
    const { root, ran, recorded } = await runWith([configure, build]);
    const checked = await ran(build);
    expect(checked.status).toBe("passed");
    expect(checked.output).toContain("Built target tinyflate");
    expect(existsSync(join(root, "build/CMakeCache.txt"))).toBe(true);
    expect(recorded()).toEqual([
      ["cmake-configure", "passed"],
      ["cmake-build", "passed"],
    ]);
    // Configured once: a second build does not configure again.
    expect((await ran(build)).status).toBe("passed");
    expect(recorded().filter(([id]) => id === "cmake-configure")).toHaveLength(1);
  });

  test("a configure that fails is the build's result, named as the prerequisite", async () => {
    const { ran, recorded } = await runWith([failingConfigure, build]);
    const checked = await ran(build);
    expect(checked.status).toBe("failed");
    expect(checked.output).toContain("cmake-build reads what cmake-configure writes (build/CMakeCache.txt)");
    expect(checked.output).toContain("Cannot find source file: src/main.c");
    expect(checked.output).not.toContain("is not a directory");
    expect(recorded()).toEqual([["cmake-configure", "failed"]]);
  });

  test("a run without the configure gate runs the build as it is", async () => {
    const { ran, recorded } = await runWith([build]);
    const checked = await ran(build);
    expect(checked.status).toBe("failed");
    expect(checked.output).toContain("build is not a directory");
    expect(recorded()).toEqual([["cmake-build", "failed"]]);
  });

  test("a prerequisite is pending only while its marker is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-gate-prerequisite-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    expect(pendingPrerequisite(build, [configure, build], root)?.check.id).toBe("cmake-configure");
    expect(pendingPrerequisite(configure, [configure, build], root)).toBeNull();
    expect(pendingPrerequisite(build, [build], root)).toBeNull();
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build/CMakeCache.txt"), "");
    expect(pendingPrerequisite(build, [configure, build], root)).toBeNull();
  });

  test("every row names gates the CMake detector offers, and its marker is what configure writes", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-gate-prerequisite-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "CMakeLists.txt"), "project(x C)\nenable_testing()\nadd_test(NAME t COMMAND t)\n");
    writeFileSync(join(root, ".clang-tidy"), "Checks: '-*'\n");
    writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
    const offered = cmakeGates(root, "linux").map((g) => g.check);
    const ids = offered.map((c) => c.id);
    for (const [id, row] of Object.entries(GATE_PREREQUISITES)) {
      expect(ids).toContain(id);
      expect(ids).toContain(row.checkId);
      const step = offered.find((c) => c.id === row.checkId);
      expect(step?.args.join(" ")).toContain(`-B ${row.marker.split("/")[0]}`);
    }
  });
});
