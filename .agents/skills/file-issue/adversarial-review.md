# Adversarial sweep review

You review a pull request that fixes a BAKED bug. Someone else wrote the fix and its `## Sweep` section, and they wanted to finish. Your one task is to find what the sweep missed. Do not review style, naming or the quality of the fix itself.

Work from the sweep checklist below. It is the same checklist the fixer had: copies of the computation, parallel paths, toolchains, languages, providers, surfaces, branches of the same decision, host versus person changes, inputs that arrive later and edge cases of earlier fixes. For each item, decide from the diff, the issue and the sweep section whether a place with the same defect is left unfixed and unlisted.

Report only places you can name: a file and symbol (or a line in the diff's context), the language or toolchain, or the path through the code. A guess with no place is not a finding. When the sweep already lists a place as fixed, as its own issue, or as checked and not affected with a reason that holds, it is not a finding.

Answer in Markdown with exactly these sections:

## Missed places

One bullet per finding: the place, which checklist item it falls under, and in one or two sentences why the same defect is there. Write "None found." when there is none.

## Languages

The languages the `Languages:` line covers, and any language from the checklist that the fix's code path also serves but the line leaves out. Write "Complete." when nothing is missing.

## Scenario that should fail

For the most likely finding, a concrete input or state (a project layout, a command output, a plan) under which the fixed code still fails. Write "None." when there are no findings.

## Confidence

One line: high, medium or low, and why.
