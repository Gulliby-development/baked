import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { NewRunForm } from "../src/components/workflow/NewRunForm.js";
import { startApiServer } from "../src/core/api/server.js";
import {
  activeProviderAccount,
  addProviderAccount,
  projectRootOf,
  runWithAccounts,
  setProjectAccount,
} from "../src/core/llm/provider-accounts.js";
import { getDefaultCodexSessions } from "../src/core/llm/providers/codex/native.js";
import type { ProviderLimits } from "../src/core/llm/usage-limits.js";
import { configDir } from "../src/core/platform/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import type { StartRunInput, WorkflowInfo } from "../src/core/workflows/view.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

/**
 * A run on a chosen account end to end (#2303): every surface that starts a run hands the
 * account to the core, the run's model calls use it, a restart keeps it, and a choice the
 * project may not use never starts a run.
 */

const ENV_KEYS = ["HOME", "USERPROFILE", "LOCALAPPDATA", "CODEX_HOME"] as const;
let root = "";
let saved: Record<string, string | undefined> = {};
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baked-run-accounts-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
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

/** Records which Codex account each model call of a run ran on. */
class AccountExecutor extends FixtureExecutor {
  readonly seen: (string | null)[] = [];
  constructor(private readonly folder: string) {
    super(folder);
  }
  override async execute(request: ExecutionRequest) {
    this.seen.push(activeProviderAccount("codex", this.folder)?.id ?? null);
    return super.execute(request);
  }
}

function accountFixture() {
  const fixture = workflowFixture({ executor: (dir) => new AccountExecutor(dir) });
  cleanups.push(fixture.dispose);
  addProviderAccount("codex", { id: "work", label: "Work", allowedProjects: [fixture.root] });
  addProviderAccount("codex", { id: "home", label: "Home", allowedProjects: [fixture.root] });
  addProviderAccount("codex", { id: "client", label: "Client" });
  return fixture;
}

const signal = () => new AbortController().signal;

describe("baked workflow run --account (#2303)", () => {
  test("the flag reaches the run, which keeps it in its state", async () => {
    const fixture = accountFixture();
    const args = ["run", "--feature", "fixture", "--prompt", "Create ready value", "--account", "codex=work"];
    const run = (await executeWorkflowCommand(fixture.service, parseWorkflowArgs(args), signal())) as {
      runId: string;
    };
    expect(fixture.service.store.state(run.runId).accounts).toEqual({ codex: "work" });
    expect(fixture.executor.seen.length).toBeGreaterThan(0);
    expect(new Set(fixture.executor.seen)).toEqual(new Set(["work"]));
  });

  test("quick takes the flag too", () => {
    expect(parseWorkflowArgs(["quick", "Fix the typo", "--account", "claude-code=client"]).flags.account).toBe(
      "claude-code=client",
    );
  });

  test("a malformed, unknown or not allowed account never starts a run", async () => {
    const fixture = accountFixture();
    const start = (account: string) =>
      executeWorkflowCommand(
        fixture.service,
        parseWorkflowArgs(["run", "--feature", "fixture", "--prompt", "Create ready value", "--account", account]),
        signal(),
      ).catch((error: unknown) => error);
    for (const [account, message] of [
      ["copilot=work", /PROVIDER=ID/],
      ["codex=ghost", /has no account ghost/],
      ["codex=client", /not allowed/],
    ] as const) {
      const error = await start(account);
      expect(error, account).toBeInstanceOf(WorkflowFault);
      expect((error as WorkflowFault).code, account).toBe("INVALID_REFERENCE");
      expect((error as Error).message, account).toMatch(message);
    }
    expect(fixture.service.store.list(10).items).toEqual([]);
    expect(fixture.executor.seen).toEqual([]);
  });

  test("a resume after a restart stays on the run's account, whatever the project uses now", async () => {
    const fixture = accountFixture();
    const run = await fixture.service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      policy: fixture.policy,
      accounts: { codex: "work" },
    });
    await fixture.service.drive(run.runId, signal());
    const before = fixture.executor.seen.length;
    expect(before).toBeGreaterThan(0);
    // The project moves to another account, and BAKED restarts.
    setProjectAccount("codex", fixture.root, "home");
    await fixture.service.shutdown();
    fixture.service.close();
    const executor = new AccountExecutor(fixture.root);
    const restarted = new NativeWorkflowService(fixture.root, fixture.config, executor);
    cleanups.push(() => restarted.close());
    const snapshot = await restarted.get(run.runId);
    const request = restarted.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (request) {
      await restarted.decide(
        run.runId,
        { commandId: newId(), expectedRevision: snapshot.revision },
        { kind: "approve", requestId: request.id, digest: request.digest },
      );
    } else {
      await restarted.resume(run.runId, { commandId: newId(), expectedRevision: snapshot.revision });
    }
    await restarted.drive(run.runId, signal());
    expect(executor.seen.length).toBeGreaterThan(0);
    expect(new Set(executor.seen)).toEqual(new Set(["work"]));
    // Outside the run the project's new choice applies.
    expect(activeProviderAccount("codex", fixture.root)?.id).toBe("home");
  });

  test("runs on different accounts get different Codex app-servers", () => {
    const own = getDefaultCodexSessions();
    expect(getDefaultCodexSessions()).toBe(own);
    addProviderAccount("codex", { id: "work", label: "Work", allowedProjects: [projectRootOf(process.cwd())] });
    const work = runWithAccounts({ codex: "work" }, () => getDefaultCodexSessions());
    expect(work).not.toBe(own);
    expect(runWithAccounts({ codex: "work" }, () => getDefaultCodexSessions())).toBe(work);
  });
});

