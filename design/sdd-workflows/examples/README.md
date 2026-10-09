# Contract examples

All data is illustrative. It does not describe completed work. The future check commands from policy.json are not run by the design check.

- [spec.json](spec.json) contains the requirements and criteria for JSON status.
- [plan.md](plan.md) describes the future modules and checks.
- [tasks.json](tasks.json) links requirements, criteria, tasks and dependencies.
- [profiles.json](profiles.json) defines nine profiles, including the semantic spec reviewer and the skeptic.
- [workflow.json](workflow.json) links stages to profiles and bounded repair targets.
- [policy.json](policy.json) defines permissions, limits and check commands.

The hashes in tasks.json match the canonical JSON of the spec and the exact UTF-8 bytes of plan.md. After changing these fixtures, the author can run `bun design/sdd-workflows/check-design.ts --refresh-example-hashes`. A normal checker run changes nothing.
