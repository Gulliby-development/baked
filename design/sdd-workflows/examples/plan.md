# Workflow status as JSON

This example describes future runtime work. The paths of the new modules and tests do not exist yet.

## Context

Read the RunSnapshot through WorkflowService.get and serialize it without a model call.

## Decisions

DEC-001: stdout contains only JSON. Diagnostics go to stderr. Covers: FR-001.

DEC-002: status takes no execution lease and does not call drive. Covers: FR-002.

## Components

`src/core/workflows/status.ts` performs the read. `src/headless/workflow.ts` formats the response.

## Data

Sources: the runs projection and pending requests. Returns a RunSnapshot.

## Verification

`tests/workflow-status.test.ts` checks AC-001, AC-002 and AC-003 with a fake AgentExecutor.

## Risks

When the snapshot is updated concurrently, read a consistent state in one SQLite transaction.
