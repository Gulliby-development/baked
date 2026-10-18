import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDependencies } from "../src/core/workflows/quality/dependencies.js";
import { importedPackages, manifestDependencies, packageOfSpecifier } from "../src/core/workflows/quality/manifests.js";
import { type RegistryFetch, typosquatOf } from "../src/core/workflows/quality/registry.js";
import { runScanner } from "../src/core/workflows/quality/rules.js";
import { runSast } from "../src/core/workflows/quality/sast.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-13T00:00:00Z");
/** A registry that knows `known` (name -> age in days, weekly downloads) and answers 404 otherwise. */
function registry(known: Record<string, [number, number]>, offline = false): { fetch: RegistryFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: RegistryFetch = async (url) => {
    urls.push(url);
    if (offline) throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    const downloads = /downloads\/point\/last-week\/(.+)$/.exec(url)?.[1];
    if (downloads) {
      const entry = known[decodeURIComponent(downloads)];
      return { status: entry ? 200 : 404, json: async () => ({ downloads: entry?.[1] }) };
    }
    const name = decodeURIComponent(/registry\.npmjs\.org\/(.+)$/.exec(url)?.[1] ?? /pypi\/([^/]+)\/json/.exec(url)?.[1] ?? "");
    const entry = known[name];
    if (!entry) return { status: 404, json: async () => ({}) };
    const created = new Date(NOW - entry[0] * DAY).toISOString();
    return {
      status: 200,
      json: async () => ({ time: { created }, releases: { "1.0": [{ upload_time_iso_8601: created }] } }),
    };
  };
  return { fetch, urls };
}

describe("manifests", () => {
  test("each ecosystem's manifest lists its registry dependencies", () => {
    const pkg = JSON.stringify({ dependencies: { zod: "^4", local: "workspace:*" }, devDependencies: { "@types/bun": "1" } }, null, 2);
    expect(manifestDependencies("package.json", pkg).map((d) => d.name)).toEqual(["zod", "@types/bun"]);
    expect(manifestDependencies("requirements.txt", "requests>=2\n# c\n-e .\nPython_Dateutil==2\n").map((d) => d.name)).toEqual([
      "requests",
      "python-dateutil",
    ]);
    const pyproject = '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "rich",\n]\n[tool.poetry.dependencies]\npython = "^3.12"\nclick = "^8"\n';
    expect(manifestDependencies("pyproject.toml", pyproject).map((d) => d.name)).toEqual(["httpx", "rich", "click"]);
    const cargo = '[package]\nname = "x"\n[dependencies]\nserde = { version = "1" }\nlocal = { path = "../l" }\nfoo = { package = "bar", version = "1" }\n[dev-dependencies]\nproptest = "1"\n';
    expect(manifestDependencies("Cargo.toml", cargo).map((d) => d.name)).toEqual(["serde", "bar", "proptest"]);
    expect(manifestDependencies("go.mod", "module x\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\nrequire golang.org/x/text v0.3.0\n").map((d) => d.name)).toEqual([
      "github.com/spf13/cobra",
      "golang.org/x/text",
    ]);
    expect(manifestDependencies("app/App.csproj", '<PackageReference Include="Serilog" Version="3" />').map((d) => d.name)).toEqual(["Serilog"]);
    expect(manifestDependencies("pom.xml", "<dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency>").map((d) => d.name)).toEqual(["junit:junit"]);
  });

  test("bare imports name packages; relative, builtin and alias paths do not", () => {
    expect(packageOfSpecifier("lodash/fp")).toBe("lodash");
    expect(packageOfSpecifier("@scope/pkg/sub")).toBe("@scope/pkg");
    for (const s of ["./a", "node:fs", "fs", "path/posix", "bun:test", "@/lib", "~/x", "#internal"]) expect(packageOfSpecifier(s)).toBeNull();
    const code = 'import a from "left-padx";\nconst b = require("chalk");\nimport("./lazy.js");\n';
    expect(importedPackages("src/a.ts", code, new Set([0, 1, 2])).map((d) => d.name)).toEqual(["left-padx", "chalk"]);
    expect(importedPackages("src/a.ts", code, new Set([1])).map((d) => d.name)).toEqual(["chalk"]);
  });

  test("typosquats of popular packages are recognized, the popular ones are not", () => {
    expect(typosquatOf("npm", "expresss")).toBe("express");
    expect(typosquatOf("pypi", "reqeusts")).toBe("requests");
    expect(typosquatOf("npm", "express")).toBeNull();
    expect(typosquatOf("npm", "left-pad")).toBeNull();
  });
});

