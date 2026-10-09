/**
 * Adds the `interrupted` task status: with several writers, a task whose worker or worktree lease
 * was lost is interrupted on its own while the other tasks of its batch finish. SQLite cannot
 * alter a CHECK constraint, so `tasks` is rebuilt. `task_dependencies` and `findings` reference
 * it, and dropping a referenced table fails with foreign keys on, so both are set aside first and
 * recreated with their definitions and rows unchanged. No other table references the three.
 */
export const migration006 = `CREATE TABLE task_dependencies_v6_rows AS SELECT * FROM task_dependencies;
CREATE TABLE findings_v6_rows AS SELECT * FROM findings;
DROP TABLE task_dependencies;
DROP TABLE findings;
CREATE TABLE tasks_v6 (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  definition_hash TEXT NOT NULL CHECK(length(definition_hash) = 64),
  status TEXT NOT NULL CHECK(status IN ('pending','running','implemented','verified','blocked','failed','cancelled','invalidated','interrupted')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  snapshot_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  FOREIGN KEY(run_id, snapshot_id) REFERENCES workspace_snapshots(run_id, id)
) STRICT;
INSERT INTO tasks_v6 (run_id,id,definition_json,definition_hash,status,generation,snapshot_id,updated_at)
  SELECT run_id,id,definition_json,definition_hash,status,generation,snapshot_id,updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v6 RENAME TO tasks;
CREATE TABLE task_dependencies (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, dependency_id),
  FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id),
  FOREIGN KEY(run_id, dependency_id) REFERENCES tasks(run_id, id),
  CHECK(task_id <> dependency_id)
) STRICT;
INSERT INTO task_dependencies (run_id,task_id,dependency_id)
  SELECT run_id,task_id,dependency_id FROM task_dependencies_v6_rows;
CREATE TABLE findings (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  status TEXT NOT NULL CHECK(status IN ('open','confirmed','refuted','resolved','inconclusive')),
  repair_task_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  UNIQUE(run_id, fingerprint),
  FOREIGN KEY(run_id, repair_task_id) REFERENCES tasks(run_id, id)
) STRICT;
INSERT INTO findings (run_id,id,fingerprint,body_json,status,repair_task_id,created_at)
  SELECT run_id,id,fingerprint,body_json,status,repair_task_id,created_at FROM findings_v6_rows;
DROP TABLE task_dependencies_v6_rows;
DROP TABLE findings_v6_rows;
`;
