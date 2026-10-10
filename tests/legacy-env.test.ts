import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "..", "src", "core", "legacy-env.ts");

function run(env: Record<string, string>): Record<string, string | undefined> {
  const script = `await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify({ a: process.env.BAKED_LEGACY_TEST_A, b: process.env.BAKED_LEGACY_TEST_B }));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "", ...env } });
  return JSON.parse(result.stdout.toString());
}

describe.skipIf(process.platform === "win32")("legacy baked_* environment variables", () => {
  test("are mapped to BAKED_* names", () => {
    expect(run({ baked_LEGACY_TEST_A: "1" })).toEqual({ a: "1", b: undefined });
  });

  test("do not override a BAKED_* value", () => {
    expect(run({ baked_LEGACY_TEST_B: "old", BAKED_LEGACY_TEST_B: "new" })).toEqual({ a: undefined, b: "new" });
  });
});
