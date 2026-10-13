import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryDocsCheck } from "../src/core/workflows/doctor.js";
import {
  fetchLibraryDocs,
  type LockedLibrary,
  lockedLibraries,
  taskLibraries,
} from "../src/core/workflows/library-docs.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { prepareStart } from "../src/core/workflows/start.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-library-docs-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const noMcp = async (): Promise<string> => {
  throw new Error("no MCP in this test");
};

describe("locked library versions", () => {
  test("reads package-lock.json, bun.lock, Cargo.lock, uv.lock and go.mod", () => {
    const root = workspace({
      "package-lock.json": JSON.stringify({
        packages: {
          "": { name: "app" },
          "node_modules/commander": { version: "12.1.0" },
          "node_modules/@scope/kit": { version: "2.0.0" },
          "node_modules/commander/node_modules/inner": { version: "1.0.0" },
        },
      }),
      "bun.lock": '{\n  "packages": {\n    "zod": ["zod@3.23.8", "", {}, "sha512-x"],\n    "zod/inner": ["inner@1.0.0", "", {}, "sha512-y"],\n  }\n}\n',
      "Cargo.lock": '[[package]]\nname = "serde"\nversion = "1.0.210"\n\n[[package]]\nname = "clap"\nversion = "4.5.20"\n',
      "uv.lock": '[[package]]\nname = "httpx"\nversion = "0.27.2"\n',
      "go.mod": "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.1\n)\nrequire golang.org/x/text v0.18.0\n",
    });
    const key = (l: LockedLibrary) => `${l.ecosystem}:${l.name}@${l.version}`;
    expect(lockedLibraries(root).map(key)).toEqual([
      "npm:commander@12.1.0",
      "npm:@scope/kit@2.0.0",
      "npm:zod@3.23.8",
      "cargo:serde@1.0.210",
      "cargo:clap@4.5.20",
      "pypi:httpx@0.27.2",
      "go:github.com/spf13/cobra@v1.8.1",
      "go:golang.org/x/text@v0.18.0",
    ]);
  });

  test("a task uses the libraries its files import, then those its text names", () => {
    const root = workspace({
      "src/cli.ts": 'import { Command } from "commander";\nimport { z } from "zod/v4";\n',
      "src/main.rs": "use serde::Deserialize;\n",
      "app/http.py": "import httpx\n",
    });
    const locked: LockedLibrary[] = [
      { name: "commander", version: "12.1.0", ecosystem: "npm" },
      { name: "zod", version: "3.23.8", ecosystem: "npm" },
      { name: "chalk", version: "5.3.0", ecosystem: "npm" },
      { name: "serde", version: "1.0.210", ecosystem: "cargo" },
      { name: "httpx", version: "0.27.2", ecosystem: "pypi" },
    ];
    const task = (path: string, description = "Add the command") => ({
      title: "CLI",
      description,
      writes: [{ path, action: "modify" as const }],
      readHints: [],
    });
    expect(taskLibraries(root, task("src/cli.ts"), locked).map((l) => l.name)).toEqual(["commander", "zod"]);
    expect(taskLibraries(root, task("src/cli.ts", "Color the output with chalk."), locked).map((l) => l.name)).toEqual([
      "commander",
      "zod",
      "chalk",
    ]);
    expect(taskLibraries(root, task("src/main.rs"), locked).map((l) => l.name)).toEqual(["serde"]);
    expect(taskLibraries(root, task("app/http.py"), locked).map((l) => l.name)).toEqual(["httpx"]);
    expect(taskLibraries(root, task("src/new.ts"), locked)).toEqual([]);
  });
});

