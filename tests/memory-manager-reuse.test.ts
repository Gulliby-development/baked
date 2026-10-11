import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BAKED_NO_REPOMAP = "1";

import { ContextManager } from "../src/core/context/manager.js";
import { resolveMemoryManager } from "../src/core/tools/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  // dispose() closes the memory database asynchronously; Windows cannot delete it while open.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("tool builds reuse the session memory manager instead of opening another database connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-reuse-"));
  const context = new ContextManager(dir);
  cleanups.push(() => removeTempDir(dir));
  cleanups.push(() => context.dispose());
  expect(resolveMemoryManager({ contextManager: context }, dir)).toBe(context.getMemoryManager());
  const explicit = context.getMemoryManager();
  expect(resolveMemoryManager({ memoryManager: explicit }, dir)).toBe(explicit);
});
