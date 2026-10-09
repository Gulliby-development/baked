/**
 * Adds the `checkpoint` request kind. SQLite cannot alter a CHECK constraint, so the table is
 * rebuilt with its rows copied unchanged; no other table references `requests`.
 */
export const migration002 = `CREATE TABLE requests_v2 (
  run_id TEXT NOT NULL REFERENCES runs(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','clarification','manual_evidence','recovery','checkpoint')),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  answer_json TEXT CHECK(answer_json IS NULL OR json_valid(answer_json)),
  actor TEXT,
  decided_at INTEGER,
  PRIMARY KEY(run_id, id)
) STRICT;
INSERT INTO requests_v2 (run_id,id,kind,status,digest,body_json,answer_json,actor,decided_at)
  SELECT run_id,id,kind,status,digest,body_json,answer_json,actor,decided_at FROM requests;
DROP TABLE requests;
ALTER TABLE requests_v2 RENAME TO requests;
`;
