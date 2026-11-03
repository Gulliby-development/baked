import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { providerAccountsView } from "../src/core/llm/account-overview.js";
import {
  type CliLoginBackend,
  cliLoginSettled,
  setCliLoginBackend,
  startCliLogin,
} from "../src/core/llm/cli-login.js";
import {
  ACCOUNT_PROVIDERS,
  activeProviderAccount,
  addProviderAccount,
  projectRootOf,
  readProviderAccounts,
  removeProviderAccount,
  setProjectAccount,
  updateProviderAccount,
} from "../src/core/llm/provider-accounts.js";
import {
  ACCOUNT_ENV,
  providerAccountEnv,
  providerAccountHome,
} from "../src/core/llm/providers/account-env.js";
import { codexRunEnv } from "../src/core/llm/providers/codex/home.js";
import { configDir, dataDir } from "../src/core/platform/index.js";
import { realPath } from "../src/core/projects/paths.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "LOCALAPPDATA", "CODEX_HOME"] as const;
let root = "";
let saved: Record<string, string | undefined> = {};
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baked-accounts-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Every config and credential home of the test lives in its own profile.
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.LOCALAPPDATA = join(root, "local");
  process.env.CODEX_HOME = join(root, "user-codex");
  mkdirSync(join(root, "home"), { recursive: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await removeTempDir(root);
});

/** A Git checkout and a linked worktree of it, laid out as `git worktree add` leaves them. */
function repoWithWorktree(): { project: string; worktree: string } {
  const project = join(root, "project");
  const gitDir = join(project, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  const worktree = join(root, "worktrees", "wt");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  return { project: realPath(project), worktree: realPath(worktree) };
}

describe("provider accounts (#2303)", () => {
  test("every account provider has its credential home mapping", () => {
    expect(Object.keys(ACCOUNT_ENV).sort()).toEqual([...ACCOUNT_PROVIDERS].sort());
  });

  test("without accounts nothing changes: no account is active and the run env is the CLI's own", () => {
    const { project } = repoWithWorktree();
    expect(activeProviderAccount("codex", project)).toBeNull();
    expect(activeProviderAccount("claude-code", project)).toBeNull();
    expect(codexRunEnv(process.env, project).CODEX_HOME).not.toContain("codex-accounts");
    expect(providerAccountEnv("claude-code", null).CLAUDE_CONFIG_DIR).toBe(
      process.env.CLAUDE_CONFIG_DIR,
    );
  });

  test("a project uses an account only once chosen, and only while allowed", () => {
    const { project } = repoWithWorktree();
    addProviderAccount("codex", { id: "personal", label: "Personal" });
    addProviderAccount("codex", { id: "work", label: "Employer", allowedProjects: [project] });
    // Allowed is not chosen: no silent pick.
    expect(activeProviderAccount("codex", project)).toBeNull();
    expect(() => setProjectAccount("codex", project, "personal")).toThrow(/not allowed/);
    setProjectAccount("codex", project, "work");
    expect(activeProviderAccount("codex", project)?.label).toBe("Employer");
    // Taking the project off the account voids the choice instead of falling back elsewhere.
    updateProviderAccount("codex", "work", { allowedProjects: [] });
    expect(activeProviderAccount("codex", project)).toBeNull();
    expect(readProviderAccounts("codex").projectAccounts).toEqual({});
    // Choosing from inside the project allows it there.
    setProjectAccount("codex", project, "personal", { allow: true });
    expect(readProviderAccounts("codex").accounts.find((a) => a.id === "personal")?.allowedProjects).toEqual([project]);
    removeProviderAccount("codex", "personal");
    expect(activeProviderAccount("codex", project)).toBeNull();
  });

  test("bad IDs, duplicate IDs and relative folders are refused", () => {
    expect(() => addProviderAccount("codex", { id: "Work Seat", label: "W" })).toThrow(/lowercase/);
    addProviderAccount("codex", { id: "work", label: "W" });
    expect(() => addProviderAccount("codex", { id: "work", label: "W" })).toThrow(/already/);
    expect(() => updateProviderAccount("codex", "work", { allowedProjects: ["rel/dir"] })).toThrow(/absolute/);
    expect(() => updateProviderAccount("codex", "nope", { label: "x" })).toThrow(/no account/);
  });

  test("account changes keep the rest of config.json", () => {
    const file = join(configDir(), "config.json");
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(file, JSON.stringify({ defaultModel: "codex/gpt", providers: { codex: { other: 1 } } }));
    addProviderAccount("codex", { id: "work", label: "W" });
    removeProviderAccount("codex", "work");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      defaultModel: "codex/gpt",
      providers: { codex: { other: 1 } },
    });
  });

  test("a worktree uses its project's account", () => {
    const { project, worktree } = repoWithWorktree();
    expect(projectRootOf(join(worktree, "src"))).toBe(project);
    addProviderAccount("claude-code", { id: "client", label: "Client" });
    setProjectAccount("claude-code", worktree, "client", { allow: true });
    expect(activeProviderAccount("claude-code", worktree)?.id).toBe("client");
    expect(readProviderAccounts("claude-code").projectAccounts).toEqual({ [project]: "client" });
  });

  test("each account gets its own credential home under the data folder", () => {
    const codex = providerAccountEnv("codex", { id: "work" });
    expect(codex.CODEX_HOME).toBe(join(dataDir(), "codex-accounts", "work"));
    // File storage, so the keyring does not hold one sign-in for every home.
    expect(readFileSync(join(codex.CODEX_HOME ?? "", "config.toml"), "utf8")).toContain(
      'cli_auth_credentials_store = "file"',
    );
    const claude = providerAccountEnv("claude-code", { id: "work" });
    expect(claude.CLAUDE_CONFIG_DIR).toBe(providerAccountHome("claude-code", "work"));
    expect(existsSync(claude.CLAUDE_CONFIG_DIR ?? "")).toBe(true);
  });

  test("model turns of a project on an account run in that account's Codex home", () => {
    const { project, worktree } = repoWithWorktree();
    addProviderAccount("codex", { id: "work", label: "W" });
    setProjectAccount("codex", project, "work", { allow: true });
    expect(codexRunEnv(process.env, worktree).CODEX_HOME).toBe(providerAccountHome("codex", "work"));
  });
});

