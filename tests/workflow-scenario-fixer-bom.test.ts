import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEndings, restoreEndings } from "../src/core/tools/line-endings.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// wrapsmith (R84, PowerShell, #2592). `Invoke-ScriptAnalyzer -Fix` saves every file it changes as
// UTF-8 with a byte-order mark: four delivered files started with EF BB BF that their pre-images
// did not have. The host keeps the file's BOM state, the way it keeps its LF ending (#2214).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const startsWithBom = (path: string) => readFileSync(path).subarray(0, 3).equals(BOM);

// The fixer of a lint check that writes like PSScriptAnalyzer: it corrects `bad` and adds a BOM.
const BOM_FIXER = {
  executable: "bun",
  args: [
    "-e",
    "const f = process.argv.at(-1); const t = (await Bun.file(f).text()).replace(/^\\uFEFF/, ''); await Bun.write(f, '\\uFEFF' + t.replace('bad', 'good'))",
  ],
};
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [
    {
      id: "lint",
      executable: "bun",
      args: ["-e", "if ((await Bun.file('value.txt').text()).includes('bad')) process.exit(1)"],
      cwd: ".",
      timeoutMs: 60000,
      required: true,
      scope: "task",
      envNames: [],
      writes: [],
      fix: BOM_FIXER,
    },
    ...fixturePolicy.checks,
  ],
};

describe("scenario: wrapsmith, a fixer that adds a UTF-8 BOM (#2592)", () => {
  test("the host fixer pass delivers the fixed file without the BOM its pre-image lacked", async () => {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
        (plan.taskGraph.tasks[0] as Record<string, unknown>).checkIds = ["lint"];
      }
      if (request.profile.output === "implementation") writeFileSync(join(root, "value.txt"), "bad\nnext line\n");
      return out;
    };
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
      await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("good\nnext line\n");
    expect(startsWithBom(join(root, "value.txt"))).toBe(false);
  }, 60_000);
});

describe("restoreEndings keeps the BOM state (#2592)", () => {
  test("strips a BOM the fixer added, keeps one the file had, and fixes CRLF and BOM together", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-bom-"));
    cleanups.push(() => removeTempDir(dir));
    const plain = join(dir, "Plain.ps1");
    const marked = join(dir, "Marked.ps1");
    const both = join(dir, "Both.ps1");
    const empty = join(dir, "Empty.ps1");
    writeFileSync(plain, "function A {}\n");
    writeFileSync(marked, Buffer.concat([BOM, Buffer.from("function B {}\n")]));
    writeFileSync(both, "function C {}\n");
    writeFileSync(empty, "");
    const before = captureEndings([plain, marked, both, empty]);
    writeFileSync(plain, Buffer.concat([BOM, Buffer.from("function A { }\n")]));
    writeFileSync(marked, Buffer.concat([BOM, Buffer.from("function B { }\n")]));
    writeFileSync(both, Buffer.concat([BOM, Buffer.from("function C { }\r\n")]));
    writeFileSync(empty, BOM);
    expect(restoreEndings(before).sort()).toEqual([both, empty, plain].sort());
    expect(readFileSync(plain, "utf8")).toBe("function A { }\n");
    expect(startsWithBom(marked)).toBe(true);
    expect(readFileSync(both)).toEqual(Buffer.from("function C { }\n"));
    expect(readFileSync(empty).length).toBe(0);
    // Nothing to restore the second time.
    expect(restoreEndings(captureEndings([plain, marked, both]))).toEqual([]);
  });
});
