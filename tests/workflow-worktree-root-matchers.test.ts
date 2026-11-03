/**
 * The `.baked/worktrees` path matchers that #2731 extends to a run under `workflows.worktreeRoot`
 * (#2461): diagnostic paths of a check, a file's worktree and project for the language servers and
 * an edit's importers, and the doctor's stale worktree count.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverRootFor } from "../src/core/intelligence/backends/lsp/index.js";
import { RUN_MARKER, runWorktreeAt } from "../src/core/verification/run-roots.js";
import { baselineDebt, baselineKeys, relativeHeaded } from "../src/core/verification/task-end-check.js";
import { baselineFindings } from "../src/core/workflows/baseline-fix.js";
import { gitChecks } from "../src/core/workflows/doctor.js";
import { runRoots } from "../src/core/workflows/worktree.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TS_ERROR = "error TS2322: Type 'number' is not assignable to type 'string'.";

describe("check diagnostics under a configured worktree root (#2731)", () => {
  const run = runRoots("/home/me/app", { worktree: { path: "../../../.bk/0a1b2c3d/main" } } as never);

  test("runRoots names the run's directory under the root", () => {
    expect(run.worktrees).toBe("/.bk/0a1b2c3d");
  });

  test("a path in another worktree of the run and in the project is workspace-relative", () => {
    const output = [
      `/.bk/0a1b2c3d/T003/src/a.ts(3,7): ${TS_ERROR}`,
      `/.bk/0a1b2c3d/main/src/b.ts(4,7): ${TS_ERROR}`,
      `/home/me/app/src/c.ts(5,7): ${TS_ERROR}`,
      `/.bk/ffffffff/main/src/d.ts(6,7): ${TS_ERROR}`,
    ].join("\n");
    const paths = relativeHeaded(output, "/.bk/0a1b2c3d/T003", run).map((d) => d.path);
    expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "/.bk/ffffffff/main/src/d.ts"]);
    // Without the run's roots only the check's own root is recognised.
    expect(relativeHeaded(output, "/.bk/0a1b2c3d/T003").map((d) => d.path)[1]).toBe(
      "/.bk/0a1b2c3d/main/src/b.ts",
    );
  });

  test("a Windows spelling of the root matches too", () => {
    const output = String.raw`C:\.bk\0a1b2c3d\main\src\b.ts(4,7): ` + TS_ERROR;
    const winRun = { workspace: "C:/Users/me/app", worktrees: "C:/.bk/0a1b2c3d" };
    expect(relativeHeaded(output, "C:/.bk/0a1b2c3d/T003", winRun).map((d) => d.path)).toEqual([
      "src/b.ts",
    ]);
  });

  test("the baseline keys, debt and findings read the same paths", () => {
    const baseline = baselineKeys(`/.bk/0a1b2c3d/main/src/b.ts(4,7): ${TS_ERROR}`, "/.bk/0a1b2c3d/main", run);
    const later = `/.bk/0a1b2c3d/main/src/b.ts(9,7): ${TS_ERROR}`;
    expect(baselineKeys(later, "/.bk/0a1b2c3d/T003", run)).toEqual(baseline);
    expect(
      baselineDebt(later, "/.bk/0a1b2c3d/T003", { baseline, changed: [], summary: 1 }, run),
    ).toEqual(baseline);
    expect(baselineFindings(later, "/.bk/0a1b2c3d/T003", ".", run).files).toEqual(["src/b.ts"]);
  });
});

/** A project and a run worktree of it under an outside root, spelled as Git writes them. */
function layout(): { project: string; root: string; worktree: string } {
  const base = mkdtempSync(join(tmpdir(), "baked-wt-root-"));
  dirs.push(base);
  const project = join(base, "app");
  const root = join(base, "bk");
  const worktree = join(root, "0a1b2c3d", "T003");
  mkdirSync(join(project, ".git", "worktrees", "T003"), { recursive: true });
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(root, "0a1b2c3d", RUN_MARKER), "0a1b2c3d-run\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(project, ".git", "worktrees", "T003")}\n`);
  return { project, root, worktree };
}

describe("a run worktree found from its path (#2731)", () => {
  test("runWorktreeAt names the worktree and its project from below", () => {
    const { project, worktree } = layout();
    expect(runWorktreeAt(join(worktree, "src", "a.ts"))).toEqual({ worktree, project });
    expect(runWorktreeAt(join(project, "src"))).toBeNull();
  });

  test("a directory without the run marker is not a run worktree", () => {
    const { root, worktree } = layout();
    rmSync(join(root, "0a1b2c3d", RUN_MARKER));
    expect(runWorktreeAt(worktree)).toBeNull();
  });

  test("a language server never starts in a worktree under the root", () => {
    const { project, worktree } = layout();
    expect(serverRootFor(worktree, "/fb")).toBe(project);
    expect(serverRootFor(join(worktree, "src"), "/fb")).toBe(project);
    expect(serverRootFor(project, "/fb")).toBe(project);
  });
});

describe("doctor stale worktrees (#2731)", () => {
  const git =
    (paths: string[]) =>
    async (args: string[]): Promise<{ code: number; stdout: string }> =>
      args[0] === "rev-parse"
        ? { code: 0, stdout: "true\n" }
        : args[0] === "worktree"
          ? {
              code: 0,
              stdout: paths
                .map((p) => `worktree ${p}\nprunable gitdir file points to non-existent location\n`)
                .join("\n"),
            }
          : { code: 0, stdout: "" };

  test("prunable run worktrees under workflows.worktreeRoot count", async () => {
    const base = mkdtempSync(join(tmpdir(), "baked-doctor-root-"));
    dirs.push(base);
    const workspace = join(base, "app");
    const root = join(base, "bk");
    const listed = git([
      join(root, "0a1b2c3d", "main"),
      join(workspace, ".baked", "worktrees", "r1", "main"),
      join(base, "elsewhere", "mine"),
    ]);
    const stale = (checks: Awaited<ReturnType<typeof gitChecks>>) =>
      checks.find((c) => c.id === "git.worktrees")?.title;
    expect(stale(await gitChecks(workspace, "worktree", listed, root))).toBe("2 stale run worktrees");
    expect(stale(await gitChecks(workspace, "worktree", listed))).toBe("1 stale run worktree");
  });
});