describe("dependency check", () => {
  const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "app", dependencies: deps }, null, 2);

  test("a made-up package blocks; a known one is listed", async () => {
    const { fetch } = registry({ zod: [2000, 30_000_000] });
    const result = await checkDependencies(
      [{ path: "package.json", before: pkg({}), content: pkg({ zod: "^4", "zod-validatorz": "^1" }) }],
      new Set(),
      { lookups: true, fetcher: fetch, now: NOW },
    );
    expect(result.dependencies.map((d) => [d.name, d.verdict, d.blocking])).toEqual([
      ["zod", "ok", false],
      ["zod-validatorz", "missing", true],
    ]);
  });

  test("typosquats and packages published days ago block; rare ones are noted", async () => {
    const { fetch } = registry({ expresss: [400, 12], "brand-new-lib": [3, 5000], "quiet-lib": [900, 20] });
    const result = await checkDependencies(
      [{ path: "package.json", before: null, content: pkg({ expresss: "1", "brand-new-lib": "1", "quiet-lib": "1" }) }],
      new Set(),
      { lookups: true, fetcher: fetch, now: NOW },
    );
    expect(result.dependencies.map((d) => [d.name, d.verdict, d.blocking])).toEqual([
      ["expresss", "typosquat", true],
      ["brand-new-lib", "new-package", true],
      ["quiet-lib", "rare", false],
    ]);
  });

  test("an import of a package that does not exist blocks; offline is inconclusive", async () => {
    const files = [{ path: "src/a.ts", before: "export {};\n", content: 'import pad from "left-padx";\nimport { z } from "zod";\nexport {};\n' }];
    const online = await checkDependencies(files, new Set(["zod"]), { lookups: true, fetcher: registry({}).fetch, now: NOW });
    expect(online.dependencies.map((d) => [d.name, d.kind, d.verdict, d.blocking])).toEqual([["left-padx", "imported", "missing", true]]);
    const offline = await checkDependencies(files, new Set(["zod"]), { lookups: true, fetcher: registry({}, true).fetch, now: NOW });
    expect(offline.dependencies.map((d) => [d.verdict, d.blocking])).toEqual([["unknown", false]]);
    const off = registry({});
    const noLookups = await checkDependencies(files, new Set(["zod"]), { lookups: false, fetcher: off.fetch, now: NOW });
    expect(noLookups.dependencies[0]?.verdict).toBe("unknown");
    expect(off.urls).toEqual([]);
  });

  // dirdrift-update 6b57dc61: FsCheck.Xunit was added to an existing test project although the
  // policy forbids new dependencies; the check listed it as ok.
  test("a package added to an existing manifest that the request and spec do not name blocks", async () => {
    const csproj = (refs: string[]) =>
      `<Project>\n  <ItemGroup>\n${refs.map((r) => `    <PackageReference Include="${r}" Version="1" />`).join("\n")}\n  </ItemGroup>\n</Project>\n`;
    const files = [
      { path: "tests/App.Tests/App.Tests.csproj", before: csproj(["xunit"]), content: csproj(["xunit", "FsCheck.Xunit", "Serilog"]) },
      { path: "tools/new/package.json", before: null, content: pkg({ chalk: "^5" }) },
    ];
    const lookups = { lookups: false, now: NOW };
    const forbidden = await checkDependencies(files, new Set(), { ...lookups, requested: "Add a --json flag; log with Serilog." });
    expect(forbidden.dependencies.map((d) => [d.name, d.verdict, d.blocking])).toEqual([
      ["FsCheck.Xunit", "unrequested", true],
      ["Serilog", "unknown", false],
      ["chalk", "unknown", false],
    ]);
    expect(forbidden.dependencies[0]?.detail).toContain("allowNewDependencies is false");
    // A name that only starts like the package does not request it; without the option nothing is judged.
    const prefix = await checkDependencies(files, new Set(), { ...lookups, requested: "Use FsCheck for property tests and Serilog" });
    expect(prefix.dependencies.find((d) => d.name === "FsCheck.Xunit")?.verdict).toBe("unrequested");
    const open = await checkDependencies(files, new Set(), lookups);
    expect(open.dependencies.every((d) => !d.blocking)).toBe(true);
  });

  test("dependencies already declared at baseline are not the run's", async () => {
    const result = await checkDependencies(
      [{ path: "package.json", before: pkg({ "made-up": "1" }), content: pkg({ "made-up": "2" }) }],
      new Set(),
      { lookups: true, fetcher: registry({}).fetch, now: NOW },
    );
    expect(result.dependencies).toEqual([]);
  });
});

