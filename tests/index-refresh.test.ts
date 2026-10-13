import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexRefresher } from "../src/core/intelligence/index-refresh.js";

const dirs: string[] = [];
const refreshers: IndexRefresher[] = [];

afterEach(async () => {
  for (const r of refreshers.splice(0)) await r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-index-refresh-"));
  dirs.push(dir);
  return dir;
}

/** A root that counts background updates; each one takes `ms`. */
function fakeRoot(ms = 0) {
  const state = { opens: 0, updates: 0 };
  const root = {
    updateRepoMapInBackground: async () => {
      state.updates++;
      if (ms > 0) await Bun.sleep(ms);
    },
  };
  return {
    state,
    root: async () => {
      state.opens++;
      return root;
    },
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

function refresher(opts: ConstructorParameters<typeof IndexRefresher>[0]): IndexRefresher {
  const r = new IndexRefresher(opts);
  refreshers.push(r);
  return r;
}

describe("IndexRefresher", () => {
  test("opens the root after the start delay, not before", async () => {
    const fake = fakeRoot();
    const r = refresher({ workspace: workspace(), root: fake.root, startDelayMs: 60, watch: false });
    r.start();
    expect(fake.state.opens).toBe(0);
    await until(() => fake.state.opens === 1);
    expect(fake.state.updates).toBe(0);
  });

  test("coalesces requests into one update and throttles the next", async () => {
    const fake = fakeRoot();
    const r = refresher({
      workspace: workspace(),
      root: fake.root,
      debounceMs: 20,
      minIntervalMs: 300,
      watch: false,
    });
    r.start();
    for (let i = 0; i < 5; i++) r.request();
    await until(() => fake.state.updates === 1);
    const first = Date.now();
    r.request();
    await Bun.sleep(100);
    expect(fake.state.updates).toBe(1);
    await until(() => fake.state.updates === 2);
    expect(Date.now() - first).toBeGreaterThanOrEqual(200);
  });

  test("a request during an update runs one more update after it", async () => {
    const fake = fakeRoot(120);
    const r = refresher({
      workspace: workspace(),
      root: fake.root,
      debounceMs: 10,
      minIntervalMs: 0,
      watch: false,
    });
    r.start();
    r.request();
    await until(() => r.busy);
    r.request();
    r.request();
    await until(() => fake.state.updates === 2);
    await Bun.sleep(200);
    expect(fake.state.updates).toBe(2);
  });

  test("a request before the root opens waits for it", async () => {
    const fake = fakeRoot();
    const r = refresher({
      workspace: workspace(),
      root: fake.root,
      startDelayMs: 80,
      debounceMs: 10,
      watch: false,
    });
    r.start();
    r.request();
    await Bun.sleep(40);
    expect(fake.state.updates).toBe(0);
    await until(() => fake.state.updates === 1);
  });

  test("a git checkout asks for an update", async () => {
    const dir = workspace();
    mkdirSync(join(dir, ".git", "logs"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const fake = fakeRoot();
    const r = refresher({ workspace: dir, root: fake.root, debounceMs: 10, minIntervalMs: 0 });
    r.start();
    await until(() => fake.state.opens === 1);
    await Bun.sleep(50);
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/other\n");
    await until(() => fake.state.updates >= 1);
  });

  test("an edited source file asks for an update; ignored folders do not", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    const fake = fakeRoot();
    const r = refresher({ workspace: dir, root: fake.root, debounceMs: 20, minIntervalMs: 0 });
    r.start();
    await until(() => fake.state.opens === 1);
    // macOS reports recent events from before the watch started (creating src); let them pass.
    await Bun.sleep(400);
    const before = fake.state.updates;
    writeFileSync(join(dir, "node_modules", "dep.ts"), "export {};\n");
    await Bun.sleep(300);
    expect(fake.state.updates).toBe(before);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await until(() => fake.state.updates === before + 1);
  });

  test("stop ends watching and pending updates", async () => {
    const fake = fakeRoot();
    const r = refresher({ workspace: workspace(), root: fake.root, debounceMs: 50, watch: false });
    r.start();
    r.request();
    await r.stop();
    r.request();
    await Bun.sleep(120);
    expect(fake.state.updates).toBe(0);
  });
});
