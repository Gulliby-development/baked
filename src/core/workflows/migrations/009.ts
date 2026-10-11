/**
 * Changes people made to project memory (`project_memory_edits`, see project-memory.ts): an entry
 * that runs recorded and someone hid or reworded, keyed by the entry's ID, or a note of their own
 * (`note` 1). New runs apply them when they collect the memory; started runs keep what they captured.
 */
export const migration009 = `CREATE TABLE project_memory_edits (
  id TEXT PRIMARY KEY,
  note INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;
