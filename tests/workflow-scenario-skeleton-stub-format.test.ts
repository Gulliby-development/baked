import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { fileHash } from "../src/core/workflows/effects.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 71 (#2243). xmlvet: the skeleton feature wrote R/cli.R as a comment stub,
// a later feature filled it, and the run delivered it unstyled: styler has no range form, so the
// format-written check held the file the feature created and not the stub it edited. Here shfmt,
// another formatter without a range form, stands in: "then" on the `if` line is unformatted.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fake-shfmt-"));
const savedPath = process.env.PATH;
afterAll(async () => {
  process.env.PATH = savedPath;
  await removeTempDir(bin);
});
if (!IS_WIN) {
  // `shfmt -d FILE...` prints and fails on a file with `;then`; `shfmt -w FILE...` formats it.
  writeFileSync(
    join(bin, "shfmt"),
    `#!/bin/sh
mode=$1
shift
bad=0
for f in "$@"; do
  [ -f "$f" ] || continue
  if [ "$mode" = "-d" ]; then
    if grep -q ';then' "$f"; then echo "--- $f"; bad=1; fi
  else
    sed 's/;then/; then/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done
exit $bad
`,
  );
  chmodSync(join(bin, "shfmt"), 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

const STUB = "# Filled by the cli feature.\n";
const FILLED = "if true;then\n  echo ok\nfi\n";

describe.skipIf(IS_WIN)("scenario: xmlvet R71, a skeleton stub a later feature fills (#2243)", () => {
  test("the filled stub is held to the formatter without a range form and delivered formatted", async () => {
    const f = workflowFixture();
    try {
      // A shell project whose shfmt gate is offered but not in the run's checks, and the stub the
      // skeleton feature's run delivered.
      for (const [path, text] of Object.entries({ ".editorconfig": "[*.sh]\nindent_size = 2\n", "bin/cli.sh": STUB })) {
        mkdirSync(dirname(join(f.root, path)), { recursive: true });
        writeFileSync(join(f.root, path), text);
      }
      const original = f.executor.execute.bind(f.executor);
      f.executor.execute = async (request: ExecutionRequest) => {
        const out = await original(request);
        if (request.profile.output === "plan") {
          const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] } };
          plan.taskGraph.tasks[0]?.writes.push({ path: "bin/cli.sh", action: "modify" });
          plan.taskGraph.specHash = hashJson(fixtureSpec);
          plan.taskGraph.planHash = hashBytes(plan.markdown);
        }
        if (request.profile.output === "implementation" && request.attemptId) {
          // The fill as the implementer's edit tool journals it: the stub is the file's base.
          const target = join(f.root, "bin/cli.sh");
          const store = f.service.store;
          const before = store.transaction(() => capturePreImage(store, request.runId, target));
          const effect = store.transaction(() =>
            store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: "bin/cli.sh", tool: "edit_file" }, before, null),
          );
          writeFileSync(target, FILLED);
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
      expect(readFileSync(join(f.root, "bin/cli.sh"), "utf8")).toBe("if true; then\n  echo ok\nfi\n");
      const checked = f.service.store.artifacts(run.runId).filter((a) => a.logical_path.includes("shfmt-written"));
      expect(checked.length).toBeGreaterThan(0);
    } finally {
      await f.dispose();
    }
  });
});
