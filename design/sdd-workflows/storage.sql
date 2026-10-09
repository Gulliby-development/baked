-- Proposed migration 001 (with the requests table in the form migration 002 gives it).
-- Run only against the separate workflows database.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  parent_run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL CHECK(status IN ('created','running','waiting','paused','blocked','completed','failed','cancelled')),
  reason TEXT NOT NULL DEFAULT 'none',
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
  stage_id TEXT,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  profiles_json TEXT NOT NULL CHECK(json_valid(profiles_json)),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  input_manifest_json TEXT NOT NULL CHECK(json_valid(input_manifest_json)),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  approval_digest TEXT CHECK(approval_digest IS NULL OR length(approval_digest) = 64),
  owner_id TEXT,
  owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK(owner_epoch >= 0),
  owner_expires_at INTEGER,
  repair_rounds INTEGER NOT NULL DEFAULT 0 CHECK(repair_rounds >= 0),
  convergence_rounds INTEGER NOT NULL DEFAULT 0 CHECK(convergence_rounds >= 0),
  corrective_tasks INTEGER NOT NULL DEFAULT 0 CHECK(corrective_tasks >= 0),
  agent_calls INTEGER NOT NULL DEFAULT 0 CHECK(agent_calls >= 0),
  token_usage INTEGER NOT NULL DEFAULT 0 CHECK(token_usage >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  estimated_cost_microusd INTEGER CHECK(estimated_cost_microusd IS NULL OR estimated_cost_microusd >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX runs_status ON runs(status, updated_at DESC);
CREATE INDEX runs_feature ON runs(feature_id, created_at DESC);

CREATE TABLE artifacts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  inline_content TEXT,
  blob_path TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  UNIQUE(run_id, logical_path, revision),
  CHECK((inline_content IS NULL) <> (blob_path IS NULL))
) STRICT;

CREATE TABLE workspace_snapshots (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  git_head TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  UNIQUE(run_id, manifest_hash)
) STRICT;

CREATE TABLE steps (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  parent_step_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting','completed','failed','interrupted','skipped','invalidated')),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  output_artifact_id TEXT,
  error_code TEXT,
  PRIMARY KEY(run_id, id),
  UNIQUE(run_id, stage_id, generation),
  FOREIGN KEY(run_id, parent_step_id) REFERENCES steps(run_id, id),
  FOREIGN KEY(run_id, output_artifact_id) REFERENCES artifacts(run_id, id)
) STRICT;

CREATE TABLE attempts (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  model_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','cancelled')),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
  used_tokens INTEGER CHECK(used_tokens IS NULL OR used_tokens >= 0),
  usage_complete INTEGER NOT NULL DEFAULT 0 CHECK(usage_complete IN (0,1)),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY(run_id, id),
  UNIQUE(run_id, step_id, ordinal),
  FOREIGN KEY(run_id, step_id) REFERENCES steps(run_id, id)
) STRICT;

CREATE TABLE tasks (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  definition_hash TEXT NOT NULL CHECK(length(definition_hash) = 64),
  status TEXT NOT NULL CHECK(status IN ('pending','running','implemented','verified','blocked','failed','cancelled','invalidated')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  snapshot_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  FOREIGN KEY(run_id, snapshot_id) REFERENCES workspace_snapshots(run_id, id)
) STRICT;
CREATE TABLE task_dependencies (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, dependency_id),
  FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id),
  FOREIGN KEY(run_id, dependency_id) REFERENCES tasks(run_id, id),
  CHECK(task_id <> dependency_id)
) STRICT;