describe("library docs sources", () => {
  const commander: LockedLibrary = { name: "commander", version: "12.1.0", ecosystem: "npm" };

  test("a directory source reads the file of the locked version only", async () => {
    const root = workspace({
      "docs-cache/commander@12.1.0.md": "# commander 12.1.0\nprogram.option()",
      "docs-cache/@scope/kit/2.0.0.md": "# kit 2",
      "docs-cache/commander@11.0.0.md": "# old",
    });
    expect(await fetchLibraryDocs(root, { dir: "docs-cache" }, commander, noMcp)).toContain("commander 12.1.0");
    expect(
      await fetchLibraryDocs(root, { dir: "docs-cache" }, { name: "@scope/kit", version: "2.0.0", ecosystem: "npm" }, noMcp),
    ).toBe("# kit 2");
    expect(await fetchLibraryDocs(root, { dir: "docs-cache" }, { ...commander, version: "13.0.0" }, noMcp)).toBeNull();
    expect(await fetchLibraryDocs(root, { dir: "docs-cache" }, { ...commander, name: "../secret" }, noMcp)).toBeNull();
    const cut = await fetchLibraryDocs(root, { dir: join(root, "docs-cache"), maxChars: 500 }, commander, async () => "");
    expect(cut).toContain("program.option()");
  });

  test("a long document is cut to maxChars", async () => {
    const root = workspace({ "cache/commander@12.1.0.md": "x".repeat(2000) });
    const text = await fetchLibraryDocs(root, { dir: "cache", maxChars: 500 }, commander, noMcp);
    expect(text?.startsWith("x".repeat(500))).toBe(true);
    expect(text).toContain("[cut at 500 characters]");
  });

  test("an MCP source fills the name and version into the tool arguments", async () => {
    const calls: unknown[] = [];
    const text = await fetchLibraryDocs(
      "/unused",
      { mcp: { server: "context7", tool: "get-library-docs", args: { id: "{name}/v{version}", kind: "{ecosystem}" } } },
      commander,
      async (server, tool, args) => {
        calls.push({ server, tool, args });
        return "docs from MCP";
      },
    );
    expect(text).toBe("docs from MCP");
    expect(calls).toEqual([
      { server: "context7", tool: "get-library-docs", args: { id: "commander/v12.1.0", kind: "npm" } },
    ]);
    const failed = await fetchLibraryDocs("/unused", { mcp: { server: "s", tool: "t" } }, commander, noMcp);
    expect(failed).toBeNull();
  });

  test("doctor warns when the source cannot be reached", () => {
    const root = workspace({ "cache/.keep": "" });
    expect(libraryDocsCheck(root, { dir: "cache" }, []).status).toBe("ok");
    expect(libraryDocsCheck(root, { dir: "missing" }, [])).toMatchObject({ status: "warn", id: "libraryDocs.source" });
    const mcp = { mcp: { server: "context7", tool: "get-library-docs" } };
    expect(libraryDocsCheck(root, mcp, [{ name: "context7" }]).status).toBe("ok");
    expect(libraryDocsCheck(root, mcp, [{ name: "context7", disabled: true }]).title).toContain("disabled");
    expect(libraryDocsCheck(root, mcp, []).title).toContain("not configured");
  });
});

describe("library docs in a run", () => {
  test("a start freezes the configured source into the policy; without one the policy is unchanged", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const plain = await prepareStart(fixture.root, fixture.config, { workflowId: "sdd", policy: fixture.policy });
    expect("libraryDocs" in plain.policy).toBe(false);
    const config = { ...fixture.config, libraryDocs: { dir: "docs-cache" } };
    const frozen = await prepareStart(fixture.root, config, { workflowId: "sdd", policy: fixture.policy });
    expect(frozen.policy.libraryDocs).toEqual({ dir: "docs-cache" });
  });

  test("the implementer gets the docs of the locked version; a run without a source gets none", async () => {
    const run = async (policy: RunPolicy) => {
      const fixture = workflowFixture({ policy });
      cleanups.push(fixture.dispose);
      // The fixture task is described as "Write ready", so the locked package "ready" is the one it names.
      writeFileSync(
        join(fixture.root, "package-lock.json"),
        JSON.stringify({ packages: { "node_modules/ready": { version: "1.2.3" } } }),
      );
      mkdirSync(join(fixture.root, "docs-cache"));
      writeFileSync(join(fixture.root, "docs-cache", "ready@1.2.3.md"), "ready 1.2.3: call ready.now()");
      const started = await fixture.start();
      const signal = new AbortController().signal;
      await fixture.service.drive(started.runId, signal);
      await fixture.approve(started.runId);
      await fixture.service.drive(started.runId, signal);
      return fixture.executor.prompts.implementation?.[0] ?? "";
    };
    expect(await run({ ...fixturePolicy, libraryDocs: { dir: "docs-cache" } })).toContain("ready 1.2.3: call ready.now()");
    expect(await run(fixturePolicy)).not.toContain("ready.now()");
  });
});
