import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.baked_NO_REPOMAP = "1";

import { ContextManager } from "../src/core/context/manager.js";
import { resolveMemoryManager } from "../src/core/tools/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("tool builds reuse the session memory manager instead of opening another database connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-reuse-"));
  const context = new ContextManager(dir);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => context.dispose());
  expect(resolveMemoryManager({ contextManager: context }, dir)).toBe(context.getMemoryManager());
  const explicit = context.getMemoryManager();
  expect(resolveMemoryManager({ memoryManager: explicit }, dir)).toBe(explicit);
});
