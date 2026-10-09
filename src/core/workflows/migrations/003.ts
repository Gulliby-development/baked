/**
 * Adds Git delivery: the `delivery` request kind (a human approval of one delivery plan) and the
 * `delivery` effect kind (commit, push and pull request as journaled external effects). SQLite
 * cannot alter a CHECK constraint, so both tables are rebuilt with their rows copied unchanged;
 * no other table references `requests` or `effects`.
 */
export const migration003 = `CREATE TABLE requests_v3 (
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
INSERT INTO requests_v3 (run_id,id,kind,status,digest,body_json,answer_json,actor,decided_at)
  SELECT run_id,id,kind,status,digest,body_json,answer_json,actor,decided_at FROM requests;
DROP TABLE requests;
ALTER TABLE requests_v3 RENAME TO requests;
CREATE TABLE effects_v3 (
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
INSERT INTO effects_v3 (run_id,id,attempt_id,kind,status,intent_json,before_hash,after_hash,created_at)
  SELECT run_id,id,attempt_id,kind,status,intent_json,before_hash,after_hash,created_at FROM effects;
DROP TABLE effects;
ALTER TABLE effects_v3 RENAME TO effects;
`;
