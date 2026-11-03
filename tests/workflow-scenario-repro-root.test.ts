import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reproOutsidePaths, rerootRepro, runRepro } from "../src/core/verification/repro.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Repro } from "../src/core/workflows/schemas.js";

// Scenario of bench round 73 (#2279). evalpin `checks` b38e180d: finding F1's repro was a probe
// Cargo project whose dependency named the review's worktree by its absolute path
// (`.baked/worktrees/<run>/main`). The corrective T003 ran in `.baked/worktrees/<run>/T003`, so the
// probe built the unchanged code: 18 runs of the repro all reproduced after the fix, and T003 spent
// 2.45M tokens on a one-line change. Here the probe reads the code it checks by an absolute path.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A workspace with the run's review worktree (still buggy) and the corrective's (fixed). */
function workspace() {
  const base = mkdtempSync(join(tmpdir(), "baked-repro-root-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, ".baked", "worktrees", "b38e180d", "main");
  const task = join(base, ".baked", "worktrees", "b38e180d", "T003");
  for (const [root, label] of [[base, "disp"], [main, "disp"], [task, "name"]] as const) {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "label.txt"), label);
  }
  return { base, main, task };
}

const run = (repro: Repro, root: string) =>
  runRepro(new ProcessScope(), repro, { root, executables: ["bun"], generated: [], signal: new AbortController().signal, sandbox: null });

/** The probe as the reviewer wrote it: it reads the code under `dir`. */
const probe = (dir: string): Repro => ({
  executable: "bun",
  args: ["{files}/probe.ts"],
  expected: "name",
  actual: "disp",
  files: [{ name: "probe.ts", content: `console.log(await Bun.file(${JSON.stringify(join(dir, "src", "label.txt").replace(/\\/g, "/"))}).text());` }],
});

describe("scenario: evalpin checks T003, a repro bound to the review's worktree (#2279)", () => {
  test("the corrective's run of the repro sees its own fix", async () => {
    const { main, task } = workspace();
    // In the review's worktree the claim holds.
    expect((await run(probe(main), main)).status).toBe("reproduced");
    // In the corrective's worktree the host points the probe at that worktree, which is fixed.
    const fixed = await run(probe(main), task);
    expect(fixed.status).toBe("refuted");
    expect(fixed.rewritten?.map((p) => p.replace(/\\/g, "/"))).toEqual([main.replace(/\\/g, "/")]);
  });

  test("a probe that names the workspace runs against the worktree it runs in", async () => {
    const { base, task } = workspace();
    const outcome = await run(probe(base), task);
    expect(outcome.status).toBe("refuted");
    expect(outcome.rewritten?.length).toBe(1);
  });

  test("{root} names the root the repro runs in", async () => {
    const { main, task } = workspace();
    const repro: Repro = { ...probe(main), files: [{ name: "probe.ts", content: 'console.log(await Bun.file("{root}/src/label.txt").text());' }] };
    expect((await run(repro, main)).status).toBe("reproduced");
    const outcome = await run(repro, task);
    expect(outcome.status).toBe("refuted");
    expect(outcome.rewritten).toBeUndefined();
  });

  test("under workflows.worktreeRoot the corrective's run sees its own fix (#2697)", async () => {
    const base = mkdtempSync(join(tmpdir(), "baked-repro-root-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const project = join(base, "evalpin");
    const roots = { workspace: project, worktrees: join(base, ".bk", "b38e180d") };
    const main = join(roots.worktrees, "main");
    const task = join(roots.worktrees, "T003");
    for (const [root, label] of [[project, "disp"], [main, "disp"], [task, "name"]] as const) {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "label.txt"), label);
    }
    const inRun = (repro: Repro, root: string) =>
      runRepro(new ProcessScope(), repro, { root, run: roots, executables: ["bun"], generated: [], signal: new AbortController().signal, sandbox: null });
    expect((await inRun(probe(main), main)).status).toBe("reproduced");
    const fixed = await inRun(probe(main), task);
    expect(fixed.status).toBe("refuted");
    expect(fixed.rewritten?.map((p) => p.replace(/\\/g, "/"))).toEqual([main.replace(/\\/g, "/")]);
    // The workspace the worktrees belong to is a root of the run too.
    expect((await inRun(probe(project), task)).status).toBe("refuted");
    // Neither counts as a path outside the run (#2287); another run's worktree does.
    const other = join(base, ".bk", "aaaaaaaa", "main", "src", "a.ts");
    const args = [join(main, "src", "a.ts"), join(project, "src", "a.ts"), other];
    expect(reproOutsidePaths({ args }, task, roots)).toEqual([other]);
    // Without the run's roots only the `.baked/worktrees` spelling is known.
    expect(reproOutsidePaths({ args }, task)).toHaveLength(3);
  });
});

// Each language's way for a probe project to name the workspace's code: rewritten to the root the
// repro runs in, with the text's own slashes where it used backslashes in an argument.
const MAIN = "C:/Project/bench/evalpin/.baked/worktrees/b38e180d/main";
const TASK = "C:\\Project\\bench\\evalpin\\.baked\\worktrees\\b38e180d\\T003";
const TASK_SLASHED = "C:/Project/bench/evalpin/.baked/worktrees/b38e180d/T003";
const REFERENCES: Record<string, string> = {
  rust: `[dependencies]\nevalpin = { path = "${MAIN}" }`,
  go: `module probe\nrequire example.com/app v0.0.0\nreplace example.com/app => ${MAIN}`,
  python: `import sys\nsys.path.insert(0, "${MAIN}/src")`,
  typescript: `{"dependencies":{"app":"file:${MAIN}"}}`,
  csharp: `<ProjectReference Include="${MAIN}/src/App/App.csproj" />`,
  java: `dependencies { implementation files("${MAIN}/build/classes/java/main") }`,
  kotlin: `includeBuild("${MAIN}")`,
};

// The same run with `workflows.worktreeRoot` set to `C:/.bk` (#2461, #2697): no `.baked/worktrees`
// spelling to find the run's other worktree or its workspace by.
const ROOT_MAIN = "C:/.bk/b38e180d/main";
const ROOT_TASK = "C:/.bk/b38e180d/T003";
const RUN_ROOTS = { workspace: "C:\\Project\\bench\\evalpin", worktrees: "C:\\.bk\\b38e180d" };

describe("a probe project's reference to the review's worktree, per language (#2279)", () => {
  test.each(Object.entries(REFERENCES))("%s", (_, content) => {
    const { text, rewritten } = rerootRepro(content, TASK, true);
    expect(text).toBe(content.replaceAll(MAIN, TASK_SLASHED));
    expect(rewritten).toEqual([MAIN]);
  });

  test.each(Object.entries(REFERENCES))("%s under workflows.worktreeRoot (#2697)", (_, content) => {
    const custom = content.replaceAll(MAIN, ROOT_MAIN);
    const { text, rewritten } = rerootRepro(custom, ROOT_TASK, true, RUN_ROOTS);
    expect(text).toBe(content.replaceAll(MAIN, ROOT_TASK));
    expect(rewritten).toEqual([ROOT_MAIN]);
  });

  test("an argument keeps its backslashes and a glued flag, and the own root is left alone", () => {
    const arg = "-IC:\\Project\\bench\\evalpin\\.baked\\worktrees\\b38e180d\\main\\include";
    expect(rerootRepro(arg, TASK, false).text).toBe(`-I${TASK}\\include`);
    expect(rerootRepro(`path = "${TASK_SLASHED}"`, TASK, true)).toEqual({ text: `path = "${TASK_SLASHED}"`, rewritten: [] });
  });
});
