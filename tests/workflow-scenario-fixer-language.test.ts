import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { FIXER_LANGUAGES, fixerPaths, fixerProgram } from "../src/core/workflows/fixer-languages.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 86 binlayer (Python and SQL, #2632): the host ran every check's fixer on
// every code file a task wrote. `ruff check --fix` and `ruff format` ran on `.sql` files (exit 1 and
// 2, nothing changed) and `sqlfluff fix` on `.py` files, `fixers/failed.json` showed the ruff parse
// errors to the implementer, and the preflight probe that picked a `.sql` file recorded the ruff
// fixers unusable (12 false `fixer_unusable` would-stops). Here stand-in `ruff` and `sqlfluff`
// fixers record the files they are given.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fixer-language-"));
const log = join(bin, "fixers.log");
const savedPath = process.env.PATH;
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(bin, { recursive: true, force: true });
});
if (!IS_WIN) {
  for (const name of ["ruff", "sqlfluff"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nfor a; do f=$a; done\necho "${name} $f" >> '${log}'\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const check = (id: string, fix: { executable: string; args: string[] }) => ({
  id,
  executable: "bun",
  args: ["-e", "process.exit(0)"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task" as const,
  envNames: [],
  writes: [],
  fix,
});
const lint = check("lint", { executable: "ruff", args: ["check", "--fix"] });
const format = check("format", { executable: "ruff", args: ["format"] });
const sqlfluff = check("sqlfluff", { executable: "sqlfluff", args: ["fix"] });

describe.skipIf(IS_WIN)("scenario: R86 binlayer, fixers on files of another language (#2632)", () => {
  test("the host fixer pass gives ruff only the Python file and sqlfluff only the SQL file", async () => {
    writeFileSync(log, "");
    const policy: RunPolicy = { ...fixturePolicy, checks: [lint, format, sqlfluff, ...fixturePolicy.checks] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { executor, service, root } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
        const task = plan.taskGraph.tasks[0] as { writes: unknown[]; checkIds: string[] };
        task.writes.push({ path: "binlayer.py", action: "create" }, { path: "sql/05_layers.sql", action: "create" });
        task.checkIds = ["lint", "format", "sqlfluff"];
      }
      if (request.profile.output === "implementation") {
        writeFileSync(join(root, "binlayer.py"), "x = 1\n");
        if (!existsSync(join(root, "sql"))) mkdirSync(join(root, "sql"));
        writeFileSync(join(root, "sql/05_layers.sql"), "select 1;\n");
      }
      return out;
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    const runs = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((line) => line.startsWith("ruff ") ? line.endsWith(".py") : line.endsWith(".sql"))).toBe(true);
    expect(new Set(runs)).toEqual(new Set(["ruff binlayer.py", "sqlfluff sql/05_layers.sql"]));
  }, 60000);
});

describe("fixerPaths: a fixer runs on the code files of its languages (#2632)", () => {
  const paths = ["binlayer.py", "sql/05_layers.sql", "README.md", "web/app.ts", "scripts/run.sh"];
  test("each launcher form reads the same program", () => {
    expect([
      fixerProgram({ executable: "ruff", args: ["check", "--fix"] }),
      fixerProgram({ executable: "python", args: ["-m", "ruff", "format"] }),
      fixerProgram({ executable: "C:\\venv\\Scripts\\python.exe", args: ["-m", "sqlfluff", "fix"] }),
      fixerProgram({ executable: "uv", args: ["run", "ruff", "format"] }),
      fixerProgram({ executable: "bunx", args: ["@biomejs/biome@2.1.0", "check", "--write"] }),
      fixerProgram({ executable: "pnpm", args: ["exec", "eslint", "--fix"] }),
    ]).toEqual(["ruff", "ruff", "sqlfluff", "ruff", "biome", "eslint"]);
  });

  test("ruff gets the Python file, sqlfluff the SQL file, both the non-code files; a fixer without a row gets all", () => {
    expect(fixerPaths({ executable: "python", args: ["-m", "ruff", "check", "--fix"] }, paths)).toEqual(["binlayer.py", "README.md"]);
    expect(fixerPaths({ executable: "python", args: ["-m", "sqlfluff", "fix"] }, paths)).toEqual(["sql/05_layers.sql", "README.md"]);
    expect(fixerPaths({ executable: "bunx", args: ["eslint", "--fix"] }, paths)).toEqual(["README.md", "web/app.ts"]);
    expect(fixerPaths({ executable: "bun", args: ["run", "lint:fix"] }, paths)).toEqual(paths);
    // Every file filtered out: the fixer does not run.
    expect(fixerPaths({ executable: "shfmt", args: ["-w"] }, ["a.py", "b.sql"])).toEqual([]);
  });

  test("every row names supported languages", () => {
    for (const languages of Object.values(FIXER_LANGUAGES)) expect(languages.length).toBeGreaterThan(0);
  });
});
