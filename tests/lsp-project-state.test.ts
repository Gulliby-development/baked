import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  excludeServerFiles,
  serverProjectState,
} from "../src/core/intelligence/backends/lsp/server-registry.js";
import { StandaloneLspClient } from "../src/core/intelligence/backends/lsp/standalone-client.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// Bench R38 stoptable and R42 fecsmith (#1508): jdtls served a workflow task's Java files rooted
// at the user's checkout (task worktrees map to it) and imported the Maven project in place, so
// the checkout was left with untracked `.project`, `.classpath` and `.settings/`.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

function mavenCheckout(): string {
  const root = temp("baked-jdtls-checkout-");
  git(root, "init", "-q");
  writeFileSync(join(root, "pom.xml"), "<project/>\n");
  return root;
}

/**
 * A stand-in for jdtls: it records its arguments and initialize request, and imports the project
 * as an old jdtls does, writing the Eclipse files at the root unless told not to. `legacy` ignores
 * the preference, as servers before it existed do.
 */
function fakeJdtls(legacy: boolean): { command: string; log: string } {
  const dir = temp("baked-fake-jdtls-");
  const log = join(dir, "log.json");
  const command = join(dir, "jdtls");
  writeFileSync(
    command,
    `#!/usr/bin/env bun
const { writeFileSync, mkdirSync } = require("node:fs");
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === "initialize") {
      const options = message.params.initializationOptions;
      writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), options }));
      const atRoot = ${legacy} || options?.settings?.java?.import?.generatesMetadataFilesAtProjectRoot !== false;
      if (atRoot) {
        writeFileSync(".project", "<projectDescription/>");
        writeFileSync(".classpath", "<classpath/>");
        mkdirSync(".settings", { recursive: true });
        writeFileSync(".settings/org.eclipse.jdt.core.prefs", "");
      }
      send({ id: message.id, result: { capabilities: {} } });
    } else if (message.method === "shutdown") send({ id: message.id, result: null });
    else if (message.method === "exit") process.exit(0);
  }
});
`,
  );
  chmodSync(command, 0o755);
  return { command, log };
}

async function startJdtls(root: string, legacy: boolean) {
  const fake = fakeJdtls(legacy);
  const client = new StandaloneLspClient({ command: fake.command, args: [], language: "java" }, root);
  cleanups.push(() => client.stop());
  await client.start();
  return JSON.parse(readFileSync(fake.log, "utf8")) as { argv: string[]; options: unknown };
}

describe.skipIf(process.platform === "win32")("a language server on the user's checkout (#1508)", () => {
  test("jdtls keeps its workspace and the Eclipse files out of the checkout", async () => {
    const root = mavenCheckout();
    const started = await startJdtls(root, false);
    expect(started.options).toEqual({
      settings: { java: { import: { generatesMetadataFilesAtProjectRoot: false } } },
    });
    const data = started.argv[started.argv.indexOf("-data") + 1] ?? "";
    expect(started.argv).toContain("-data");
    expect(data.startsWith(root)).toBe(false);
    expect(existsSync(join(root, ".project"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("?? pom.xml");
  });

  test("the files of a jdtls that writes them at the root anyway stay untracked and unlisted", async () => {
    const root = mavenCheckout();
    await startJdtls(root, true);
    expect(existsSync(join(root, ".classpath"))).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("?? pom.xml");
  });
});

describe("the project state of language servers (#1508)", () => {
  test("is found by command name or resolved path on every platform", () => {
    for (const command of ["jdtls", "/opt/mason/bin/jdtls", "C:\\Users\\a\\mason\\bin\\jdtls.cmd"])
      expect([command, serverProjectState(command)?.excludes]).toEqual([
        command,
        [".project", ".classpath", ".settings/", ".factorypath"],
      ]);
    expect(serverProjectState("metals")?.excludes).toEqual(["/.metals/", "/.bloop/", "/.bsp/"]);
    expect(serverProjectState("elixir-ls.bat")?.excludes).toEqual(["/.elixir_ls/"]);
    expect(serverProjectState("gopls")).toBeUndefined();
  });

  test("the jdtls workspace is one directory per project, outside it", () => {
    const args = serverProjectState("jdtls")?.args;
    const a = args?.("/work/a") ?? [];
    expect(a[0]).toBe("-data");
    expect(a).toEqual(args?.("/work/a") ?? []);
    expect(a).not.toEqual(args?.("/work/b") ?? []);
    expect(a[1]?.startsWith("/work/a")).toBe(false);
  });

  test("excludes are added once to the local exclude file, of a linked worktree too", () => {
    const root = mavenCheckout();
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(temp("baked-jdtls-worktree-"), "wt");
    git(root, "worktree", "add", "-q", worktree);
    excludeServerFiles(worktree, ["/.metals/", "/.bloop/"]);
    excludeServerFiles(root, ["/.metals/", "/.bsp/"]);
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line.startsWith("/."))).toEqual([
      "/.metals/",
      "/.bloop/",
      "/.bsp/",
    ]);
  });

  test("a folder outside Git is left as it is", () => {
    const root = temp("baked-jdtls-nogit-");
    excludeServerFiles(root, [".project"]);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});
