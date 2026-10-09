# SDD workflows: solution architecture design

Status: the runtime is implemented behind an opt-in flag; the release gate has not been passed yet. Date: 2026-10-08.

This package describes the built-in workflows, agent profiles, specifications, bounded repair loops and run recovery in BAKED. The code lives in `src/core/workflows`, `src/core/specs` and `src/core/verification`. The TypeScript contracts and SQL in this directory keep the original architectural contract. Implementation checks and the remaining release gates are kept in a separate report.

| Document | Contents |
| --- | --- |
| [Architecture](solution-design.md) | Requirements, components, behavior, security, interfaces and operations |
| [Contracts](contracts.ts) | Zod schemas of portable data and the WorkflowService interface |
| [Storage](storage.sql) | Initial SQLite schema, constraints and indexes |
| [Implementation plan](implementation-plan.md) | Change packages, dependencies and acceptance criteria |
| [Examples](examples/) | Specification, tasks, profile, workflow and check settings |
| [Design check](check-design.ts) | Checks the examples, SQL and local links without running an LLM |
| [Runtime guide](runtime-guide.md) | Opt-in config, CLI/TUI, decisions, recovery and data transfer |
| [Implementation status](implementation-status.md) | Implemented packages, actual checks and acceptance limits |
| [Next implementation](next-implementation.md) | Finish v1, then only workflows, initiatives and Git delivery |
| [Parallel worktrees](parallel-worktrees.md) | Phases toward several writers in separate Git worktrees |
| [Workflow v2 design](workflow-v2-design.md) | Proposed: definition schema v2, presets, the approval invariant, the gate library and editor, the AI acceptance gate, migration, threat model and test criteria |
| [Contracts v2](contracts-v2.ts) | Zod schemas and the definition validator of the v2 design, plus the v1 to v2 migration function |
| [Examples v2](examples/v2) | The gate library (nine gates) and the presets (eight definitions) the design check validates |

For development, read the architecture, contracts, storage and implementation plan. For a trial run, start with the runtime guide. The shared subagent fixes work independently of the workflow feature flag.

The normative sources relate as follows: `contracts.ts` defines the names and shapes of public fields; `storage.sql` defines physical constraints; `solution-design.md` defines algorithms and invariants; `implementation-plan.md` defines the delivery order. A disagreement between them is a design defect and must be resolved before the corresponding stage is implemented.

Check the package from the project root:

```powershell
bun design/sdd-workflows/check-design.ts
bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --module Preserve --moduleResolution bundler --target ESNext --types bun-types design/sdd-workflows/contracts.ts design/sdd-workflows/contracts-v2.ts design/sdd-workflows/check-design.ts
```

In the current environment Bun is available as `.tools/node_modules/bun/bin/bun.exe`. No additional packages are needed. This check confirms the internal consistency of the design artifacts; runtime checks are described in the implementation status.
