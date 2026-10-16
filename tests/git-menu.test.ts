import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { branchNameProblem, readGitOverview, runGitMenuAction } from "../src/core/git/menu.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
// Hooks, signing or aliases in the developer's own Git configuration must not reach these tests.
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
let globalDir = "";
beforeAll(() => {
  globalDir = mkdtempSync(join(tmpdir(), "baked-git-global-"));
  writeFileSync(join(globalDir, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(globalDir, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const [key, value] of [
    ["GIT_CONFIG_GLOBAL", savedEnv.global],
    ["GIT_CONFIG_NOSYSTEM", savedEnv.nosystem],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempDir(globalDir);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A repository with one commit and local identity, independent of the developer's Git config. */
function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), ".baked/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-git-menu-"));
  cleanups.push(() => removeTempDir(dir));
  initRepo(dir);
  return dir;
}

describe("git menu actions", () => {
  test("commits everything when nothing is staged, with one co-author trailer", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    const result = await runGitMenuAction(dir, { action: "commit", message: "Change a" }, { coAuthor: true });
    expect(result).toMatchObject({ ok: true, message: "Committed: Change a" });
    const body = git(dir, "log", "-1", "--format=%B");
    expect(body.match(/Co-Authored-By/g)?.length).toBe(1);
    expect((await readGitOverview(dir)).isDirty).toBe(false);
    expect((await runGitMenuAction(dir, { action: "commit", message: "  " })).message).toBe(
      "Commit message cannot be empty",
    );
  });

  test("stashes and pops, creates and switches branches, resets hard", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    expect((await runGitMenuAction(dir, { action: "stash", message: "wip\nmore" })).ok).toBe(true);
    const stashed = await readGitOverview(dir);
    expect(stashed.isDirty).toBe(false);
    expect(stashed.stashes[0]).toContain("wip more");
    expect((await runGitMenuAction(dir, { action: "stash-pop" })).message).toBe("Stash popped.");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("dirty\n");

    expect(await runGitMenuAction(dir, { action: "create-branch", name: "feature/x" })).toMatchObject({ ok: true });
    expect((await readGitOverview(dir)).branch).toBe("feature/x");
    expect((await runGitMenuAction(dir, { action: "switch-branch", name: "main" })).ok).toBe(true);
    expect((await readGitOverview(dir)).branches.sort()).toEqual(["feature/x", "main"]);
    // A path is not a branch: switching to it must not restore the file.
    expect((await runGitMenuAction(dir, { action: "switch-branch", name: "a.txt" })).ok).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("dirty\n");

    expect((await runGitMenuAction(dir, { action: "reset-hard" })).ok).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
  });

  test("refuses option-like and ref-expression branch names", async () => {
    const dir = tempRepo();
    expect(await branchNameProblem(dir, "-D")).not.toBeNull();
    expect(await branchNameProblem(dir, "@{-1}")).not.toBeNull();
    expect(await branchNameProblem(dir, "a..b")).not.toBeNull();
    expect(await branchNameProblem(dir, "two words")).not.toBeNull();
    expect(await branchNameProblem(dir, "feature/ok")).toBeNull();
  });

  test("push reports Git's reason when there is no remote", async () => {
    const dir = tempRepo();
    const result = await runGitMenuAction(dir, { action: "push" });
    expect(result.ok).toBe(false);
    expect(result.message.startsWith("Push failed: ")).toBe(true);
    expect(result.message.length).toBeGreaterThan("Push failed: ".length);
  });
});

describe("git over the local API", () => {
  test("reads the overview, runs actions and asks for confirmation of destructive ones", async () => {
    const fixture = workflowFixture();
    initRepo(fixture.root);
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    fixture.service.config.coAuthorCommits = false;
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" } });
    const act = (body: unknown) => call("/v1/git/actions", { method: "POST", body: JSON.stringify(body) });

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("git");
    const overview = (await (await call("/v1/git")).json()) as { isRepo: boolean; branch: string; busy: boolean; log: unknown[] };
    expect(overview).toMatchObject({ isRepo: true, branch: "main", busy: false });
    expect(overview.log.length).toBe(1);

    writeFileSync(join(fixture.root, "a.txt"), "two\n");
    const committed = (await (await act({ action: "commit", message: "Edit a" })).json()) as {
      ok: boolean;
      overview: { isDirty: boolean; log: { subject: string }[] };
    };
    expect(committed.ok).toBe(true);
    expect(committed.overview.log[0]?.subject).toBe("Edit a");
    expect(git(fixture.root, "log", "-1", "--format=%B")).not.toContain("Co-Authored-By");

    writeFileSync(join(fixture.root, "a.txt"), "three\n");
    expect((await act({ action: "reset-hard" })).status).toBe(400);
    expect(readFileSync(join(fixture.root, "a.txt"), "utf8")).toBe("three\n");
    expect((await act({ action: "force-push", confirm: false })).status).toBe(400);
    const reset = (await (await act({ action: "reset-hard", confirm: true })).json()) as { ok: boolean };
    expect(reset.ok).toBe(true);
    expect(readFileSync(join(fixture.root, "a.txt"), "utf8")).toBe("two\n");

    const failed = (await (await act({ action: "create-branch", name: "-x" })).json()) as { ok: boolean; message: string };
    expect(failed).toMatchObject({ ok: false });
    expect((await act({ action: "rebase" })).status).toBe(400);
    expect((await act({ action: "push", extra: 1 })).status).toBe(400);
    expect((await call("/v1/git/actions")).status).toBe(405);
  });

  test("answers isRepo false and refuses actions outside a repository", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    const overview = (await (await fetch(`${server.url}/v1/git`, { headers })).json()) as { isRepo: boolean };
    // The temporary folder may sit inside a repository on some machines; only check the shape then.
    if (!overview.isRepo) {
      const answer = await fetch(`${server.url}/v1/git/actions`, { method: "POST", headers, body: JSON.stringify({ action: "pull" }) });
      expect(answer.status).toBe(409);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("NOT_A_REPOSITORY");
      expect((overview as { setup?: string }).setup).toBe("missing");
      // `init` is the one action a folder without Git takes (#1345).
      const init = await fetch(`${server.url}/v1/git/actions`, { method: "POST", headers, body: JSON.stringify({ action: "init" }) });
      const done = (await init.json()) as { ok: boolean; message: string; overview: { isRepo: boolean; setup: string } };
      expect(done).toMatchObject({ ok: true, overview: { isRepo: true, setup: "ready" } });
      expect(done.message).toContain("Initialized Git");
      expect(git(fixture.root, "ls-files")).not.toContain(".baked/");
    }
  });
});
