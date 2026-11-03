import { describe, expect, test } from "bun:test";
import { diagnostics, taskErrors } from "../src/core/verification/task-end-check.js";
import { colour } from "./helpers/coloured-runner-output.js";

// Scenario of bench round 85 csp (ReScript, run e7760f1b, #2616): T001's task-end `rescript build`
// failed twice and both `task-end-check-*.json` recorded `errors: []`. The output was coloured and
// ReScript prints a bare location line (`src/Evaluate.res:168:9-14`) with the message after a code
// frame, a form no pattern read, so the implementer was told nothing and the checks stage opened two
// correctives (1.93M tokens) for the same errors. OCaml, Kotlin and Solidity print forms no pattern
// read either, and coloured tsc `--pretty` lost every location.

const RESCRIPT = `
  We've found a bug for you!
  C:/w/.baked/worktrees/e7760f1b/main/src/Evaluate.res:168:9-14

  166 ┆ let rec evaluate = (expr, env) =>
  167 ┆   switch expr {
  168 ┆   | Var(name) => Dict.get(env, name)

  This has type: value
  But it's expected to have type: option<value>

FAILED: cannot make progress due to previous errors.
`;

const written = ["src/Evaluate.res", "src/Lexer.res"];

describe("scenario: R85 csp, a ReScript task-end typecheck that told the implementer nothing (#2616)", () => {
  test("the coloured ReScript error goes back to the task that wrote the file", () => {
    const coloured = colour(RESCRIPT);
    expect(taskErrors(coloured, { written, pending: [], baseline: [] })).toEqual([
      "src/Evaluate.res: This has type: value",
    ]);
    expect(taskErrors(RESCRIPT, { written, pending: [], baseline: [] })).toEqual(
      taskErrors(coloured, { written, pending: [], baseline: [] }),
    );
    // A file the task does not write is not its error.
    expect(taskErrors(coloured, { written: ["src/Lexer.res"], pending: [], baseline: [] })).toEqual([]);
  });

  test("OCaml, Kotlin and Solidity locations name the file and the message", () => {
    const ocaml = 'File "bin/main.ml", line 3, characters 15-18:\n3 | let x : int = "a"\n                   ^^^\nError: This expression has type string but an expression was expected of type int\n';
    const kotlin = "e: file:///w/src/main/kotlin/Calc.kt:3:5 Unresolved reference 'sub'.\n";
    const solidity = "DeclarationError: Undeclared identifier.\n --> src/Calc.sol:3:5:\n  |\n3 |     sub(1, 2);\n  |     ^^^\n";
    expect([...diagnostics(colour(ocaml)), ...diagnostics(colour(kotlin)), ...diagnostics(colour(solidity))]).toEqual([
      { path: "bin/main.ml", text: "Error: This expression has type string but an expression was expected of type int" },
      { path: "/w/src/main/kotlin/Calc.kt", text: "Unresolved reference 'sub'." },
      { path: "src/Calc.sol", text: "DeclarationError: Undeclared identifier." },
    ]);
  });

  test("coloured tsc --pretty reads as the plain output", () => {
    const pretty = "src/a.ts:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.\n\n3 const n: number = 'a';\n      ~\n\nFound 1 error in src/a.ts:3\n";
    expect(diagnostics(colour(pretty))).toEqual([
      { path: "src/a.ts", text: "error TS2322: Type 'string' is not assignable to type 'number'." },
    ]);
  });
});
