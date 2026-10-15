import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../src/core/workflows/store.js";
import { scanTestIntegrity } from "../src/core/workflows/test-integrity.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 30 (#1284): zonevet cc41bbb9 got two literal-branch correctives (646k tokens) for
// literals the brief prescribes, and ecfit 25614519 one skip corrective (338k) for a test that
// skips only when the machine cannot create a symbolic link.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const BRIEF = [
  "Create ready value: a zone file checker.",
  "Lines that start with the `$ORIGIN` directive set the origin for the names after them.",
  "Without a command it prints `zonevet: missing command (check, list or diff)` and exits with 2.",
].join("\n");

const SOURCE = [
  "export function directive(line: string): string | null {",
  '  if (line.split(" ")[0] === "$ORIGIN") return "origin";',
  "  return null;",
  "}",
  "export function usage(args: string[]): string | null {",
  '  return args.length === 0 ? "zonevet: missing command (check, list or diff)" : null;',
  "}",
  "export function error(message: string): number {",
  '  return message === "zonevet: missing command (check, list or diff)" ? 2 : 1;',
  "}",
  "",
].join("\n");

const TEST = [
  'it("sets the origin", () => { expect(directive("$ORIGIN example.com.")).toBe("origin"); });',
  'it("reads a bare directive", () => { expect(directive("$ORIGIN")).toBe("origin"); });',
  'it("needs a command", () => { expect(error(usage([]) ?? "")).toBe(2); });',
  'it("names the usage", () => { expect(usage([])).toBe("zonevet: missing command (check, list or diff)"); });',
  "",
].join("\n");

const GO_TEST = [
  "package cli",
  "",
  'import ("os"; "path/filepath"; "testing")',
  "",
  "func TestWalkFollowsLinks(t *testing.T) {",
  "\tdir := t.TempDir()",
  '\tif err := os.Symlink(filepath.Join(dir, "a"), filepath.Join(dir, "b")); err != nil {',
  '\t\tt.Skipf("symbolic links are not available: %v", err)',
  "\t}",
  '\tif got := walk(dir); got != 2 { t.Fatalf("got %d", got) }',
  "}",
  "",
  "func TestWalkSkipsLoops(t *testing.T) {",
  "\tdir := t.TempDir()",
  '\terr := os.Symlink(dir, filepath.Join(dir, "loop"))',
  "\tif err != nil {",
  '\t\tt.Skip("symbolic links are not available")',
  "\t}",
  '\tif got := walk(dir); got != 0 { t.Fatalf("got %d", got) }',
  "}",
  "",
].join("\n");

/** An executor whose task writes code with the brief's literals and a capability-guarded Go test. */
class PrescribedExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const output = result.output as { taskGraph: { tasks: Task[] } };
      output.taskGraph.tasks[0]?.writes.push(
        { path: "zone.ts", action: "create" },
        { path: "zone.test.ts", action: "create" },
        { path: "walk_test.go", action: "create" },
      );
      return result;
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    this.implementations++;
    writeFileSync(join(this.dir, "value.txt"), "ready");
    writeFileSync(join(this.dir, "zone.ts"), SOURCE);
    writeFileSync(join(this.dir, "zone.test.ts"), TEST);
    writeFileSync(join(this.dir, "walk_test.go"), GO_TEST);
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote the checker", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

test("scenario: zonevet and ecfit (#1284), prescribed literals and capability guards start no corrective", async () => {
  const fixture = workflowFixture({ executor: (root) => new PrescribedExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: BRIEF, ownerLabel: "test", policy: fixture.policy });
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await service.drive(run.runId, signal());

  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  expect(claims.filter((c) => c.startsWith("Test integrity"))).toEqual([]);
  expect(service.store.latestArtifact(run.runId, "tasks/T001/integrity.json")).toBeNull();
  expect(executor.implementations).toBe(1);
  expect((await service.get(run.runId)).status).toBe("completed");
}, 90_000);

test("a literal nothing prescribes and an unconditional skip are still reported", () => {
  const findings = scanTestIntegrity(
    [
      { path: "src/zone.ts", before: "", after: 'if (name === "$TTL 3600 legacy") return 1;\n' },
      { path: "tests/zone.test.ts", before: null, after: 'it("ttl", () => { expect(zone("$TTL 3600 legacy")).toBe(1); });\n' },
      { path: "cli/walk_test.go", before: "", after: 'func TestWalk(t *testing.T) {\n\tt.Skip("flaky")\n\tif walk() != 2 { t.Fatal("no") }\n}\n' },
      // A plain error check is no capability guard: the skip hides whatever failed.
      { path: "cli/read_test.go", before: "", after: 'func TestRead(t *testing.T) {\n\tif err := read(); err != nil {\n\t\tt.Skip("read failed")\n\t}\n}\n' },
      // Python: a platform condition on the marker, and an optional import in a try block.
      { path: "tests/test_links.py", before: "", after: '@pytest.mark.skipif(sys.platform == "win32", reason="no links")\ndef test_links():\n    try:\n        import yaml\n    except ImportError:\n        pytest.skip("yaml missing")\n    assert yaml\n' },
    ],
    { specText: BRIEF },
  );
  expect(findings.map((f) => `${f.rule} ${f.path}`)).toEqual([
    "literal-branch src/zone.ts",
    "skip cli/walk_test.go",
    "skip cli/read_test.go",
  ]);
});
