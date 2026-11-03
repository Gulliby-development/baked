import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForbidden } from "../src/core/security/forbidden.js";
import { grepTool } from "../src/core/tools/grep.js";

const TMP = join(tmpdir(), `grep-forbidden-${String(process.pid)}-${String(Date.now())}`);

beforeAll(() => {
  mkdirSync(join(TMP, "config"), { recursive: true });
  writeFileSync(join(TMP, ".env"), "API_KEY=sk-secret-123\n");
  writeFileSync(join(TMP, "config", "secrets.json"), '{"API_KEY": "sk-secret-456"}\n');
  writeFileSync(join(TMP, "config", "app.json"), '{"API_KEY_NAME": "public"}\n');
  initForbidden(TMP);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("grep tool and forbidden files", () => {
  // ripgrep prints no file name for a single-file search, so the per-line filter saw "1:API_KEY=…".
  it("refuses a forbidden file given as the search path", async () => {
    for (const path of [join(TMP, ".env"), join(TMP, "config", "secrets.json")]) {
      const result = await grepTool.execute({ pattern: "API_KEY", path });
      expect(result.output).not.toContain("sk-secret");
      expect(result.success).toBe(false);
      expect(result.output).toContain("Access denied");
    }
  });

  it("drops forbidden files from a directory search and keeps the others", async () => {
    const result = await grepTool.execute({ pattern: "API_KEY", path: join(TMP, "config") });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("sk-secret");
    expect(result.output).toContain("app.json:1:");
  });

  it("names the file on a single allowed file, so the filter can read it", async () => {
    const result = await grepTool.execute({
      pattern: "API_KEY",
      path: join(TMP, "config", "app.json"),
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain(`${join(TMP, "config", "app.json")}:1:`);
  });
});
