import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CheckRunner, exitStatus } from "../src/core/verification/check-runner.js";
import { noTestsCollected } from "../src/core/verification/convergence.js";
import { emptyScriptNote, emptyTestScript } from "../src/core/verification/empty-test-script.js";
import { executeGate } from "../src/core/workflows/gates.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { Check } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";

// Scenario of the php-wordcount cloud smoke (2026-11-01, #2611): the test task's `tests/run.php`
// was 0 bytes and the `php-tests` check (`php tests/run.php`) passed it with exit 0 and no output,
// since a plain test script prints nothing a test counter reads. A test check that runs one test
// script holding no code now fails, with a note saying no tests ran, in every language whose
// interpreter runs a test script directly.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-empty-test-script-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const check = (id: string, executable: string, args: string[]): Check => ({
  id,
  executable,
  args,
  cwd: ".",
  timeoutMs: 30_000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
});

const has = (command: string, args: string[]): boolean =>
  spawnSync(command, args, { stdio: "ignore", timeout: 30_000 }).status === 0;

// Each language: its check, a script with only comments and inert lines, and one with a test.
const LANGUAGES: {
  name: string;
  check: Check;
  empty: string;
  real: string;
  probe: [string, string[]];
}[] = [
  {
    name: "PHP",
    check: check("php-tests", "php", ["tests/run.php"]),
    empty: "<?php\ndeclare(strict_types=1);\n// tests go here\n# later\n/* none */\n",
    real: "<?php\nif (strlen('ab') !== 2) { exit(1); }\necho \"1 test passed\\n\";\n",
    probe: ["php", ["-v"]],
  },
  {
    name: "Python",
    check: check("tests", "python3", ["tests/run.py"]),
    empty: '"""Tests."""\nfrom __future__ import annotations\n# nothing yet\n',
    real: "assert len('ab') == 2\n",
    probe: ["python3", ["--version"]],
  },
  {
    name: "JavaScript",
    check: check("tests", "node", ["tests/run.js"]),
    empty: "#!/usr/bin/env node\n'use strict';\n// nothing\n/* yet */\n",
    real: "if ('ab'.length !== 2) process.exit(1);\n",
    probe: ["node", ["--version"]],
  },
  {
    name: "shell",
    check: check("tests", "bash", ["tests/run.sh"]),
    empty: "#!/usr/bin/env bash\nset -euo pipefail\n# nothing\n",
    real: '[ "$(printf ab | wc -c)" -eq 2 ]\n',
    probe: ["bash", ["--version"]],
  },
  {
    name: "Ruby",
    check: check("tests", "ruby", ["tests/run.rb"]),
    empty: "# frozen_string_literal: true\n=begin\nlater\n=end\n",
    real: "exit 1 unless 'ab'.length == 2\n",
    probe: ["ruby", ["--version"]],
  },
  {
    name: "Perl",
    check: check("tests", "perl", ["t/run.t"]),
    empty: "use strict;\nuse warnings;\n# nothing\n",
    real: "exit 1 unless length('ab') == 2;\n",
    probe: ["perl", ["-v"]],
  },
];

const path = (c: Check): string => c.args.at(-1) ?? "";

describe("scenario: php-wordcount, a passing test script that holds no code (#2611)", () => {
  test("the host's own 0-byte tests/run.php is an empty test script", () => {
    const root = project({ "tests/run.php": "" });
    expect(emptyTestScript(check("php-tests", "php", ["tests/run.php"]), root)).toBe(
      "tests/run.php",
    );
  });

  for (const language of LANGUAGES) {
    test(`${language.name}: comments and inert lines only are empty, a test is not`, () => {
      const root = project({ [path(language.check)]: language.empty });
      expect(emptyTestScript(language.check, root)).toBe(path(language.check));
      const real = project({ [path(language.check)]: language.real });
      expect(emptyTestScript(language.check, real)).toBeNull();
      // The status the gate commands give it, with and without the check's directory.
      expect(exitStatus(language.check, 0, "", root)).toBe("failed");
      expect(exitStatus(language.check, 0, "", real)).toBe("passed");
      expect(exitStatus(language.check, 0, "")).toBe("passed");
    });

    test.skipIf(!has(...language.probe))(
      `${language.name}: the check fails on the empty script and passes on a test`,
      async () => {
        const runner = new CheckRunner(undefined as unknown as WorkflowStore, new ProcessScope());
        const signal = new AbortController().signal;
        const root = project({ [path(language.check)]: language.empty });
        expect((await runner.measure(language.check, signal, root, null)).status).toBe("failed");
        const gate = await executeGate(root, language.check, signal);
        expect([gate.exitCode, gate.status]).toEqual([0, "failed"]);
        const real = project({ [path(language.check)]: language.real });
        expect((await runner.measure(language.check, signal, real, null)).status).toBe("passed");
      },
      60_000,
    );
  }

  test("PowerShell, R and Lua scripts are read the same way", () => {
    const pwsh = check("tests", "pwsh", ["-NoProfile", "-File", "tests/run.ps1"]);
    const r = check("tests", "Rscript", ["tests/run.R"]);
    const lua = check("tests", "lua", ["tests/run.lua"]);
    const root = project({
      "tests/run.ps1": "<# tests #>\nSet-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n",
      "tests/run.R": "# nothing yet\n",
      "tests/run.lua": "--[[ later ]]\n-- nothing\n",
    });
    expect([pwsh, r, lua].map((c) => emptyTestScript(c, root))).toEqual([
      "tests/run.ps1",
      "tests/run.R",
      "tests/run.lua",
    ]);
  });

  test("a test runner, inline code, a missing script and a non-test check are not read", () => {
    const root = project({ "tests/run.php": "", "tests/run.py": "", "scripts/build.php": "" });
    const cases = [
      check("tests", "python3", ["-m", "pytest", "tests/run.py"]),
      check("tests", "python3", ["-c", "import tests"]),
      check("php-tests", "php", ["vendor/bin/phpunit", "tests"]),
      check("tests", "bun", ["test", "tests"]),
      check("php-tests", "php", ["tests/missing.php"]),
      check("build", "php", ["scripts/build.php"]),
    ];
    expect(cases.map((c) => emptyTestScript(c, root))).toEqual(cases.map(() => null));
  });

  test("the check's note says no tests ran, which the no-tests readers take as none collected", () => {
    const note = emptyScriptNote({ id: "php-tests" }, "tests/run.php");
    expect(note).toContain("tests/run.php holds no code");
    expect(noTestsCollected(note)).toBe(true);
  });
});
