/**
 * A SQLite error a retry can clear: a disk I/O error after the host slept, or a busy database.
 * Timers and polling loops that read the store skip a tick on it instead of failing (#1313, #1410).
 */
export function transientSqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === "string" && /^SQLITE_(IOERR|BUSY|LOCKED)/.test(code)) ||
    /disk I\/O error|database is (locked|busy)/i.test(error.message)
  );
}
