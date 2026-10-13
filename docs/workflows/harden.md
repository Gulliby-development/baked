# Harden

The `harden` preset strengthens the tests of existing code without changing that code. Use it before agents change a module whose tests are weak, so later runs have a safety net.

```sh
baked workflow run harden --feature parser-tests --prompt "Harden the tests of src/parser.ts"
```

The TUI (`/workflow`, new run) and the desktop (New run) list `harden` with the other presets; `POST /v1/workflow/runs` takes `workflow: "harden"`.

## Stages

The preset has the stages of `standard`: research, specify, plan, analyze, approve, implement, checks and review. What is different:

- **Spec.** The spec author writes the requirements and criteria as the behavior the code has now, and marks criteria that hold over an input domain for [property-based tests](code-quality.md#property-based-tests).
- **Plan.** Every task writes only test files, plus a package manifest when it adds a test library. A plan that creates, modifies or deletes anything else, or whose tasks name no code file of the module in their `readHints`, goes back to the planner with the problem. The code files in the tasks' read hints are the module under test.
- **Approval.** Before any task runs, the host runs the [mutation gate](code-quality.md#mutation-gate) against the module with the tests it has now and keeps the result as `quality/mutation-baseline.json`: the score before.
- **Tasks.** The implementer writes and edits only tests and asserts what the code does now, edge cases and error paths included. A suspected bug is named in the task summary, not fixed.
- **Checks.** The project's checks run on the unchanged code. The mutation gate is `required` in this preset and plants its mutants in every line of the module (up to 24 per stage), not in added lines. Each surviving mutant is a blocking finding on a test file of the task that tests the module, so the correction writes a test that kills it. Property-based tests are `auto`.
- **Review.** The usual correctness review.

## Report

The run report's **Code quality** section shows `Mutation score before the run: 25% -> after: 100%.`, the surviving mutants if any remain, and the criteria with their property tests. The delivery pull request carries the same report.

`quality.mutation`, `quality.mutationThresholds`, `quality.mutationBudgetMs`, `quality.mutationEngine` and `--mutation` apply as in other runs; `--mutation advisory` reports survivors without blocking. An installed [mutation tool](code-quality.md#ecosystem-tools) mutates the whole module, and the [equivalence check](code-quality.md#mutation-gate) drops survivors that cannot change behavior; agent mutants are not used, so the score before and after compares the same mutants.