describe("SAST", () => {
  test("Semgrep ERROR matches on added lines block; others are notes; no Semgrep is inconclusive", async () => {
    const file = { path: "src/db.ts", before: "const a = 1;\n", content: 'const a = 1;\ndb.query("SELECT " + id);\neval(x);\n' };
    const output = {
      results: [
        { check_id: "sql-injection", path: "src/db.ts", start: { line: 2 }, extra: { severity: "ERROR", message: "SQL built from input" } },
        { check_id: "eval", path: "src/db.ts", start: { line: 3 }, extra: { severity: "WARNING", message: "eval" } },
        { check_id: "old", path: "src/db.ts", start: { line: 1 }, extra: { severity: "ERROR", message: "old line" } },
      ],
    };
    const calls: string[][] = [];
    const result = await runSast("/repo", [file], "p/default", "semgrep", (_exe, args) => {
      calls.push(args);
      return { status: 1, stdout: JSON.stringify(output), stderr: "" };
    });
    expect(calls[0]).toEqual(["scan", "--json", "--metrics=off", "--quiet", "--config", "p/default", "src/db.ts"]);
    expect(result.findings.map((f) => [f.rule, f.line, f.blocking])).toEqual([
      ["sql-injection", 2, true],
      ["eval", 3, false],
    ]);
    expect((await runSast("/repo", [file], "p/default", null)).note).toBe("Semgrep is not installed");
  });

  test("a scanner runs off the event loop and is stopped at its deadline (#1533)", async () => {
    // spawnSync held the driver's thread for up to 300 s, so its lease heartbeat stopped too.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    const result = await runScanner(process.execPath, ["-e", "await Bun.sleep(10000)"], process.cwd(), 600);
    clearInterval(timer);
    expect(result.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ticks).toBeGreaterThan(5);
    const done = await runScanner(process.execPath, ["-e", "console.log('ok')"], process.cwd(), 10_000);
    expect([done.status, done.stdout.trim()]).toEqual([0, "ok"]);
  });
});

describe("dependency check in a run", () => {
  const firstCheck = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
  class ImportingExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/pad.ts", action: "create" });
        return result;
      }
      if (request.profile.output === "implementation")
        writeFileSync(
          join(this.dir, "src/pad.ts"),
          this.implementations++ === 0
            ? 'import pad from "left-padx";\nexport const padded = pad("a", 3);\nconsole.log(padded);\n'
            : 'export const padded = "a".padStart(3);\nconsole.log(padded);\n',
        );
      return super.execute(request);
    }
  }

  test("an import of a non-existent npm package is blocked before the checks run", async () => {
    const guard = "const t = await Bun.file('src/pad.ts').text().catch(() => ''); if (t.includes('left-padx')) process.exit(1)";
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, { ...firstCheck, id: "guard", args: ["-e", guard] }] },
      executor: (root) => {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
        return new ImportingExecutor(root);
      },
    });
    const lookups = registry({});
    fixture.service.scheduler.registryFetch = lookups.fetch;
    fixture.service.scheduler.semgrep = null;
    try {
      const { service } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const findings = service.store.findings(run.runId).map((f) => ({ status: f.status, body: JSON.parse(f.body_json) }));
      const made = findings.find((f) => String(f.body.claim).startsWith("Dependency left-padx: "));
      expect(made?.body.kind).toBe("security");
      expect(made?.status).toBe("resolved");
      expect(lookups.urls).toContain("https://registry.npmjs.org/left-padx");
      // The guard fails on the bad import, so all-passed checks mean no command ran on that code.
      expect(service.store.checkDetails(run.runId).every((c) => c.status === "passed")).toBe(true);
      const report = runReport(service.store, run.runId);
      expect(report).toContain("Semgrep: not run (Semgrep is not installed).");
    } finally {
      await fixture.dispose();
    }
  });
});

describe("new dependencies in a run on an existing project", () => {
  const csproj = (refs: string[]) =>
    `<Project>\n  <ItemGroup>\n${refs.map((r) => `    <PackageReference Include="${r}" Version="1" />`).join("\n")}\n  </ItemGroup>\n</Project>\n`;
  class AddingExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "tests/App.Tests/App.Tests.csproj", action: "modify" });
        return result;
      }
      if (request.profile.output === "implementation")
        writeFileSync(join(this.dir, "tests/App.Tests/App.Tests.csproj"), csproj(this.implementations++ === 0 ? ["xunit", "FsCheck.Xunit"] : ["xunit"]));
      return super.execute(request);
    }
  }

  test("a package nobody asked for is a blocking finding that the correction removes", async () => {
    // Lookups off: the verdict needs no registry.
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, registryLookups: false },
      executor: (root) => {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/existing.ts"), "export const existing = 1;\n");
        mkdirSync(join(root, "tests/App.Tests"), { recursive: true });
        writeFileSync(join(root, "tests/App.Tests/App.Tests.csproj"), csproj(["xunit"]));
        return new AddingExecutor(root);
      },
    });
    fixture.service.scheduler.semgrep = null;
    try {
      const { service } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const findings = service.store.findings(run.runId).map((f) => ({ status: f.status, body: JSON.parse(f.body_json) }));
      const added = findings.find((f) => String(f.body.claim).startsWith("Dependency FsCheck.Xunit: "));
      expect(added?.body.claim).toContain("allowNewDependencies is false");
      expect(added?.status).toBe("resolved");
    } finally {
      await fixture.dispose();
    }
  });
});
