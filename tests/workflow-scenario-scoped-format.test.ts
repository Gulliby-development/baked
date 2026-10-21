import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { changedLineRanges, formatWrittenChecks } from "../src/core/workflows/format-written.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import { fileHash } from "../src/core/workflows/effects.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// R55 structpad-update and R56 logslice-update (#1837): the repository's older
// files were not `ruff format` clean, so the whole-tree format gate was only offered and the run's
// checks held no formatter; the new test file each run wrote shipped unformatted although the
// brief asked for it formatted. The scoped format-written check holds the files a task creates.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fake-ruff-"));
const savedPath = process.env.PATH;
afterAll(async () => {
  process.env.PATH = savedPath;
  await removeTempDir(bin);
});
// A stand-in for `ruff format`: "x=1" is unformatted, "x = 1" formatted. `--range=S-E` formats lines
// S to E-1 and `--range=S` from line S to the end, as ruff does.
if (!IS_WIN) {
  writeFileSync(
    join(bin, "ruff"),
    `#!/bin/sh
[ "$1" = "format" ] || exit 0
shift
check=0
range=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1; shift;;
    --range=*) range="\${1#--range=}"; shift;;
    *) break;;
  esac
done
bad=0
for f in "$@"; do
  total=$(wc -l < "$f")
  start=1
  end=$total
  if [ -n "$range" ]; then
    start=\${range%%-*}
    case "$range" in *-*) end=$((\${range#*-} - 1));; esac
  fi
  if [ $check = 1 ]; then
    if sed -n "\${start},\${end}p" "$f" | grep -q 'x=1'; then echo "Would reformat: $f"; bad=1; fi
  else
    sed "\${start},\${end}s/x=1/x = 1/" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done
exit $bad
`,
  );
  chmodSync(join(bin, "ruff"), 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

// ruff is the linter only, so `ruff format --check .` is offered, not preselected.
const PROJECT = {
  "pyproject.toml": "[project]\nname = 'logslice'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n",
  "logslice/old.py": "x=1\n",
};

describe.skipIf(IS_WIN)("a format-written check holds the files a task writes (#1837)", () => {
  test("the check names only the Python files the task creates and fixes with ruff format", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-format-written-"));
    for (const [path, text] of Object.entries({ ...PROJECT, "tests/test_new.py": "x=1\n", "README.md": "# z\n" })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const writes = [{ path: "tests/test_new.py", action: "create" }, { path: "README.md", action: "modify" }];
    const [check, ...rest] = formatWrittenChecks(root, [], writes);
    expect(rest).toEqual([]);
    expect(check).toMatchObject({ id: "ruff-format-written", executable: "ruff", args: ["format", "--check", "tests/test_new.py"], fix: { executable: "ruff", args: ["format"] }, required: true });
    // A run whose checks already format Python gets none.
    expect(formatWrittenChecks(root, [{ ...check!, id: "ruff-format", args: ["format", "--check", "."] }], writes)).toEqual([]);
    // A ruff format check the run keeps on one clean old file does not hold the new one.
    expect(formatWrittenChecks(root, [{ ...check!, id: "ruff-format", args: ["format", "--check", "logslice/old.py"] }], writes)).toMatchObject([{ id: "ruff-format-written", args: ["format", "--check", "tests/test_new.py"] }]);
    // An edited file keeps its old formatting (#1582).
    expect(formatWrittenChecks(root, [], [{ path: "logslice/old.py", action: "modify" }])).toEqual([]);
    // Nor a formatter that is not installed.
    expect(formatWrittenChecks(root, [], writes, () => null)).toEqual([]);
  });

  test("logslice: the new file is formatted by the fixer, the old one is left alone, and the run completes", async () => {
    const f = workflowFixture();
    try {
      for (const [path, text] of Object.entries(PROJECT)) {
        mkdirSync(dirname(join(f.root, path)), { recursive: true });
        writeFileSync(join(f.root, path), text);
      }
      const original = f.executor.execute.bind(f.executor);
      f.executor.execute = async (request: ExecutionRequest) => {
        const out = await original(request);
        if (request.profile.output === "plan") {
          const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] } };
          // The task may also edit old.py: the fixer of the new file's check never formats it whole.
          plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_new.py", action: "create" }, { path: "logslice/old.py", action: "modify" });
          plan.taskGraph.specHash = hashJson(fixtureSpec);
          plan.taskGraph.planHash = hashBytes(plan.markdown);
        }
        if (request.profile.output === "implementation") {
          mkdirSync(join(f.root, "tests"), { recursive: true });
          writeFileSync(join(f.root, "tests/test_new.py"), "x=1\n");
        }
        return out;
      };
      const run = await f.start();
      let view = await f.service.drive(run.runId, new AbortController().signal);
      expect(view).toMatchObject({ status: "waiting", reason: "approval" });
      await f.approve(run.runId);
      view = await f.service.drive(run.runId, new AbortController().signal);
      expect(view.status).toBe("completed");
      expect(readFileSync(join(f.root, "tests/test_new.py"), "utf8")).toBe("x = 1\n");
      expect(readFileSync(join(f.root, "logslice/old.py"), "utf8")).toBe("x=1\n");
      const outputs = f.service.store
        .artifacts(run.runId)
        .filter((a) => a.logical_path.includes("ruff-format-written"))
        .map((a) => f.service.store.readArtifact(run.runId, a.id))
        .join("\n");
      expect(outputs).not.toContain("old.py");
    } finally {
      await f.dispose();
    }
  }, 60000);
});

