/**
 * Adds the critic outcome log: one row per critic score of a task attempt, with the outcomes that
 * later label it (whether the task's checks passed, the run's acceptance, the delivered commit's
 * fate and how many of its lines survive). No foreign key to `runs`: the log is the project's
 * calibration data and outlives the retention of the runs it came from.
 */
export const migration012 = `CREATE TABLE critic_outcomes (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  model TEXT,
  score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
  rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json)),
  task_result TEXT CHECK(task_result IS NULL OR task_result IN ('passed','repaired')),
  acceptance TEXT CHECK(acceptance IS NULL OR acceptance IN ('accepted','rejected')),
  delivery TEXT CHECK(delivery IS NULL OR delivery IN ('open','merged','reverted')),
  survival REAL CHECK(survival IS NULL OR (survival >= 0 AND survival <= 1)),
  survival_final INTEGER NOT NULL DEFAULT 0 CHECK(survival_final IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, task_id, attempt)
) STRICT;
CREATE INDEX critic_outcomes_pending ON critic_outcomes(survival_final, run_id);
`;
