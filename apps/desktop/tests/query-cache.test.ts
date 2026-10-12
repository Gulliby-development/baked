import { beforeEach, describe, expect, test } from "bun:test";
import {
  cacheId,
  fetchQuery,
  invalidateProject,
  type QueryKey,
  readQuery,
  resetQueryCache,
  revalidateQuery,
  revalidateShown,
  setQueryData,
  subscribeQuery,
} from "../src/renderer/client/cache.ts";

let clock = 0;
const read = (key: QueryKey) => readQuery<string>(cacheId(key));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetcher whose answers the test releases one at a time. */
function deferred() {
  const pending: ((value: string) => void)[] = [];
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return new Promise<string>((resolve) => pending.push(resolve));
  };
  return {
    fetcher,
    calls: () => calls,
    resolve: async (value: string) => {
      pending.shift()?.(value);
      await flush();
    },
  };
}

beforeEach(() => {
  clock = 1_000;
  resetQueryCache(() => clock);
});

describe("query cache", () => {
  test("keeps the last answer and refreshes it in the background once stale", async () => {
    const key: QueryKey = ["p1", "doctor"];
    const source = deferred();
    revalidateQuery(key, source.fetcher, 30_000);
    expect(read(key)).toMatchObject({ hasData: false, fetching: true });
    await source.resolve("first");
    expect(read(key)).toMatchObject({ data: "first", fetching: false, updatedAt: 1_000 });

    clock += 10_000;
    revalidateQuery(key, source.fetcher, 30_000);
    expect(source.calls()).toBe(1);

    clock += 25_000;
    revalidateQuery(key, source.fetcher, 30_000);
    expect(read(key)).toMatchObject({ data: "first", fetching: true });
    await source.resolve("second");
    expect(read(key)).toMatchObject({ data: "second", updatedAt: 36_000 });
  });

  test("shares one fetch between readers and keeps data when a refresh fails", async () => {
    const key: QueryKey = ["p1", "routing", null];
    let calls = 0;
    let fail = false;
    const fetcher = async () => {
      calls += 1;
      if (fail) throw new Error("backend stopped");
      return "view";
    };
    await Promise.all([fetchQuery(key, fetcher), fetchQuery(key, fetcher)]);
    expect(calls).toBe(1);
    fail = true;
    await fetchQuery(key, fetcher);
    expect(read(key).data).toBe("view");
    expect((read(key).error as Error).message).toBe("backend stopped");
  });

  test("a write marks only its project stale", async () => {
    const mine: QueryKey = ["p1", "config"];
    const other: QueryKey = ["p2", "config"];
    const source = deferred();
    revalidateQuery(mine, source.fetcher);
    await source.resolve("a");
    revalidateQuery(other, source.fetcher);
    await source.resolve("b");

    invalidateProject("p1");
    revalidateQuery(other, source.fetcher);
    expect(source.calls()).toBe(2);
    revalidateQuery(mine, source.fetcher);
    expect(source.calls()).toBe(3);
    expect(read(mine)).toMatchObject({ data: "a", fetching: true });
  });

  test("an answer an invalidation overtook is fetched again while shown", async () => {
    const key: QueryKey = ["p1", "project"];
    const source = deferred();
    const stop = subscribeQuery(key, () => {});
    revalidateQuery(key, source.fetcher);
    invalidateProject("p1");
    await source.resolve("before the write");
    expect(source.calls()).toBe(2);
    await source.resolve("after the write");
    expect(read(key).data).toBe("after the write");
    stop();
  });

  test("set data is shared by every reader of the key", () => {
    const key: QueryKey = ["p1", "project"];
    const seen: (string | undefined)[] = [];
    const stop = subscribeQuery(key, () => seen.push(read(key).data));
    setQueryData(key, "saved view");
    expect(seen).toEqual(["saved view"]);
    expect(read(key)).toMatchObject({ hasData: true, updatedAt: 1_000 });
    stop();
  });

  test("window focus refreshes only stale entries a screen shows", async () => {
    const shown: QueryKey = ["p1", "doctor"];
    const hidden: QueryKey = ["p1", "gates"];
    const source = deferred();
    const stop = subscribeQuery(shown, () => {});
    revalidateQuery(shown, source.fetcher);
    await source.resolve("doctor");
    revalidateQuery(hidden, source.fetcher);
    await source.resolve("gates");

    revalidateShown();
    expect(source.calls()).toBe(2);
    clock += 31_000;
    revalidateShown();
    expect(source.calls()).toBe(3);
    expect(read(shown).fetching).toBe(true);
    expect(read(hidden).fetching).toBe(false);
    stop();
  });
});
