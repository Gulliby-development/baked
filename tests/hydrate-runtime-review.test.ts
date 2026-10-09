import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { copyRuntimeFileIfNeeded } from "../src/core/utils/hydrate-runtime.js";

test("hydration replaces a same-size stale worker and leaves identical files untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "baked-hydrate-review-"));
  try {
    const source = join(root, "new.worker.js");
    const target = join(root, "workflow.worker.js");
    writeFileSync(source, "new worker code");
    writeFileSync(target, "old worker code");
    expect(statSync(source).size).toBe(statSync(target).size);

    copyRuntimeFileIfNeeded(source, target);
    expect(readFileSync(target, "utf8")).toBe("new worker code");

    const before = statSync(target).mtimeMs;
    copyRuntimeFileIfNeeded(source, target);
    expect(readFileSync(target, "utf8")).toBe("new worker code");
    expect(statSync(target).mtimeMs).toBe(before);
  } finally {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`))
      throw new Error("Unsafe temporary directory");
    rmSync(root, { recursive: true, force: true });
  }
});
