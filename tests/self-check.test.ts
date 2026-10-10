import { describe, expect, test } from "bun:test";
import { runSelfCheck } from "../src/headless/self-check.js";

describe("self-check", () => {
  test("passes against the source tree", async () => {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runSelfCheck();
    } finally {
      process.stdout.write = write;
    }
    expect(lines.join("")).not.toContain("FAIL");
    expect(code).toBe(0);
  }, 120_000);
});
