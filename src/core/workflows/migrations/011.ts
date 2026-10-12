/**
 * Adds per-run execution leases: a run executed in its own Git worktree holds `execution:` followed
 * by its run id instead of the workspace-wide `execution` lease, so several worktree runs can
 * execute at once. SQLite cannot alter a CHECK constraint, so the table is rebuilt with its rows
 * copied unchanged; no other table references `workspace_leases`.
 */
export const migration011 = `CREATE TABLE workspace_leases_v11 (
  resource TEXT PRIMARY KEY CHECK(resource IN ('execution','mutation') OR (resource LIKE 'worktree:%' AND length(resource) > 9) OR (resource LIKE 'execution:%' AND length(resource) > 10)),
  owner_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
  run_id TEXT REFERENCES runs(id),
  expires_at INTEGER NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json))
) STRICT;
INSERT INTO workspace_leases_v11 (resource,owner_id,owner_epoch,run_id,expires_at,process_identity_json)
  SELECT resource,owner_id,owner_epoch,run_id,expires_at,process_identity_json FROM workspace_leases;
DROP TABLE workspace_leases;
ALTER TABLE workspace_leases_v11 RENAME TO workspace_leases;
`;
