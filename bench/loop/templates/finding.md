## F-RNN-<app>-<n>: <short title>

- Severity: P0 | P1 | P2
- Kind: invariant | recovery | model-behavior — <one line why>
- Origin: new | sibling-of:#N — <which path, stage, toolchain or case the fix of #N did not cover> | harder-round — <the new language or the size> | model-behavior
- Fault origin: host | model | environment — <one line why>
- Escaped layer: unit | scenario | gate-matrix | replay | shadow | fault-matrix | mini-suite | smoke | round — <the cheapest check layer that should have caught it, and why it did not>
- Seen on: <role: provider/model, ...>; earlier: <finding ids or none>
- Confirmation: reproduced (fork <id>, <model>) | not-reproduced (fork <id>, <model>) -> model-only | pending | skipped: <reason> | n/a (invariant)
- Seen in: <app> run <id>, stage <stage>, attempt <n>; also <other apps/rounds>
- Evidence: <artifact path / event id / numbers>
- Cause (confirmed | inferred): <where in BAKED, file:function, and why>
- Point fix: <smallest change>
- Broader option: <capability that makes the class rarer>
- Expected effect: <tokens or interventions saved per run, how many runs affected>
- Surfaces: core | TUI | headless CLI | desktop
- Known issue: none | #N