/** A CLI login backend that records the environment each call got. */
function recordingBackend() {
  const homes: (string | undefined)[] = [];
  let finish: () => void = () => {};
  const backend: CliLoginBackend = {
    status: (env) => {
      homes.push(env?.CODEX_HOME);
      return { installed: true, loggedIn: false, message: "Not signed in", command: "codex login" };
    },
    run: (_onLine, onUrl, env) => {
      homes.push(env?.CODEX_HOME);
      onUrl("https://example.test/login");
      return { promise: new Promise<void>((resolve) => (finish = resolve)), abort: () => finish() };
    },
    logout: (env) => {
      homes.push(env?.CODEX_HOME);
      return { ok: true, message: "Logged out." };
    },
  };
  return { backend, homes, succeed: () => finish() };
}

describe("account sign-in (#2303)", () => {
  test("an account signs in in its own home, apart from the CLI's own sign-in", async () => {
    const fake = recordingBackend();
    cleanups.push(setCliLoginBackend("codex", fake.backend));
    addProviderAccount("codex", { id: "work", label: "W" });
    const own = startCliLogin("codex");
    const work = startCliLogin("codex", "work");
    expect(own.account).toBeUndefined();
    expect(work).toMatchObject({ account: "work", state: "running" });
    expect(fake.homes).toContain(providerAccountHome("codex", "work"));
    expect(fake.homes).toContain(undefined);
    expect(() => startCliLogin("codex", "ghost")).toThrow(/no account/);
    fake.succeed();
    await cliLoginSettled("codex", "work");
  });

  test("the local API lists, adds, chooses and removes accounts and signs one in", async () => {
    const fake = recordingBackend();
    cleanups.push(setCliLoginBackend("codex", fake.backend));
    const fixture = workflowFixture();
    const server = await startApiServer({
      service: fixture.service,
      pollMs: 20,
      configDir: configDir(),
      homeDir: join(root, "home"),
      log: () => {},
    });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
    });
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    type View = ReturnType<typeof providerAccountsView>;

    const empty = (await (await call("/v1/providers/codex/accounts")).json()) as View;
    expect(empty).toMatchObject({ provider: "codex", active: null, accounts: [] });
    expect((await call("/v1/providers/openai/accounts")).status).toBe(404);

    const added = await call("/v1/providers/codex/accounts", "POST", { id: "work", label: "Employer" });
    expect(added.status).toBe(201);
    expect(((await added.json()) as View).accounts).toMatchObject([{ id: "work", allowed: false, active: false }]);
    expect((await call("/v1/providers/codex/accounts", "POST", { id: "work", label: "Again" })).status).toBe(409);
    expect((await call("/v1/providers/codex/accounts", "POST", { id: "Bad Id", label: "x" })).status).toBe(400);

    const chosen = (await (await call("/v1/providers/codex/account", "PUT", { account: "work" })).json()) as View;
    expect(chosen.active).toBe("work");
    expect(chosen.accounts[0]).toMatchObject({ allowed: true, active: true });
    expect(activeProviderAccount("codex", fixture.root)?.id).toBe("work");

    const renamed = await call("/v1/providers/codex/accounts/work", "PATCH", { label: "EPAM" });
    expect(((await renamed.json()) as View).accounts[0]?.label).toBe("EPAM");

    const login = await call("/v1/providers/codex/login?account=work", "POST");
    expect(login.status).toBe(202);
    expect(fake.homes).toContain(providerAccountHome("codex", "work"));
    expect((await call("/v1/providers/codex/login?account=ghost", "POST")).status).toBe(404);
    fake.succeed();
    await cliLoginSettled("codex", "work");

    const back = (await (await call("/v1/providers/codex/account", "PUT", { account: null })).json()) as View;
    expect(back.active).toBeNull();
    const removed = await call("/v1/providers/codex/accounts/work", "DELETE");
    expect(((await removed.json()) as View).accounts).toEqual([]);
    expect(existsSync(providerAccountHome("codex", "work"))).toBe(false);
    expect((await call("/v1/providers/codex/accounts/work", "DELETE")).status).toBe(404);
  });
});
