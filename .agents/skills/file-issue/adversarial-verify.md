# Adversarial review: verify one finding

A reviewer claims the pull request below left a place with the same defect unfixed. Reviewers are often wrong: they misread a diff, miss that another path already handles the case, or name a place the defect cannot reach. Your task is to disprove the finding. Keep it only when you cannot.

You get the finding, the rule it cites and the diff of the finding's file in this pull request. Check whether the named place exists in the diff or plausibly in the file, whether the defect the issue describes actually reaches it, and whether the diff already fixes it.

Answer with one fenced `json` block and nothing after it:

```json
{ "verdict": "keep", "confidence": 4, "reason": "One line: why the finding stands, is weaker than claimed, or is wrong." }
```

- `verdict`: **keep** when the finding holds as stated; **downgrade** when the place is real but the severity is too high (an edge path, already partly handled); **drop** when the place does not exist, the defect cannot reach it, or the diff already fixes it.
- `confidence`: 1 (a guess) to 5 (certain), for your verdict.
