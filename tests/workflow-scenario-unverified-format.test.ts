import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { exitStatus } from "../src/core/verification/check-runner.js";
import { executeGate } from "../src/core/workflows/gates.js";
import type { Check, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 41, fpbits (#1480). The Go gates were `go vet` with the fixer `go fmt`
// and `go test`. `go vet` passes on unformatted code and runs only after integration, so its fixer
// never ran on a task's files, and `gofmt -l`, which would list the file, exits 0. The walker then
// passed "All new Go files are gofmt-formatted" from `vet` and `tests`, and the run delivered
// `internal/core/format.go` unformatted in all six feature commits.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const FILE = "internal/core/format.go";

/**
 * A stand-in for `gofmt` outside the workspace: `-l` lists the Go files that still hold
 * `UNFORMATTED` and exits 0 as gofmt does; `-w FILE` formats one file.
 */
function fakeGofmt(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-fake-gofmt-"));
  cleanups.push(() => removeTempDir(dir));
  const path = join(dir, "gofmt");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "-w" ]; then t=$(mktemp); sed "s/UNFORMATTED/formatted/" "$2" > "$t" && cat "$t" > "$2"; rm -f "$t"; exit 0; fi',
      "grep -rl --include='*.go' UNFORMATTED . | sed 's|^\\./||'",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

const gofmtCheck = (executable: string, fix: boolean): Check => ({
  id: "gofmt",
  executable,
  args: ["-l", "."],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
  ...(fix ? { fix: { executable, args: ["-w"] } } : {}),
});

describe.skipIf(process.platform === "win32")("scenario: fpbits, a Go file gofmt lists (#1480)", () => {
  test("a gofmt check that lists a file fails although gofmt exits 0, and names the fixer", async () => {
    const gofmt = fakeGofmt();
    const root = mkdtempSync(join(tmpdir(), "baked-gofmt-root-"));
    cleanups.push(() => removeTempDir(root));
    const check = gofmtCheck(gofmt, true);
    mkdirSync(join(root, "internal/core"), { recursive: true });
    writeFileSync(join(root, FILE), "package core // UNFORMATTED\n");
    const listed = await executeGate(root, check, signal());
    expect(listed).toMatchObject({ status: "failed", exitCode: 0 });
    expect(listed.outputTail).toContain(FILE);
    expect(exitStatus(check, 0, `${FILE}\n`)).toBe("failed");
    writeFileSync(join(root, FILE), "package core\n");
    expect((await executeGate(root, check, signal())).status).toBe("passed");
    expect(exitStatus(check, 0, "")).toBe("passed");
    // Any other command that exits 0 passes whatever it prints.
    expect(exitStatus({ executable: "go", args: ["vet", "./..."] }, 0, `${FILE}\n`)).toBe("passed");
  });

  test("the host formats the file a task wrote before its checks, so no corrective task runs", async () => {
    const gofmt = fakeGofmt();
    const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, gofmtCheck(gofmt, true)] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const original = executor.execute.bind(executor);
    const implementations: string[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "plan") {
        const out = await original(request);
        const graph = (out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } }).taskGraph;
        graph.tasks[0]?.writes.push({ path: FILE, action: "create" });
        return out;
      }
      if (request.profile.output === "implementation") {
        implementations.push(request.task?.id ?? "");
        const work = request.root ?? root;
        mkdirSync(join(work, "internal/core"), { recursive: true });
        writeFileSync(join(work, FILE), "package core // UNFORMATTED\n");
      }
      return original(request);
    };
    const run = await fixture.start();
    for (let i = 0; i < 8; i++) {
      const current = await service.get(run.runId);
      if (["completed", "blocked", "failed"].includes(current.status)) break;
      if (current.pendingRequestIds.length) await fixture.approve(run.runId);
      else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    expect((await service.get(run.runId)).status).toBe("completed");
    expect(readFileSync(join(root, FILE), "utf8")).toBe("package core // formatted\n");
    expect(implementations).toEqual(["T001"]);
    const gofmtRuns = service.store.checks(run.runId).filter((c) => c.check_id === "gofmt");
    expect(gofmtRuns.length).toBeGreaterThan(0);
    expect(gofmtRuns.every((c) => c.status === "passed")).toBe(true);
  }, 90_000);
});

describe("scenario: fpbits, a formatting criterion the walker passed without a format check (#1480)", () => {
  async function converge(then: string, checks: Check[]) {
    const spec: Spec = {
      ...fixtureSpec,
      criteria: [
        ...fixtureSpec.criteria,
        { id: "AC-002", requirementIds: ["FR-001"], given: "the change", when: "it is delivered", then, method: "automated" },
      ],
    };
    const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, ...checks] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
      const out = await original(request);
      if (request.profile.output === "plan") {
        const result = out.output as { taskGraph: { specHash: string; planHash: string }; markdown: string };
        result.taskGraph.specHash = hashJson(spec);
        result.taskGraph.planHash = hashBytes(result.markdown);
      }
      if (request.profile.output === "convergence") {
        const review = out.output as { coverage: { criterionId: string; verdict: string; evidenceIds: string[]; explanation: string }[] };
        const first = review.coverage[0];
        if (first) review.coverage.push({ ...first, criterionId: "AC-002", explanation: "vet and tests pass" });
      }
      return out;
    };
    const run = await fixture.start();
    for (let i = 0; i < 8; i++) {
      const current = await service.get(run.runId);
      if (["completed", "blocked", "failed"].includes(current.status)) break;
      if (current.pendingRequestIds.length) await fixture.approve(run.runId);
      else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    const state = service.store.state(run.runId);
    return {
      status: (await service.get(run.runId)).status,
      verdict: state.convergence?.coverage.find((c) => c.criterionId === "AC-002")?.verdict,
      limitations: state.limitations,
    };
  }
  const lint = (id: string, args: string[]): Check => ({
    id,
    executable: "bun",
    args: ["-e", "process.exit(0)", "--", ...args],
    cwd: ".",
    timeoutMs: 10000,
    required: true,
    scope: "feature",
    envNames: [],
    writes: [],
    fix: { executable: "bun", args: ["-e", "process.exit(0)"] },
  });
  const CLAIM = "All new Go files are gofmt-formatted; 'go vet ./...' and 'go test ./...' pass";

  test("is not passed from the checks that cannot show it, and the run reports it unverified", async () => {
    const result = await converge(CLAIM, [lint("vet", ["vet", "./..."])]);
    expect(result.verdict).toBe("inconclusive");
    expect(result.limitations).toEqual([
      expect.objectContaining({
        findingId: "unverified-AC-002",
        claim: expect.stringContaining("No passing format or lint check covers this claim (passing checks: check, vet)"),
        impact: "No check of the run verifies it; a format or lint gate would",
      }),
    ]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("passes when a format check and a lint check passed on the delivered sources", async () => {
    const result = await converge(CLAIM, [lint("gofmt", ["-l", "."]), lint("vet", ["vet", "./..."])]);
    expect(result.verdict).toBe("pass");
    expect(result.limitations).toEqual([]);
    expect(result.status).toBe("completed");
  }, 90_000);
});
