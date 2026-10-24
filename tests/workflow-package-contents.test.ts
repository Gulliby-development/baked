import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pythonExecutable } from "../src/core/workflows/gates.js";
import {
  buildStatus,
  cargoPackageFiles,
  npmPackFiles,
  PACKAGE_CONTENTS_NOTE,
  type PackageContents,
  packagingChanges,
  QUALITY_PACKAGE_CONTENTS,
  zipEntries,
} from "../src/core/workflows/quality/package-contents.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 63 (keeplint, #1984): a Python update added `py.typed` package data to pyproject.toml,
// and the criterion "the built wheel contains py.typed" ended inconclusive because no check built
// the package. With `packageContents: on` the host builds it and records the files it holds.

/** One manifest per row: a change of a packaging field, and a change that builds nothing. */
const MANIFESTS = [
  {
    path: "pyproject.toml",
    before: '[project]\nname = "keeplint"\nversion = "0.1.0"\n\n[tool.setuptools]\npackages = ["keeplint"]\n',
    packaging: '[project]\nname = "keeplint"\nversion = "0.1.0"\n\n[tool.setuptools]\npackages = ["keeplint"]\n\n[tool.setuptools.package-data]\nkeeplint = ["py.typed"]\n',
    plain: '[project]\nname = "keeplint"\nversion = "0.2.0"\n\n[tool.setuptools]\npackages = ["keeplint"]\n',
    field: "pyproject.toml: tool.setuptools.package-data",
  },
  {
    path: "setup.cfg",
    before: "[metadata]\nname = keeplint\nversion = 0.1.0\n\n[options]\npackages = find:\n",
    packaging: "[metadata]\nname = keeplint\nversion = 0.1.0\n\n[options]\npackages = find:\n\n[options.package_data]\nkeeplint = py.typed\n",
    plain: "[metadata]\nname = keeplint\nversion = 0.2.0\n\n[options]\npackages = find:\n",
    field: "setup.cfg: options.package_data",
  },
  {
    path: "pkg/Cargo.toml",
    before: '[package]\nname = "keeplint"\nversion = "0.1.0"\n',
    packaging: '[package]\nname = "keeplint"\nversion = "0.1.0"\ninclude = ["src/**", "py.typed"]\n',
    plain: '[package]\nname = "keeplint"\nversion = "0.2.0"\n',
    field: "pkg/Cargo.toml: package.include",
  },
  {
    path: "pom.xml",
    before: "<project><artifactId>keeplint</artifactId><version>0.1.0</version></project>",
    packaging: "<project><artifactId>keeplint</artifactId><version>0.1.0</version><build><resources><resource><directory>data</directory></resource></resources></build></project>",
    plain: "<project><artifactId>keeplint</artifactId><version>0.2.0</version></project>",
    field: "pom.xml: resources",
  },
  {
    path: "build.gradle.kts",
    before: 'plugins {\n    java\n}\nversion = "0.1.0"\n',
    packaging: 'plugins {\n    java\n}\nversion = "0.1.0"\ntasks.jar {\n    from("data")\n}\n',
    plain: 'plugins {\n    java\n}\nversion = "0.2.0"\n',
    field: "build.gradle.kts: tasks.jar",
  },
  {
    path: "src/App/App.csproj",
    before: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Version>0.1.0</Version></PropertyGroup></Project>',
    packaging: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Version>0.1.0</Version></PropertyGroup><ItemGroup><None Include="README.md" Pack="true" PackagePath="\\" /></ItemGroup></Project>',
    plain: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Version>0.2.0</Version></PropertyGroup></Project>',
    field: "src/App/App.csproj: packed items",
  },
  {
    path: "package.json",
    before: '{"name":"keeplint","version":"0.1.0","files":["lib"]}',
    packaging: '{"name":"keeplint","version":"0.1.0","files":["lib","types"]}',
    plain: '{"name":"keeplint","version":"0.2.0","files":["lib"]}',
    field: "package.json: files",
  },
] as const;

