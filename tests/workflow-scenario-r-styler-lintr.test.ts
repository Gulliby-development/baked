import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectProfile } from "../src/core/tools/project.js";
import { rscriptExecutable } from "../src/core/platform/index.js";
import { isStaticCheck, styleClaimShown } from "../src/core/workflows/check-policy.js";
import { formatWrittenChecks } from "../src/core/workflows/format-written.js";
import { detectGates, executeGate } from "../src/core/workflows/gates.js";
import { packageNeeds } from "../src/core/workflows/package-probe.js";
import { STYLER_OWNS_INDENTATION } from "../src/core/workflows/r-tools.js";
import type { Check } from "../src/core/workflows/types.js";

// #2948: an R package with a `.lintr` of `linters_with_defaults()` and styler installed. A task
// wrote a multi-line `if` condition that lintr accepted; the format-written check's fixer (styler)
// indented its continuation 2 past the `if`, and lintr's default `indentation_linter` then asked
// for 6 ("Indentation should be 10 spaces but is 6 spaces"). No text passed both, the lintr check
// was red for every later task, and R101 turntrim opened 16 lintr correctives (3.79M tokens).

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-r-styler-lintr-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const rscript = rscriptExecutable();
const hasLintr =
  spawnSync(rscript, ["-e", "quit(status = as.integer(!requireNamespace('lintr', quietly = TRUE)))"], {
    encoding: "utf8",
    timeout: 60000,
  }).status === 0;

const PACKAGE = {
  DESCRIPTION: "Package: turnr\nVersion: 0.1.0\nTitle: Turns\nDescription: Turns.\nLicense: MIT\n",
  NAMESPACE: "export(parse_count)\n",
  ".lintr": "linters: linters_with_defaults()\n",
};

/** R/cli.R as the task wrote it: the continuation hangs under the condition, as lintr asks. */
const WRITTEN = `parse_count <- function(values, limits) {
  for (value in values) {
    if (!grepl("^[0-9]+$", value) || nchar(value) > 7L ||
          as.numeric(value) < limits[[1L]]) {
      stop("bad count")
    }
  }
  invisible(values)
}
`;

/** The same file after `styler::style_file`: the continuation R101 turntrim's R/cli.R got (#2948). */
const STYLED = WRITTEN.replace("\n          as.numeric", "\n      as.numeric");

/**
 * A library holding a package named styler, so `requireNamespace` finds it as it finds the real
 * one; built once, from a DESCRIPTION alone. Null when R CMD INSTALL fails.
 */
function stylerLibrary(): string | null {
  const root = project({
    "styler/DESCRIPTION":
      "Package: styler\nVersion: 0.0.1\nTitle: Stand-in\nDescription: Stand-in for a test.\nLicense: MIT\n",
    "styler/NAMESPACE": "",
  });
  mkdirSync(join(root, "lib"));
  const r = rscript.replace(/Rscript(\.exe)?$/i, "R$1");
  const installed = spawnSync(r, ["CMD", "INSTALL", "--no-test-load", "-l", join(root, "lib"), join(root, "styler")], {
    encoding: "utf8",
    timeout: 120000,
  });
  return installed.status === 0 ? join(root, "lib") : null;
}

/** Whether the Rscript the gates run loads styler from its own libraries. */
const stylerOnMachine = () =>
  spawnSync(rscript, ["-e", "quit(status = as.integer(!requireNamespace('styler', quietly = TRUE)))"], {
    encoding: "utf8",
    timeout: 60000,
  }).status === 0;

describe("R gates: styler's output passes the lintr gate (#2948)", () => {
  test("the lintr gate names no styler package and stays a lint check, not a format check", () => {
    const root = project({ ...PACKAGE, "R/cli.R": WRITTEN });
    const lintr = detectGates(root).find((s) => s.check.id === "lintr")?.check as Check;
    expect(lintr.args.join(" ")).toContain(STYLER_OWNS_INDENTATION);
    expect(packageNeeds(lintr).map((n) => n.name)).toEqual(["lintr"]);
    expect(isStaticCheck(lintr)).toBe(true);
    // A passing lintr check shows no claim that the R files are formatted.
    expect(styleClaimShown("All R files are formatted", [lintr])).toBe(false);
  });

  test("the edit tools' lint command keeps the same lints as the gate", async () => {
    const profile = await detectProfile(project({ ...PACKAGE, "R/cli.R": WRITTEN }));
    expect(profile.lint).toContain(STYLER_OWNS_INDENTATION);
    expect(profile.lint).toContain("lintr::lint_package()");
  });

  test.skipIf(!hasLintr)(
    "lintr passes the task's file, the styler fixer rewrites it, and lintr still passes; without styler lintr keeps indentation",
    async () => {
      const lib = stylerLibrary();
      expect(lib).not.toBeNull();
      const root = project({ ...PACKAGE, "R/cli.R": WRITTEN });
      const lintr = detectGates(root).find((s) => s.check.id === "lintr")?.check as Check;
      // The run's lintr check with the stand-in styler on the library path.
      const withStyler: Check = { ...lintr, envNames: [...lintr.envNames, "R_LIBS"] };
      const signal = new AbortController().signal;
      const before = process.env.R_LIBS;
      process.env.R_LIBS = lib ?? "";
      try {
        // The format-written check holds the file the task created to styler, with styler's fixer.
        const written = formatWrittenChecks(
          root,
          [lintr],
          [{ path: "R/cli.R", action: "create" }],
          (command) => command,
          undefined,
          undefined,
          { packages: () => true },
        );
        expect(written.map((c) => c.id)).toEqual(["styler-written"]);
        expect((await executeGate(root, withStyler, signal)).status).toBe("passed");
        // The host's fixer runs after the lint check passed: the file is now styler's.
        writeFileSync(join(root, "R/cli.R"), STYLED);
        const after = await executeGate(root, withStyler, signal);
        expect([after.status, after.outputTail.trim()]).toEqual(["passed", ""]);
        // Other lints still fail the gate.
        writeFileSync(join(root, "R/cli.R"), STYLED.replace("invisible(values)", "invisible(values) "));
        const trailing = await executeGate(root, withStyler, signal);
        expect(trailing.status).toBe("failed");
        expect(trailing.outputTail).toContain("[trailing_whitespace_linter]");
      } finally {
        if (before === undefined) delete process.env.R_LIBS;
        else process.env.R_LIBS = before;
      }
      // Without styler nothing restyles the file, and lintr keeps its indentation rule.
      if (!stylerOnMachine()) {
        writeFileSync(join(root, "R/cli.R"), STYLED);
        const plain = await executeGate(root, lintr, signal);
        expect(plain.status).toBe("failed");
        expect(plain.outputTail).toContain("R/cli.R:4:6: style: [indentation_linter] Indentation should be 10 spaces but is 6 spaces.");
      }
    },
    240000,
  );
});
