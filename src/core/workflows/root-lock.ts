import { resolve } from "node:path";

/**
 * One project command at a time per root (#3047). R109 datefold shift T001: the model sent
 * `request_check swift-build` and `request_check swift-test` in one turn, the AI SDK ran both tool
 * calls at once in the task's worktree, and SwiftPM refused the second with "database is locked".
 * The same happens to every toolchain that keeps a build directory without waiting for its lock
 * (dotnet `obj/`, MSBuild, Maven `target/`, dune `_build`). Calls on one root run in the order
 * they arrive; calls on different roots never wait for each other.
 */
const tails = new Map<string, Promise<void>>();

const keyOf = (root: string) => {
  const path = resolve(root);
  return process.platform === "win32" ? path.toLowerCase() : path;
};

/** Runs `work` once every earlier call on the same root has finished. */
export async function withRootLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = keyOf(root);
  const previous = tails.get(key) ?? Promise.resolve();
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  tails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