/** A zip archive of empty stored entries: enough for the central directory reader. */
function zip(names: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    const bytes = encoder.encode(name);
    const local = new Uint8Array(30 + bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(26, bytes.length, true);
    local.set(bytes, 30);
    const central = new Uint8Array(46 + bytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(28, bytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(bytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("package contents check (#1984)", () => {
  for (const row of MANIFESTS) {
    test(`${row.path}: a packaging field change builds the package`, () => {
      const [change] = packagingChanges([{ path: row.path, before: row.before, content: row.packaging }]);
      expect(change?.fields).toContain(row.field);
    });
    test(`${row.path}: a change outside the packaging fields builds nothing`, () => {
      expect(packagingChanges([{ path: row.path, before: row.before, content: row.plain }])).toEqual([]);
    });
  }

  test("a created manifest counts every packaging field; MANIFEST.in and a nuspec count any change", () => {
    const changes = packagingChanges([
      { path: "pyproject.toml", before: null, content: MANIFESTS[0].packaging },
      { path: "MANIFEST.in", before: "include README.md\n", content: "include README.md\ninclude keeplint/py.typed\n" },
      { path: "src/App/App.nuspec", before: "<package/>", content: "<package><files/></package>" },
    ]);
    expect(changes.map((c) => [c.tool.id, c.dir])).toEqual([
      ["wheel", "."],
      ["nupkg", "src/App"],
    ]);
    expect(changes[0]?.fields).toEqual(
      expect.arrayContaining(["pyproject.toml: tool.setuptools", "pyproject.toml: tool.setuptools.package-data", "MANIFEST.in: file"]),
    );
  });

  test("a wheel, jar or nupkg lists its files from the zip's central directory", () => {
    const names = ["keeplint/__init__.py", "keeplint/py.typed", "keeplint-0.1.0.dist-info/", "keeplint-0.1.0.dist-info/RECORD"];
    expect(zipEntries(zip(names))).toEqual(["keeplint/__init__.py", "keeplint/py.typed", "keeplint-0.1.0.dist-info/RECORD"]);
    expect(zipEntries(new TextEncoder().encode("not a zip archive at all, only text"))).toBeNull();
  });

  test("npm pack --dry-run --json lists the packed files", () => {
    // Recorded from npm 10 for a package with `"files": ["lib"]`.
    const stdout = '[\n  {\n    "id": "keeplint@0.1.0",\n    "name": "keeplint",\n    "version": "0.1.0",\n    "filename": "keeplint-0.1.0.tgz",\n    "files": [\n      { "path": "lib/index.d.ts", "size": 2, "mode": 420 },\n      { "path": "lib/index.js", "size": 2, "mode": 420 },\n      { "path": "package.json", "size": 78, "mode": 420 }\n    ],\n    "entryCount": 3,\n    "bundled": []\n  }\n]\n';
    expect(npmPackFiles(stdout)).toEqual([{ file: "keeplint-0.1.0.tgz", files: ["lib/index.d.ts", "lib/index.js", "package.json"] }]);
    expect(npmPackFiles("npm ERR! code E404")).toBeNull();
  });

  test("cargo package --list lists one file per line", () => {
    // Recorded from cargo 1.8x for a crate with `include = ["src/**", "py.typed"]`.
    expect(cargoPackageFiles("Cargo.lock\nCargo.toml\nCargo.toml.orig\npy.typed\nsrc/lib.rs\n")).toEqual([
      { file: "cargo package --list", files: ["Cargo.lock", "Cargo.toml", "Cargo.toml.orig", "py.typed", "src/lib.rs"] },
    ]);
    expect(cargoPackageFiles("")).toBeNull();
  });

  test("a missing tool or a failed build is a status of the record, never a finding", () => {
    expect(buildStatus([{ command: "cargo package --list", result: "missing" }])).toBe("missing");
    expect(buildStatus([{ command: "a", result: "missing" }, { command: "b", result: "failed" }])).toBe("failed");
    expect(buildStatus([{ command: "a", result: "failed" }, { command: "b", result: "listed" }])).toBe("listed");
    expect(PACKAGE_CONTENTS_NOTE.review).toContain(QUALITY_PACKAGE_CONTENTS);
    expect(PACKAGE_CONTENTS_NOTE.spec).toContain("automated");
  });

  const BEFORE = '[build-system]\nrequires = ["setuptools>=61"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "keeplint"\nversion = "0.1.0"\n\n[tool.setuptools]\npackages = ["keeplint"]\n';
  const AFTER = `${BEFORE}\n[tool.setuptools.package-data]\nkeeplint = ["py.typed"]\n`;

  class WheelExecutor extends FixtureExecutor {
    reviews: string[] = [];
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "review") this.reviews.push(request.prompt);
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "pyproject.toml", action: "modify" }, { path: "keeplint/py.typed", action: "create" });
        return result;
      }
      if (request.profile.output === "implementation") {
        writeFileSync(join(this.dir, "pyproject.toml"), AFTER);
        writeFileSync(join(this.dir, "keeplint/py.typed"), "");
      }
      return super.execute(request);
    }
  }

  async function packageRun(on: boolean) {
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, ...(on ? { packageContents: "on" as const } : {}) },
      executor: (root) => new WheelExecutor(root),
    });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    try {
      const { service, root } = fixture;
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Test User");
      git("config", "user.email", "test@example.test");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(root, "keeplint"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), ".baked/\n");
      writeFileSync(join(root, "pyproject.toml"), BEFORE);
      writeFileSync(join(root, "keeplint/__init__.py"), "VERSION = 1\n");
      git("add", ".");
      git("commit", "-q", "-m", "Initial");
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      // The build ran in a copy: the run's tree has no build output and the copy is gone.
      for (const output of [".baked-package", "build", "keeplint.egg-info"]) expect(existsSync(join(root, output))).toBe(false);
      expect(existsSync(join(root, ".baked/worktrees", run.runId, "quality-package-contents"))).toBe(false);
      const artifact = service.store.latestArtifact(run.runId, QUALITY_PACKAGE_CONTENTS);
      return {
        record: artifact ? (JSON.parse(service.store.readArtifact(run.runId, artifact.id)) as PackageContents) : null,
        reviews: (fixture.executor as WheelExecutor).reviews,
      };
    } finally {
      await fixture.dispose();
    }
  }

  const python = pythonExecutable();
  const canBuild =
    Bun.which(python) !== null &&
    (Bun.spawnSync([python, "-m", "build", "--version"]).exitCode === 0 ||
      Bun.spawnSync([python, "-m", "pip", "--version"]).exitCode === 0);

  test.skipIf(!canBuild)("the wheel built after the pyproject edit lists py.typed", async () => {
    const { record, reviews } = await packageRun(true);
    const build = record?.builds[0];
    expect(build).toMatchObject({ tool: "wheel", dir: ".", status: "listed" });
    expect(build?.fields).toContain("pyproject.toml: tool.setuptools.package-data");
    const wheel = build?.artifacts[0];
    expect(wheel?.file).toMatch(/^keeplint-0\.1\.0-.*\.whl$/);
    expect(wheel?.files).toContain("keeplint/py.typed");
    expect(reviews.some((p) => p.includes("quality/package-contents.json is the package contents check"))).toBe(true);
  }, 240_000);

  test("off by default: no build and no note", async () => {
    const { record, reviews } = await packageRun(false);
    expect(record).toBeNull();
    expect(reviews.some((p) => p.includes("package contents check"))).toBe(false);
  }, 60_000);
});
