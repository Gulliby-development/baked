import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { EffectJournal } from "../src/core/workflows/effects.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { WorkspaceLeases } from "../src/core/workflows/leases.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A journal over a fake store that records the status of the one effect; `failAt` is the lease check that throws. */
function journal(failAt: number) {
  const workspace = mkdtempSync(join(tmpdir(), "baked-effects-"));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const statuses: string[] = [];
  let checks = 0;
  const store = {
    workspace,
    transaction: <T>(fn: () => T) => fn(),
    prepareEffect: () => "effect-1",
    effectStatus: (_run: string, _id: string, status: string) => statuses.push(status),
  } as unknown as WorkflowStore;
  const leases = {
    assert: () => {
      if (++checks === failAt) throw new Error("lease lost");
    },
  } as unknown as WorkspaceLeases;
  return { workspace, statuses, effects: new EffectJournal(store, leases) };
}

describe("a publish that throws after the effect was prepared", () => {
  test("a file that still has its old content is recorded as failed, not unknown", () => {
    const { workspace, statuses, effects } = journal(2);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "a.txt"), "old");
    expect(() => effects.publish("run", "attempt", "a.txt", "new", hashBytes(Buffer.from("old")), "file_patch")).toThrow("lease lost");
    expect(statuses).toEqual(["failed"]);
  });
  test("a file that already has the new content stays unknown for reconcile", () => {
    const { workspace, statuses, effects } = journal(99);
    writeFileSync(join(workspace, "a.txt"), "old");
    // The write succeeds, then recording the status fails: the file carries the new content.
    const fake = effects as unknown as { store: { effectStatus: (...args: unknown[]) => void } };
    const original = fake.store.effectStatus;
    let first = true;
    fake.store.effectStatus = (...args: unknown[]) => {
      if (first) {
        first = false;
        throw new Error("database busy");
      }
      original(...args);
    };
    expect(() => effects.publish("run", "attempt", "a.txt", "new", hashBytes(Buffer.from("old")), "file_patch")).toThrow("database busy");
    expect(statuses).toEqual(["unknown"]);
  });
  test("a file that is neither stays unknown", () => {
    const { workspace, statuses, effects } = journal(2);
    writeFileSync(join(workspace, "a.txt"), "old");
    const fake = effects as unknown as { leases: { assert: () => void } };
    const real = fake.leases.assert;
    let calls = 0;
    fake.leases.assert = () => {
      if (++calls === 2) {
        writeFileSync(join(workspace, "a.txt"), "someone else");
        throw new Error("changed");
      }
      real();
    };
    expect(() => effects.publish("run", "attempt", "a.txt", "new", hashBytes(Buffer.from("old")), "file_patch")).toThrow("changed");
    expect(statuses).toEqual(["unknown"]);
  });
});
