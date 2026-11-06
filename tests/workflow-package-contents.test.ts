import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonExecutable } from "../src/core/workflows/gates.js";
import {
  buildStatus,
  cargoPackageFiles,
  folderFiles,
  gemEntries,
  PACKAGE_CONTENTS,
  npmPackFiles,
  PACKAGE_CONTENTS_NOTE,
  type PackageContents,
  packagingChanges,
  pubPublishFiles,
  QUALITY_PACKAGE_CONTENTS,
  tarEntries,
  zipEntries,
} from "../src/core/workflows/quality/package-contents.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
import { runWorktreeDir } from "../src/core/workflows/worktree.js";

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
  {
    path: "sumgem.gemspec",
    before: 'Gem::Specification.new do |spec|\n  spec.name = "sumgem"\n  spec.version = "0.1.0"\n  spec.files = Dir["lib/**/*.rb"]\nend\n',
    packaging: 'Gem::Specification.new do |spec|\n  spec.name = "sumgem"\n  spec.version = "0.1.0"\n  spec.files = Dir["lib/**/*.rb"] + Dir["data/*.yml"]\nend\n',
    plain: 'Gem::Specification.new do |spec|\n  spec.name = "sumgem"\n  spec.version = "0.2.0"\n  spec.files = Dir["lib/**/*.rb"]\nend\n',
    field: "sumgem.gemspec: files",
  },
  {
    path: "pubspec.yaml",
    before: "name: sumpkg\nversion: 1.0.0\nenvironment:\n  sdk: ^3.0.0\n",
    packaging: "name: sumpkg\nversion: 1.0.0\nenvironment:\n  sdk: ^3.0.0\nexecutables:\n  sumpkg:\n",
    plain: "name: sumpkg\nversion: 1.1.0\nenvironment:\n  sdk: ^3.0.0\n",
    field: "pubspec.yaml: executables",
  },
  {
    path: "mix.exs",
    before: 'defmodule Sumex.MixProject do\n  use Mix.Project\n\n  def project do\n    [app: :sumex, version: "0.1.0", package: package()]\n  end\n\n  defp package do\n    [licenses: ["MIT"], files: ~w(lib mix.exs)]\n  end\nend\n',
    packaging: 'defmodule Sumex.MixProject do\n  use Mix.Project\n\n  def project do\n    [app: :sumex, version: "0.1.0", package: package()]\n  end\n\n  defp package do\n    [licenses: ["MIT"], files: ~w(lib priv mix.exs)]\n  end\nend\n',
    plain: 'defmodule Sumex.MixProject do\n  use Mix.Project\n\n  def project do\n    [app: :sumex, version: "0.2.0", package: package()]\n  end\n\n  defp package do\n    [licenses: ["MIT"], files: ~w(lib mix.exs)]\n  end\nend\n',
    field: "mix.exs: defp package",
  },
  {
    path: "build.sbt",
    before: 'name := "sumsb"\nversion := "0.1.0"\n',
    packaging: 'name := "sumsb"\nversion := "0.1.0"\nCompile / packageBin / mappings += {\n  (baseDirectory.value / "NOTICE") -> "NOTICE"\n}\n',
    plain: 'name := "sumsb"\nversion := "0.2.0"\n',
    field: "build.sbt: Compile",
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

  // #1986: Ruby, Dart, Elixir and sbt packages, listed from what their tools print or build.
  const tool = (language: "ruby" | "dart" | "elixir" | "scala") => {
    const row = PACKAGE_CONTENTS[language];
    if (!Array.isArray(row) || !row[0]) throw new Error(`${language} builds no package`);
    return row[0];
  };
  const scratch = () => mkdtempSync(join(tmpdir(), "baked-package-contents-"));

  test("a .gem lists the files of its data.tar.gz", () => {
    // Built by RubyGems 3.5 from a gemspec with `spec.files = Dir["lib/**/*.rb"] + Dir["data/*.yml"]`.
    const gem = readFileSync(join(import.meta.dir, "fixtures/package-contents/sumgem-0.1.0.gem"));
    expect(gemEntries(gem)).toEqual(["data/table.yml", "lib/sumgem.rb"]);
    const dir = scratch();
    try {
      writeFileSync(join(dir, "sumgem-0.1.0.gem"), gem);
      expect(tool("ruby").builds({ dir, manifest: "sumgem.gemspec", platform: "linux" })).toEqual([
        { executable: "gem", args: ["build", "sumgem.gemspec"] },
      ]);
      expect(tool("ruby").list(dir, "")).toEqual([{ file: "sumgem-0.1.0.gem", files: ["data/table.yml", "lib/sumgem.rb"] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(gemEntries(new TextEncoder().encode("not a gem"))).toBeNull();
    expect(tarEntries(new Uint8Array(1024))).toEqual([]);
  });

  test("dart pub publish --dry-run lists the tree it prints, also when it exits 65 on a warning", () => {
    // Recorded from Dart 3.13 in a git tree with uncommitted files: it warns and exits 65.
    const stdout = "Resolving dependencies...\nDownloading packages...\nGot dependencies!\nPublishing sumpkg 1.0.0 to https://pub.dev:\n\u251c\u2500\u2500 CHANGELOG.md (<1 KB)\n\u251c\u2500\u2500 README.md (<1 KB)\n\u251c\u2500\u2500 bin\n\u2502   \u2514\u2500\u2500 sumpkg.dart (<1 KB)\n\u251c\u2500\u2500 err.txt (<1 KB)\n\u251c\u2500\u2500 lib\n\u2502   \u251c\u2500\u2500 src\n\u2502   \u2502   \u2514\u2500\u2500 a.dart (<1 KB)\n\u2502   \u2514\u2500\u2500 sumpkg.dart (<1 KB)\n\u251c\u2500\u2500 out.txt (<1 KB)\n\u2514\u2500\u2500 pubspec.yaml (<1 KB)\n\nTotal compressed archive size: <1 KB.\nValidating package...\nPackage validation found the following error:\n* You must have a LICENSE file in the root directory.\n  An open-source license helps ensure people can legally use your code.\n\nPackage validation found the following 2 potential issues:\n* 1 checked-in file is ignored by a `.gitignore`.\n  Previous versions of Pub would include those in the published package.\n  \n  Consider adjusting your `.gitignore` files to not ignore those files, and if you do not wish to\n  publish these files use `.pubignore`. See also dart.dev/go/pubignore\n  \n  Files that are checked in while gitignored:\n  \n  LICENSE\n  \n  \n\n* 6 checked-in files are modified in git.\n  \n  Usually you want to publish from a clean git state.\n  \n  Consider committing these files or reverting the changes.\n  \n  Modified files:\n  \n  CHANGELOG.md\n  README.md\n  bin/sumpkg.dart\n  lib/src/a.dart\n  lib/sumpkg.dart\n  pubspec.yaml\n  \n  Run `git status` for more information.\n  \n";
    expect(pubPublishFiles(stdout)).toEqual([
      {
        file: "pub publish --dry-run",
        files: ["CHANGELOG.md", "README.md", "bin/sumpkg.dart", "err.txt", "lib/src/a.dart", "lib/sumpkg.dart", "out.txt", "pubspec.yaml"],
      },
    ]);
    expect(pubPublishFiles("Could not find a file named \"pubspec.yaml\"")).toBeNull();
    expect(tool("dart").listedExits).toEqual([65]);
    const dir = scratch();
    try {
      writeFileSync(join(dir, "pubspec.yaml"), "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n");
      expect(tool("dart").builds({ dir, manifest: "pubspec.yaml", platform: "linux" }).map((c) => c.executable)).toEqual(["flutter", "dart"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mix hex.build --unpack lists the unpacked package without Hex's metadata", () => {
    const dir = scratch();
    try {
      // The files `mix hex.build --unpack` (Hex 2) wrote for `files: ~w(lib priv mix.exs README.md)`.
      for (const path of ["README.md", "hex_metadata.config", "lib/sumex.ex", "mix.exs", "priv/data.yml"]) {
        mkdirSync(join(dir, ".baked-package/hex", path, ".."), { recursive: true });
        writeFileSync(join(dir, ".baked-package/hex", path), "");
      }
      expect(tool("elixir").list(dir, "")).toEqual([
        { file: "mix hex.build", files: ["README.md", "lib/sumex.ex", "mix.exs", "priv/data.yml"] },
      ]);
      expect(folderFiles(join(dir, "missing"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sbt package lists the jar below target/, not its classes or test jars", () => {
    const dir = scratch();
    try {
      for (const folder of ["target/scala-3.7.4/classes", "target/streams"]) mkdirSync(join(dir, folder), { recursive: true });
      // sbt 1.11 packaged `sumsb_3-0.1.0.jar` with a `mappings` entry for NOTICE.
      const names = ["META-INF/MANIFEST.MF", "NOTICE", "Sum$.class", "Sum.class", "Sum.tasty", "data.yml"];
      writeFileSync(join(dir, "target/scala-3.7.4/sumsb_3-0.1.0.jar"), zip(names));
      writeFileSync(join(dir, "target/scala-3.7.4/sumsb_3-0.1.0-sources.jar"), zip(["Sum.scala"]));
      writeFileSync(join(dir, "target/streams/cached.jar"), zip(["x"]));
      expect(tool("scala").list(dir, "")).toEqual([{ file: "sumsb_3-0.1.0.jar", files: names }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  /** A flat-layout project: setuptools discovers the packages, so a `specs/` folder is a second one. */
  const FLAT = BEFORE.replace('\n[tool.setuptools]\npackages = ["keeplint"]\n', "");
  const FLAT_AFTER = `${FLAT}\n[tool.setuptools.package-data]\nkeeplint = ["py.typed"]\n`;

  class WheelExecutor extends FixtureExecutor {
    reviews: string[] = [];
    constructor(
      private readonly dir: string,
      private readonly after = AFTER,
    ) {
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
        writeFileSync(join(this.dir, "pyproject.toml"), this.after);
        writeFileSync(join(this.dir, "keeplint/py.typed"), "");
      }
      return super.execute(request);
    }
  }

  async function packageRun(on: boolean, before = BEFORE, after = AFTER) {
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, ...(on ? { packageContents: "on" as const } : {}) },
      executor: (root) => new WheelExecutor(root, after),
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
      writeFileSync(join(root, "pyproject.toml"), before);
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
      expect(existsSync(join(root, runWorktreeDir(root, run.runId), "quality-package-contents"))).toBe(false);
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

  // Bench round 65 (#2017): the package was built from the run's whole tree, with the spec folder
  // the delivery leaves out (eolscope's `cargo package --list` listed specs/eolscope-version-exclude/*).
  // On a flat-layout project setuptools takes that folder for a second package and the build fails.
  test.skipIf(!canBuild)("the package is built from what the delivery ships, without the run's spec folder", async () => {
    const { record } = await packageRun(true, FLAT, FLAT_AFTER);
    const build = record?.builds[0];
    expect(build).toMatchObject({ tool: "wheel", status: "listed" });
    const files = build?.artifacts.flatMap((artifact) => artifact.files) ?? [];
    expect(files).toContain("keeplint/py.typed");
    expect(files.filter((file) => file.startsWith("specs/"))).toEqual([]);
  }, 240_000);

  test("off by default: no build and no note", async () => {
    const { record, reviews } = await packageRun(false);
    expect(record).toBeNull();
    expect(reviews.some((p) => p.includes("package contents check"))).toBe(false);
  }, 60_000);
});