// R57 zonevet-update (#1837): the task appended a test to `tests/test_docs.py`, a file that was not
// `ruff format` clean before the run, and the test shipped unformatted. Only the lines the run
// changed are its own: they are checked and fixed by range, the old lines stay as they were (#1582).
const OLD_DOCS = "x=1\n\n\ndef test_old():\n    assert True\n";
const APPENDED = `${OLD_DOCS}\n\ndef test_new():\n    x=1\n`;

describe("the lines a task changes in a file it edits", () => {
  test("changed line ranges: appended, replaced and inserted lines; deletions leave none", () => {
    expect(changedLineRanges(OLD_DOCS, APPENDED)).toEqual([[7, 9]]);
    expect(changedLineRanges("a\nb\nc\n", "a\nX\nc\n")).toEqual([[2, 2]]);
    expect(changedLineRanges("a\nb\nc\n", "Z\na\nb\nY\nc\n")).toEqual([[1, 1], [4, 4]]);
    expect(changedLineRanges("a\nb\nc\n", "a\nc\n")).toEqual([]);
  });

  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "baked-format-lines-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  test.skipIf(IS_WIN)("ruff: one range check per changed block, fixed by range on that file only", () => {
    const root = project({ ...PROJECT, "tests/test_docs.py": APPENDED, "tests/test_new.py": "x=1\n" });
    const writes = [
      { path: "tests/test_docs.py", action: "modify" },
      { path: "tests/test_new.py", action: "create" },
    ];
    const checks = formatWrittenChecks(root, [], writes, undefined, (path) =>
      path === "tests/test_docs.py" ? OLD_DOCS : undefined,
    );
    expect(checks).toMatchObject([
      { id: "ruff-format-written", args: ["format", "--check", "tests/test_new.py"], fixPaths: ["tests/test_new.py"] },
      { id: "ruff-format-lines", args: ["format", "--check", "--range=7-10", "tests/test_docs.py"], fix: { executable: "ruff", args: ["format", "--range=7-10"] }, fixPaths: ["tests/test_docs.py"], required: true },
    ]);
    // Without its content before the run an edited file is not checked; one the run created is checked whole.
    expect(formatWrittenChecks(root, [], [writes[0]!], undefined, () => undefined)).toEqual([]);
    expect(formatWrittenChecks(root, [], [writes[0]!], undefined, () => null)).toMatchObject([{ id: "ruff-format-written", args: ["format", "--check", "tests/test_docs.py"] }]);
  });

  test.skipIf(IS_WIN)("ruff: the ninth changed block is checked and fixed by its own range", () => {
    const before = Array.from({ length: 9 }, (_, i) => `a${i} = ${i}\n`).join("");
    // Nine blocks: the first eight formatted, only the ninth not.
    const after = Array.from({ length: 9 }, (_, i) => `a${i} = ${i}\n${i === 8 ? "x=1" : "y = 1"}\n`).join("");
    const root = project({ ...PROJECT, "tests/test_many.py": after });
    const checks = formatWrittenChecks(root, [], [{ path: "tests/test_many.py", action: "modify" }], undefined, () => before);
    expect(checks).toHaveLength(9);
    const run = (c: { executable: string; args: string[] }, ...extra: string[]) =>
      spawnSync(c.executable, [...c.args, ...extra], { cwd: root }).status;
    expect(checks.map((c) => run(c))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const ninth = checks[8]!;
    expect(run(ninth.fix!, "tests/test_many.py")).toBe(0);
    expect(run(ninth)).toBe(0);
    expect(readFileSync(join(root, "tests/test_many.py"), "utf8")).toBe(after.replace("x=1", "x = 1"));
  });

  test.skipIf(IS_WIN)("zonevet: the appended test is formatted, the old unformatted line is left alone, and the run completes", async () => {
    const f = workflowFixture();
    try {
      for (const [path, text] of Object.entries({ ...PROJECT, "tests/test_docs.py": OLD_DOCS })) {
        mkdirSync(dirname(join(f.root, path)), { recursive: true });
        writeFileSync(join(f.root, path), text);
      }
      const original = f.executor.execute.bind(f.executor);
      f.executor.execute = async (request: ExecutionRequest) => {
        const out = await original(request);
        if (request.profile.output === "plan") {
          const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] } };
          plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_docs.py", action: "modify" });
          plan.taskGraph.specHash = hashJson(fixtureSpec);
          plan.taskGraph.planHash = hashBytes(plan.markdown);
        }
        if (request.profile.output === "implementation" && request.attemptId) {
          // The edit as the implementer's edit tool journals it: the file's content before it is kept.
          const target = join(f.root, "tests/test_docs.py");
          const store = f.service.store;
          const before = store.transaction(() => capturePreImage(store, request.runId, target));
          const effect = store.transaction(() =>
            store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: "tests/test_docs.py", tool: "edit_file" }, before, null),
          );
          writeFileSync(target, APPENDED);
          store.transaction(() => store.finishFileEffect(request.runId, effect, fileHash(target)));
        }
        return out;
      };
      const run = await f.start();
      let view = await f.service.drive(run.runId, new AbortController().signal);
      expect(view).toMatchObject({ status: "waiting", reason: "approval" });
      await f.approve(run.runId);
      view = await f.service.drive(run.runId, new AbortController().signal);
      expect(view.status).toBe("completed");
      expect(readFileSync(join(f.root, "tests/test_docs.py"), "utf8")).toBe(`${OLD_DOCS}\n\ndef test_new():\n    x = 1\n`);
      expect(readFileSync(join(f.root, "logslice/old.py"), "utf8")).toBe("x=1\n");
    } finally {
      await f.dispose();
    }
  }, 60000);
});
