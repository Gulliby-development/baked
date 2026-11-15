import { expect, test } from "bun:test";
import { withRootLock } from "../src/core/workflows/root-lock.js";

// #3047: one project command at a time per root; other roots never wait.
test("calls on one root run in order; another root runs at once; a failure releases the root", async () => {
  const order: string[] = [];
  const slow = (name: string, ms: number) => async () => {
    order.push(`${name}:start`);
    await Bun.sleep(ms);
    order.push(`${name}:end`);
    return name;
  };
  const failing = withRootLock("/tmp/root-a", async () => {
    order.push("fail:start");
    throw new Error("boom");
  });
  const first = withRootLock("/tmp/root-a", slow("a1", 60));
  const second = withRootLock("/tmp/root-a/", slow("a2", 10));
  const other = withRootLock("/tmp/root-b", slow("b", 10));
  await expect(failing).rejects.toThrow("boom");
  expect(await Promise.all([first, second, other])).toEqual(["a1", "a2", "b"]);
  expect(order.indexOf("a1:end")).toBeLessThan(order.indexOf("a2:start"));
  expect(order.indexOf("b:end")).toBeLessThan(order.indexOf("a1:end"));
});
