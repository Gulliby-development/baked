import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckRunner, modelCheckOutput } from "../src/core/verification/check-runner.js";
import { plainJsonText, plainOutputEnv } from "../src/core/verification/plain-output.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";

// Scenario of bench round 86 (#2631): #2625 gave every check `NO_COLOR=1` and `FORCE_COLOR=0`.
// ruff reads any `FORCE_COLOR` value as "force colour" and lets it win over `NO_COLOR`, so 79 R86
// ruff outputs (expenses-py, tomlcmp-update, crossmill-update) were stored coloured and their
// escapes reached the implementer's prompt. Here two stand-in tools print colour by the rules of
// ruff (any FORCE_COLOR) and of Node's picocolors (FORCE_COLOR or CI, unless NO_COLOR), run as
// checks under a parent environment like CI's (`FORCE_COLOR=1`, `CI=true`).

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-colour-tools-"));
afterAll(() => rmSync(bin, { recursive: true, force: true }));
const ESC = "\\033[31m";
const tool = (name: string, colours: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nif ${colours}; then printf '${ESC}F401\\033[0m a.py:1:8 unused\\n'; else printf 'F401 a.py:1:8 unused\\n'; fi\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
};
// ruff: any FORCE_COLOR value forces colour, whatever NO_COLOR says.
const ruff = IS_WIN ? "" : tool("ruff", '[ -n "${FORCE_COLOR+x}" ]');
// picocolors: NO_COLOR wins; otherwise FORCE_COLOR or CI turns colour on.
const pico = IS_WIN ? "" : tool("pico", '[ -z "${NO_COLOR+x}" ] && { [ -n "${FORCE_COLOR+x}" ] || [ -n "${CI+x}" ]; }');

const check = (id: string, executable: string): Check => ({
  id,
  executable,
  args: ["check", "."],
  cwd: ".",
  timeoutMs: 10_000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
});

describe.skipIf(IS_WIN)("scenario: R86, ruff coloured under FORCE_COLOR=0 (#2631)", () => {
  test("ruff and a Node colour library print plain output as checks, under a CI parent environment", async () => {
    const saved = { FORCE_COLOR: process.env.FORCE_COLOR, CI: process.env.CI, NO_COLOR: process.env.NO_COLOR };
    process.env.FORCE_COLOR = "1";
    process.env.CI = "true";
    delete process.env.NO_COLOR;
    try {
      const runner = new CheckRunner(undefined as unknown as WorkflowStore, new ProcessScope());
      const signal = new AbortController().signal;
      for (const [id, path] of [["lint", ruff], ["eslint", pico]] as const) {
        const result = await runner.measure(check(id, path), signal, bin, null);
        expect([id, result.status, result.output.includes("\u001b")]).toEqual([id, "failed", false]);
        expect(result.output).toContain("F401 a.py:1:8 unused");
      }
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  test("the edit-tool environment drops FORCE_COLOR too, and keeps NO_COLOR", () => {
    expect(plainOutputEnv({ FORCE_COLOR: "1", PATH: "/bin" })).toEqual({ PATH: "/bin", NO_COLOR: "1", CARGO_TERM_COLOR: "never" });
  });
});

describe("the prompt builders strip escapes a tool printed anyway (#2631)", () => {
  const coloured = "\u001b[1m\u001b[91mF401\u001b[0m [*] `os` imported but unused\n \u001b[1m\u001b[94m-->\u001b[0m a.py:1:8\n";
  test("a request_check result carries the plain output", () => {
    expect(modelCheckOutput(coloured).output).toBe("F401 [*] `os` imported but unused\n --> a.py:1:8\n");
  });

  test("a stored check record sent as evidence holds no escape", () => {
    const record = JSON.stringify({ definitionHash: "h", output: coloured, link: "\u001b]8;;file:///w/a.py\u0007a.py\u001b]8;;\u0007" });
    const plain = plainJsonText(record);
    expect(plain).not.toContain("\\u001b");
    expect(JSON.parse(plain)).toEqual({ definitionHash: "h", output: "F401 [*] `os` imported but unused\n --> a.py:1:8\n", link: "a.py" });
  });
});
