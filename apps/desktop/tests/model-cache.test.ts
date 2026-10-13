import { beforeEach, describe, expect, test } from "bun:test";
import type { QueryKey } from "../src/renderer/client/cache.ts";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { MODELS_READ } = await import("../src/renderer/client/api.ts");
const cache = await import("../src/renderer/client/cache.ts");
const { setup } = await import("../src/renderer/client/setup.ts");
delete scope.window;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A shown model list of `project` that counts its fetches. */
async function shownModels(project: string) {
  const key: QueryKey = [project, MODELS_READ];
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls;
  };
  const stop = cache.subscribeQuery(key, () => {});
  cache.revalidateQuery(key, fetcher);
  await flush();
  return { key, calls: () => calls, stop };
}

beforeEach(() => cache.resetQueryCache());

describe("model list cache", () => {
  test("a read invalidated by name refreshes in every project where it is shown", async () => {
    const mine = await shownModels("p1");
    const other = await shownModels("p2");
    let hiddenCalls = 0;
    const hidden: QueryKey = ["p3", MODELS_READ];
    cache.revalidateQuery(hidden, async () => ++hiddenCalls);
    const config: QueryKey = ["p1", "config"];
    let configCalls = 0;
    cache.revalidateQuery(config, async () => ++configCalls);
    await flush();

    cache.invalidateRead(MODELS_READ);
    await flush();
    expect([mine.calls(), other.calls()]).toEqual([2, 2]);
    expect(cache.readQuery<number>(cache.cacheId(mine.key)).data).toBe(2);
    expect(hiddenCalls).toBe(1);
    cache.revalidateQuery(hidden, async () => ++hiddenCalls);
    expect(hiddenCalls).toBe(2);
    cache.revalidateQuery(config, async () => ++configCalls);
    expect(configCalls).toBe(1);
    mine.stop();
    other.stop();
  });

  test("a provider key change refreshes the model list of another project", async () => {
    const other = await shownModels("elsewhere");
    await setup.setProviderKey("baked", "openai", "sk-test");
    await flush();
    expect(other.calls()).toBe(2);
    other.stop();
  });

  test("a finished sign-in refreshes the model lists once", async () => {
    const shown = await shownModels("baked");
    await setup.switchAccount("baked", "codex");
    await flush();
    const afterStart = shown.calls();
    let state = "running";
    while (state === "running") state = (await setup.login("baked", "codex")).login?.state ?? "";
    expect(state).toBe("succeeded");
    await flush();
    expect(shown.calls()).toBe(afterStart + 1);
    await setup.login("baked", "codex");
    await flush();
    expect(shown.calls()).toBe(afterStart + 1);
    shown.stop();
  });
});
