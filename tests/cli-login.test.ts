import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import {
  type CliLogin,
  type CliLoginBackend,
  cancelCliLogin,
  cliLoginSettled,
  setCliLoginBackend,
  startCliLogin,
  submitCliLoginCode,
  switchCliAccount,
} from "../src/core/llm/cli-login.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A CLI login that prints a URL and ends when the test says so. */
function fakeBackend(state: { installed?: boolean; loggedIn?: boolean; takesCode?: boolean } = {}) {
  let finish: (error?: Error) => void = () => {};
  let aborted = false;
  let loggedOut = false;
  const codes: string[] = [];
  const backend: CliLoginBackend = {
    status: () => ({
      installed: state.installed ?? true,
      loggedIn: state.loggedIn ?? false,
      message: state.loggedIn ? "Signed in with claude.ai" : "Not signed in",
      command: "fake login",
    }),
    run: (onLine, onUrl) => {
      onLine("Opening browser to sign in...");
      onUrl("https://example.test/oauth?state=1");
      onLine("If the browser did not open, visit: https://example.test/oauth?state=1");
      const promise = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      });
      return {
        promise,
        abort: () => {
          aborted = true;
          finish(new Error("killed"));
        },
        ...(state.takesCode ? { submitCode: (code: string) => void codes.push(code) } : {}),
      };
    },
    logout: () => {
      loggedOut = true;
      return { ok: true, message: "Logged out." };
    },
  };
  return {
    backend,
    succeed: () => finish(),
    fail: (message: string) => finish(new Error(message)),
    aborted: () => aborted,
    loggedOut: () => loggedOut,
    codes,
  };
}

function useFake(provider: "claude-code" | "codex", state?: Parameters<typeof fakeBackend>[0]) {
  const fake = fakeBackend(state);
  cleanups.push(setCliLoginBackend(provider, fake.backend));
  return fake;
}

describe("CLI provider sign-in", () => {
  test("a login reports progress and the sign-in URL, then succeeds", async () => {
    const fake = useFake("claude-code");
    const started = startCliLogin("claude-code");
    expect(started).toMatchObject({ provider: "claude-code", state: "running", url: "https://example.test/oauth?state=1" });
    expect(started.lines).toHaveLength(2);
    expect(startCliLogin("claude-code").startedAt).toBe(started.startedAt);
    fake.succeed();
    const done = await cliLoginSettled("claude-code");
    expect(done?.state).toBe("succeeded");
    expect(done?.endedAt).toBeString();
  });

  test("a failed login keeps the CLI's reason; a cancelled one says so", async () => {
    const fake = useFake("codex");
    startCliLogin("codex");
    fake.fail("Codex authentication failed.");
    expect(await cliLoginSettled("codex")).toMatchObject({ state: "failed", error: "Codex authentication failed." });

    const next = fakeBackend();
    cleanups.push(setCliLoginBackend("codex", next.backend));
    startCliLogin("codex");
    expect((await cancelCliLogin("codex"))?.state).toBe("cancelled");
    expect(next.aborted()).toBe(true);
  });

  test("a CLI that is missing or already signed in runs no login", async () => {
    const missing = useFake("claude-code", { installed: false });
    expect(startCliLogin("claude-code")).toMatchObject({ state: "failed", error: "Not signed in" });
    expect(missing.aborted()).toBe(false);

    cleanups.push(setCliLoginBackend("claude-code", fakeBackend({ loggedIn: true }).backend));
    const login = startCliLogin("claude-code");
    expect(login.state).toBe("succeeded");
    expect(login.url).toBeUndefined();
  });
});

describe("CLI sign-in code (#1182)", () => {
  test("a login whose CLI takes a code passes the pasted code to it", async () => {
    const fake = useFake("claude-code", { takesCode: true });
    expect(startCliLogin("claude-code").acceptsCode).toBe(true);
    const sent = submitCliLoginCode("claude-code", "  abc123#state  ");
    expect(fake.codes).toEqual(["abc123#state"]);
    expect(sent.lines.at(-1)).toBe("Code sent; waiting for the CLI to finish signing in.");
    fake.succeed();
    expect((await cliLoginSettled("claude-code"))?.state).toBe("succeeded");
  });

  test("a code is refused without a running login, for a CLI that takes none, and with spaces", async () => {
    useFake("claude-code", { takesCode: true });
    expect(() => submitCliLoginCode("claude-code", "abc")).toThrow(/No sign-in is running/);
    startCliLogin("claude-code");
    expect(() => submitCliLoginCode("claude-code", "two words")).toThrow(/without spaces/);
    const codex = useFake("codex");
    expect(startCliLogin("codex").acceptsCode).toBeUndefined();
    expect(() => submitCliLoginCode("codex", "abc")).toThrow(/takes no code/);
    expect(codex.codes).toEqual([]);
  });
});