CREATE TABLE evidence (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('command','read','diff','review','manual')),
  snapshot_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  producer_attempt_id TEXT,
  validity TEXT NOT NULL CHECK(validity IN ('current','stale','invalid')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  FOREIGN KEY(run_id, snapshot_id) REFERENCES workspace_snapshots(run_id, id),
  FOREIGN KEY(run_id, artifact_id) REFERENCES artifacts(run_id, id),
  FOREIGN KEY(run_id, producer_attempt_id) REFERENCES attempts(run_id, id)
) STRICT;
CREATE TABLE check_results (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed','failed','inconclusive')),
  exit_code INTEGER,
  reason TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  PRIMARY KEY(run_id, id),
  FOREIGN KEY(run_id, evidence_id) REFERENCES evidence(run_id, id),
  CHECK(status <> 'passed' OR (exit_code IS NOT NULL AND exit_code = 0))
) STRICT;

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
CREATE TABLE criterion_results (
  run_id TEXT NOT NULL REFERENCES runs(id),
  criterion_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','inconclusive','deferred')),
  evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  explanation TEXT NOT NULL,
  PRIMARY KEY(run_id, criterion_id, snapshot_id),
  FOREIGN KEY(run_id, snapshot_id) REFERENCES workspace_snapshots(run_id, id)
) STRICT;

-- Shown in its final form: migration 002 rebuilds this table to add the 'checkpoint' kind to the CHECK,
-- migration 003 to add the 'delivery' kind.
CREATE TABLE requests (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','clarification','manual_evidence','recovery','checkpoint','delivery')),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  answer_json TEXT CHECK(answer_json IS NULL OR json_valid(answer_json)),
  actor TEXT,
  decided_at INTEGER,
  PRIMARY KEY(run_id, id)
) STRICT;

-- Shown in its final form: migration 003 rebuilds this table to add the 'delivery' kind to the CHECK.
CREATE TABLE effects (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file_patch','artifact_write','command','delivery')),
  status TEXT NOT NULL CHECK(status IN ('prepared','applied','unknown','reconciled','failed')),
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  before_hash TEXT,
  after_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, id),
  FOREIGN KEY(run_id, attempt_id) REFERENCES attempts(run_id, id)
) STRICT;

CREATE TABLE workspace_leases (
  resource TEXT PRIMARY KEY CHECK(resource IN ('execution','mutation')),
  owner_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
  run_id TEXT REFERENCES runs(id),
  expires_at INTEGER NOT NULL,
  process_identity_json TEXT NOT NULL CHECK(json_valid(process_identity_json))
) STRICT;

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL CHECK(seq > 0),
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(run_id, seq)
) STRICT;
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
-- Deletes are permitted only by explicit terminal-run garbage collection.
-- DAG cycles, evidence ID arrays, JSON schema and state transitions are validated by WorkflowService.

-- Initiatives (migration 004): a large request split into features, each feature run linked by ID.
CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('decomposing','awaiting_approval','active','paused','completed','refused')),
  reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
  plan_revision INTEGER NOT NULL DEFAULT 0 CHECK(plan_revision >= 0),
  approved_plan_revision INTEGER,
  approval_digest TEXT CHECK(approval_digest IS NULL OR length(approval_digest) = 64),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  decompose_run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE initiative_revisions (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  budget_json TEXT NOT NULL CHECK(json_valid(budget_json)),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  source TEXT NOT NULL CHECK(source IN ('decomposer','user')),
  edit_json TEXT CHECK(edit_json IS NULL OR json_valid(edit_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(initiative_id, revision)
) STRICT;
CREATE TABLE initiative_requests (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('split_approval')),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
  plan_revision INTEGER NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  answer_json TEXT CHECK(answer_json IS NULL OR json_valid(answer_json)),
  actor TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY(initiative_id, id),
  FOREIGN KEY(initiative_id, plan_revision) REFERENCES initiative_revisions(initiative_id, revision)
) STRICT;
CREATE TABLE initiative_runs (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  feature_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  plan_revision INTEGER NOT NULL,
  feature_digest TEXT NOT NULL CHECK(length(feature_digest) = 64),
  origin TEXT NOT NULL CHECK(origin IN ('start','rebase','replan')),
  superseded_at INTEGER,
  superseded_reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(initiative_id, run_id)
) STRICT;
CREATE TABLE initiative_events (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  seq INTEGER NOT NULL CHECK(seq > 0),
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(initiative_id, seq)
) STRICT;
CREATE TABLE initiative_commands (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER initiative_revisions_no_update BEFORE UPDATE ON initiative_revisions BEGIN SELECT RAISE(ABORT, 'initiative revisions are immutable'); END;
CREATE TRIGGER initiative_events_no_update BEFORE UPDATE ON initiative_events BEGIN SELECT RAISE(ABORT, 'initiative events are append-only'); END;