describe("POST /v1/workflow/runs with accounts (#2303)", () => {
  test("the API starts a run on the account, refuses one the project may not use, and lists each account's limits", async () => {
    const fixture = accountFixture();
    const server = await startApiServer({
      service: fixture.service,
      pollMs: 20,
      configDir: configDir(),
      homeDir: join(root, "home"),
      log: () => {},
    });
    cleanups.push(() => server.stop());
    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const body = { feature: "fixture", prompt: "Create ready value" };

    const refused = await call("/v1/workflow/runs", "POST", { ...body, commandId: newId(), accounts: { codex: "client" } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("INVALID_REFERENCE");
    expect((await call("/v1/workflow/runs", "POST", { ...body, commandId: newId(), accounts: { codex: "Not An Id" } })).status).toBe(400);
    expect((await call("/v1/workflow/runs", "POST", { ...body, commandId: newId(), accounts: { copilot: "x" } })).status).toBe(400);

    const started = await call("/v1/workflow/runs", "POST", { ...body, commandId: newId(), accounts: { codex: "work" } });
    expect(started.status).toBeLessThan(300);
    const { runId } = (await started.json()) as { runId: string };
    expect(fixture.service.store.state(runId).accounts).toEqual({ codex: "work" });

    const { limits } = (await (await call("/v1/providers/limits")).json()) as { limits: ProviderLimits[] };
    const codex = limits.filter((l) => l.provider === "codex");
    expect(codex.map((l) => l.name)).toEqual(["Codex", "Codex · Work", "Codex · Home", "Codex · Client"]);
    expect(codex.slice(1).map((l) => l.account?.id)).toEqual(["work", "home", "client"]);
    // None of them signed in, and listing their limits made no credential home.
    for (const account of codex.slice(1)) expect(account.state).toBe("not-signed-in");
  });
});

describe("the TUI new-run form picks an account (#2303)", () => {
  const info: WorkflowInfo = {
    estimate: null,
    enabled: true,
    defaultWorkflow: "sdd",
    workflows: ["sdd"],
    definitions: { sdd: { stages: ["research", "plan"], writes: true, problems: [], execution: null, worktreeRefusal: null } },
    policy: { ...defaultWorkflowPolicy, checks: [] },
    presets: {
      quick: { maxTotalTokens: 200000, maxAgentCalls: 40, maxActiveMs: 1800000 },
      standard: { maxTotalTokens: 400000, maxAgentCalls: 80, maxActiveMs: 3600000 },
      extended: { maxTotalTokens: 800000, maxAgentCalls: 160, maxActiveMs: 7200000 },
      checkpoints: { maxTotalTokens: 1000000000, maxAgentCalls: 160, maxActiveMs: 7200000, checkpointTokens: 200000 },
    },
  };
  type View = Awaited<ReturnType<typeof testRender>>;
  const press = async (view: View, key: string, options?: { ctrl?: boolean }) => {
    await act(async () => {
      if (key === "right" || key === "left") view.mockInput.pressArrow(key);
      else if (key === "tab") view.mockInput.pressTab();
      else view.mockInput.pressKey(key, options);
      await view.flush();
      await view.renderOnce();
    });
  };
  const text = async (view: View) => {
    for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
    return view.captureCharFrame();
  };

  test("only providers with an account the project may use get a field, and the pick reaches the start", async () => {
    const project = projectRootOf(process.cwd());
    addProviderAccount("codex", { id: "work", label: "Work seat", allowedProjects: [project] });
    addProviderAccount("codex", { id: "other", label: "Other seat" });
    addProviderAccount("claude-code", { id: "client", label: "Client" });
    const started: StartRunInput[] = [];
    let view!: View;
    await act(async () => {
      view = await testRender(
        <NewRunForm active info={info} model="codex/gpt-test" initialPrompt="Add a search box" width={110}
          onStart={async (input) => { started.push(input); }} onCancel={() => {}} />,
        { width: 120, height: 60 },
      );
    });
    try {
      let frame = await text(view);
      expect(frame).toContain("‹ project's ›  the CLI's own sign-in");
      // Claude Code has no account this project may use, and Codex's other seat is not offered.
      expect(frame).not.toContain("Claude    ");
      expect(frame).not.toContain("Other seat");
      // feature → workflow, budget, cost, mode, questions, tests, routes, then Codex.
      for (let i = 0; i < 8; i++) await press(view, "tab");
      await press(view, "right");
      frame = await text(view);
      expect(frame).toContain("‹ Work seat ›  this run only");
      await press(view, "s", { ctrl: true });
      expect(started.at(-1)?.accounts).toEqual({ codex: "work" });
      // Back to the project's account: nothing is sent.
      await press(view, "left");
      await press(view, "s", { ctrl: true });
      expect(started.at(-1)?.accounts).toBeUndefined();
    } finally {
      act(() => view.renderer.destroy());
    }
  });
});
