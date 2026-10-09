/**
 * Adds initiatives: a plan split into features, its immutable revisions, the durable approval of
 * the split, links from features to their runs, an append-only event log and idempotent commands.
 * Additive only; no existing table changes.
 */
export const migration004 = `CREATE TABLE initiatives (
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
CREATE INDEX initiative_runs_feature ON initiative_runs(initiative_id, feature_id, created_at DESC);

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
`;
