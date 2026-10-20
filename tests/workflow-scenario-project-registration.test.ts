import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  planConsistencyProblems,
  withModuleDependencies,
} from "../src/core/workflows/plan-consistency.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { Task } from "../src/core/workflows/types.js";

// #1684, the #1299 pattern one level up: a task creates code in a new .NET project, Maven module
// or Cargo crate while a later task adds the project file or registers it (the solution, the
// parent pom's <modules>, the workspace members). The creating task's build never compiles that
// code, so its errors surface only after the project joins the build.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const task = (id: string, writes: Array<[string, "create" | "modify"]>, dependsOn: string[] = []): Task => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes: writes.map(([path, action]) => ({ path, action })),
  readHints: [],
  checkIds: ["build"],
  origin: "planned",
  findingIds: [],
  rationale: id,
});
const graphOf = (...tasks: Task[]): TaskGraph => ({
  schemaVersion: 1,
  featureId: "f",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks,
});
const spec = {
  requirements: [{ id: "FR-001" }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"] }],
} as unknown as Spec;
const workspace = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "baked-project-registration-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const registration = (graph: TaskGraph, root: string) =>
  planConsistencyProblems(root, spec, "", withModuleDependencies(graph)).filter((p) =>
    / in the (?:\.NET project|Maven module|Cargo crate) /.test(p),
  );

const SLN = { "App.sln": 'Project("{FAE0}") = "Core", "src\\Core\\Core.csproj", "{1}"\nEndProject\n', "src/Core/Core.csproj": "<Project />" };
const POM = { "pom.xml": "<project><modules><module>core</module></modules></project>", "core/pom.xml": "<project />" };
const CARGO = { "Cargo.toml": '[workspace]\nmembers = ["core"]\n', "core/Cargo.toml": "[package]\n", "core/src/lib.rs": "" };

describe(".NET: a project the solution gains later (#1684)", () => {
  test("code created before its project file and solution entry is sent back", () => {
    const root = workspace(SLN);
    const graph = graphOf(
      task("T001", [["src/Reports/ReportBuilder.cs", "create"], ["src/Reports/ReportRow.cs", "create"]]),
      task("T002", [["src/Reports/Reports.csproj", "create"], ["App.sln", "modify"]], ["T001"]),
    );
    expect(registration(graph, root)).toEqual([
      "T001 creates src/Reports/ReportBuilder.cs in the .NET project src/Reports, but src/Reports/Reports.csproj is written by T002, not by T001 or a task before it, so T001's checks (build) never build that code and its errors surface only after the project is added. Add src/Reports/Reports.csproj to T001's writes (or to a task it depends on) and register the project there; the host orders tasks that write the same file.",
    ]);
  });

  test("a task that writes the project but leaves the solution entry to a later task is sent back", () => {
    const root = workspace(SLN);
    const graph = graphOf(
      task("T001", [["src/Reports/Reports.csproj", "create"], ["src/Reports/ReportBuilder.cs", "create"]]),
      task("T002", [["App.sln", "modify"], ["tests/Reports.Tests/ReportTests.cs", "create"]], ["T001"]),
    );
    const problems = registration(graph, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("but App.sln is written by T002");
  });

  test("passes when the same task, or one it depends on, registers the project", () => {
    const root = workspace(SLN);
    expect(
      registration(
        graphOf(task("T001", [["src/Reports/Reports.csproj", "create"], ["App.sln", "modify"], ["src/Reports/ReportBuilder.cs", "create"]])),
        root,
      ),
    ).toEqual([]);
    expect(
      registration(
        graphOf(
          task("T001", [["src/Reports/Reports.csproj", "create"], ["App.sln", "modify"]]),
          task("T002", [["src/Reports/ReportBuilder.cs", "create"]], ["T001"]),
          task("T003", [["App.sln", "modify"]], ["T002"]),
        ),
        root,
      ),
    ).toEqual([]);
    // Code in an existing project: the project file a later task edits is already built.
    expect(
      registration(
        graphOf(task("T001", [["src/Core/Parser.cs", "create"]]), task("T002", [["src/Core/Core.csproj", "modify"]], ["T001"])),
        root,
      ),
    ).toEqual([]);
  });
});

describe("Maven: a module the parent pom lists later (#1684)", () => {
  test("code created before the parent's <modules> entry is sent back", () => {
    const root = workspace(POM);
    const graph = graphOf(
      task("T001", [["report/pom.xml", "create"], ["report/src/main/java/app/Report.java", "create"]]),
      task("T002", [["pom.xml", "modify"]], ["T001"]),
    );
    const problems = registration(graph, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("T001 creates report/src/main/java/app/Report.java in the Maven module report, but pom.xml is written by T002");
  });

  test("passes when the task writes the parent pom, or the module is already listed", () => {
    expect(
      registration(
        graphOf(task("T001", [["report/pom.xml", "create"], ["pom.xml", "modify"], ["report/src/main/java/app/Report.java", "create"]])),
        workspace(POM),
      ),
    ).toEqual([]);
    const listed = workspace({ ...POM, "pom.xml": "<project><modules><module>core</module><module>./report/</module></modules></project>" });
    expect(
      registration(
        graphOf(task("T001", [["report/pom.xml", "create"], ["report/src/main/java/app/Report.java", "create"]]), task("T002", [["pom.xml", "modify"]], ["T001"])),
        listed,
      ),
    ).toEqual([]);
  });
});

describe("Cargo: a crate the workspace members gain later (#1684)", () => {
  test("a new member crate's code is sent back when the root Cargo.toml lists it later", () => {
    const root = workspace(CARGO);
    const graph = graphOf(
      task("T001", [["report/Cargo.toml", "create"], ["report/src/lib.rs", "create"]]),
      task("T002", [["Cargo.toml", "modify"]], ["T001"]),
    );
    const problems = registration(graph, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("in the Cargo crate report, but Cargo.toml is written by T002");
  });

  test("a members glob that already covers the crate passes", () => {
    const root = workspace({ ...CARGO, "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n' });
    const graph = graphOf(
      task("T001", [["crates/report/Cargo.toml", "create"], ["crates/report/src/lib.rs", "create"]]),
      task("T002", [["Cargo.toml", "modify"]], ["T001"]),
    );
    expect(registration(graph, root)).toEqual([]);
  });
});

describe("toolchains without project registration (#1684)", () => {
  test("Go, Python and TypeScript files are not checked", () => {
    const root = workspace({ "go.mod": "module x\n", "pyproject.toml": "", "package.json": "{}" });
    const graph = graphOf(
      task("T001", [["report/report.go", "create"], ["pkg/report.py", "create"], ["web/report.ts", "create"]]),
      task("T002", [["go.mod", "modify"], ["pyproject.toml", "modify"], ["package.json", "modify"]], ["T001"]),
    );
    expect(registration(graph, root)).toEqual([]);
  });
});
