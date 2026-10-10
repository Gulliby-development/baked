/**
 * Adds the project a run belongs to (`baked/project.json` of its workspace), so a project of
 * several checkouts can list its runs. Additive only; earlier runs have none.
 */
export const migration007 = `ALTER TABLE runs ADD COLUMN project_id TEXT;
CREATE INDEX runs_project ON runs(project_id, created_at);
`;
