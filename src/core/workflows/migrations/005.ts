/**
 * Adds worktree mutation leases: a run executed in a Git worktree holds the mutation lease of that
 * worktree (`worktree:` followed by its path relative to the project root) instead of the project
 * lease. SQLite cannot alter a CHECK constraint, so the table is rebuilt with its rows copied
 * unchanged; no other table references `workspace_leases`.
 */
export const migration005 = `CREATE TABLE workspace_leases_v5 (
  resource TEXT PRIMARY KEY CHECK(resource IN ('execution','mutation') OR (resource LIKE 'worktree:%' AND length(resource) > 9)),
  owner_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
  run_id TEXT REFERENCES runs(id),
  expires_at INTEGER NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json))
) STRICT;
INSERT INTO workspace_leases_v5 (resource,owner_id,owner_epoch,run_id,expires_at,process_identity_json)
  SELECT resource,owner_id,owner_epoch,run_id,expires_at,process_identity_json FROM workspace_leases;
DROP TABLE workspace_leases;
ALTER TABLE workspace_leases_v5 RENAME TO workspace_leases;
`;
