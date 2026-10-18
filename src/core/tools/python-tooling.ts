/**
 * Where a Python project configures ruff, or null when it does not use it: `ruff.toml`,
 * `.ruff.toml`, a `[tool.ruff` table in `pyproject.toml`, or ruff declared as a dependency in
 * `requirements*.txt` or `pyproject.toml`. The edit tools' profile and the workflow gates both
 * decide from this (#1537): the profile read only `ruff.toml`, so a project configured in
 * `pyproject.toml` got `black` and `flake8` while its gate ran `ruff format --check` (bench round
 * 44, ignorewhy and expenses-py).
 */
export function ruffSource(project: {
  ruffToml: boolean;
  dotRuffToml: boolean;
  pyproject: string;
  requirements: string;
}): string | null {
  if (project.ruffToml) return "ruff.toml";
  if (project.dotRuffToml) return ".ruff.toml";
  if (/\[tool\.ruff/.test(project.pyproject)) return "pyproject.toml [tool.ruff]";
  if (/^\s*ruff\b/im.test(project.requirements) || /["']ruff[<>=~!\s"'[]/.test(project.pyproject))
    return "declared ruff dependency";
  return null;
}
