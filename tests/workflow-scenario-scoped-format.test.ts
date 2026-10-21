import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { formatWrittenChecks } from "../src/core/workflows/format-written.js";
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
// A stand-in for `ruff format`: "x=1" is unformatted, "x = 1" formatted.
if (!IS_WIN) {
  writeFileSync(
    join(bin, "ruff"),
    `#!/bin/sh
[ "$1" = "format" ] || exit 0
shift
if [ "$1" = "--check" ]; then
  shift
  bad=0
  for f in "$@"; do if grep -q 'x=1' "$f"; then echo "Would reformat: $f"; bad=1; fi; done
  exit $bad
fi
for f in "$@"; do sed 's/x=1/x = 1/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
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
          plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_new.py", action: "create" });
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
