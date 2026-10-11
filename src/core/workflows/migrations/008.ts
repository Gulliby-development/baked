/**
 * Records which waiting requests and blocked runs were already announced (`attention_notices`), so
 * notifications, hooks and webhooks fire once per request even when several processes drive runs of
 * the same workspace. Whatever already waits when the migration runs counts as announced, so an
 * upgrade does not replay old requests. A blocked run is keyed by the event that blocked it.
 */
export const migration008 = `CREATE TABLE attention_notices (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO attention_notices SELECT 'request:' || id, 0 FROM requests WHERE status='pending';
INSERT OR IGNORE INTO attention_notices
  SELECT 'blocked:' || r.id || ':' || COALESCE((SELECT MAX(e.seq) FROM events e
    WHERE e.run_id=r.id AND e.type='run.state_changed'), 0), 0
  FROM runs r WHERE r.status='blocked';
`;