describe("local API: CLI provider sign-in", () => {
  async function serve() {
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
    return (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
  }

  test("POST /v1/providers/ID/login/code sends the code to the running sign-in", async () => {
    const fake = useFake("claude-code", { takesCode: true });
    useFake("codex");
    const call = await serve();
    expect((await call("/v1/providers/claude-code/login/code", "POST", { code: "abc" })).status).toBe(409);
    const started = (await (await call("/v1/providers/claude-code/login", "POST")).json()) as { login: CliLogin };
    expect(started.login.acceptsCode).toBe(true);
    const sent = await call("/v1/providers/claude-code/login/code", "POST", { code: "abc#def" });
    expect(sent.status).toBe(202);
    expect(fake.codes).toEqual(["abc#def"]);
    expect((await call("/v1/providers/claude-code/login/code", "POST", {})).status).toBe(400);
    expect((await call("/v1/providers/claude-code/login/code")).status).toBe(405);
    await call("/v1/providers/codex/login", "POST");
    expect((await call("/v1/providers/codex/login/code", "POST", { code: "abc" })).status).toBe(409);
    expect((await call("/v1/providers/openai/login/code", "POST", { code: "abc" })).status).toBe(404);
  });

  test("sign-in starts, is polled, is listed with the provider and signs out", async () => {
    const fake = useFake("claude-code");
    useFake("codex", { loggedIn: true });
    const call = await serve();

    const started = await call("/v1/providers/claude-code/login", "POST");
    expect(started.status).toBe(202);
    expect(((await started.json()) as { login: CliLogin }).login).toMatchObject({ state: "running", url: "https://example.test/oauth?state=1" });

    type Listed = { id: string; signIn?: { installed: boolean; loggedIn: boolean; command: string; login: CliLogin | null } };
    const { providers } = (await (await call("/v1/providers")).json()) as { providers: Listed[] };
    expect(providers.find((p) => p.id === "claude-code")?.signIn).toMatchObject({ installed: true, loggedIn: false, login: { state: "running" } });
    expect(providers.find((p) => p.id === "codex")?.signIn).toMatchObject({ loggedIn: true, login: null });
    expect(providers.find((p) => p.id === "openai")?.signIn).toBeUndefined();

    fake.succeed();
    await cliLoginSettled("claude-code");
    const polled = (await (await call("/v1/providers/claude-code/login")).json()) as { login: CliLogin };
    expect(polled.login.state).toBe("succeeded");

    const out = await call("/v1/providers/claude-code/logout", "POST");
    expect(await out.json()).toEqual({ ok: true, message: "Logged out." });
    expect(fake.loggedOut()).toBe(true);
  });

  test("a running sign-in can be cancelled; other providers and methods are refused", async () => {
    const fake = useFake("codex");
    const call = await serve();
    await call("/v1/providers/codex/login", "POST");
    const cancelled = (await (await call("/v1/providers/codex/login", "DELETE")).json()) as { login: CliLogin };
    expect(cancelled.login.state).toBe("cancelled");
    expect(fake.aborted()).toBe(true);

    expect((await call("/v1/providers/openai/login", "POST")).status).toBe(404);
    expect((await call("/v1/providers/codex/logout")).status).toBe(405);
    expect((await call("/v1/providers/codex/login", "PUT")).status).toBe(405);
  });
});

describe("CLI account switch", () => {
  /** A signed-in CLI whose logout signs it out, or fails and keeps it signed in. */
  function signedIn(logoutWorks: boolean) {
    const state = { loggedIn: true, runs: 0 };
    let finish: () => void = () => {};
    const backend: CliLoginBackend = {
      status: () => ({
        installed: true,
        loggedIn: state.loggedIn,
        message: state.loggedIn ? "Logged in using ChatGPT" : "Not logged in",
        command: "codex login",
      }),
      run: (_onLine, onUrl) => {
        state.runs++;
        onUrl("https://example.test/codex");
        return { promise: new Promise<void>((resolve) => (finish = resolve)), abort: () => finish() };
      },
      logout: () => {
        if (!logoutWorks) return { ok: false, message: "logout failed" };
        state.loggedIn = false;
        return { ok: true, message: "Successfully logged out" };
      },
    };
    cleanups.push(setCliLoginBackend("codex", backend));
    return { state, succeed: () => finish() };
  }

  test("signs the account out and starts a new sign-in", async () => {
    const fake = signedIn(true);
    const result = await switchCliAccount("codex");
    expect(result).toMatchObject({
      ok: true,
      message: "Successfully logged out",
      login: { state: "running", url: "https://example.test/codex" },
    });
    expect(fake.state.runs).toBe(1);
    // A second switch while the sign-in runs returns it instead of signing out again.
    expect((await switchCliAccount("codex")).login?.startedAt).toBe(result.login?.startedAt);
    expect(fake.state.runs).toBe(1);
    fake.succeed();
    expect((await cliLoginSettled("codex"))?.state).toBe("succeeded");
  });

  test("a failed logout starts no sign-in", async () => {
    const fake = signedIn(false);
    expect(await switchCliAccount("codex")).toEqual({ ok: false, message: "logout failed", login: null });
    expect(fake.state.runs).toBe(0);
  });

  test("POST /v1/providers/ID/switch over the local API", async () => {
    signedIn(true);
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
    const call = (path: string, method = "GET") =>
      fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${server.token}` } });
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("provider-switch");
    const switched = await call("/v1/providers/codex/switch", "POST");
    expect(switched.status).toBe(202);
    const body = (await switched.json()) as { ok: boolean; message: string; login: CliLogin };
    expect(Object.keys(body).sort()).toEqual(["login", "message", "ok"]);
    expect(body.ok).toBe(true);
    expect(body.login.state).toBe("running");
    expect((await call("/v1/providers/codex/switch")).status).toBe(405);
    expect((await call("/v1/providers/openai/switch", "POST")).status).toBe(404);
    await cancelCliLogin("codex");
  });
});
