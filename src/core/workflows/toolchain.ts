import { type LaunchedCommand, launchedCommand, programName } from "./launcher.js";

/**
 * The toolchain table every helper that reads a check's command shares (#1655): the program a
 * check runs behind a shell launcher (`launchedCommand`) and behind a Python environment runner
 * (`uv run pytest`, `poetry run pytest`, `pipenv run pytest`, `pdm run pytest`), and the runner
 * prefix a Python project's own lockfile names. The per-task test check, the per-test timeout and
 * the Python gates each read one of these; before, each knew a different set of toolchains, so a
 * `uv run pytest` project got no `tests-written` check while its profile already ran `uv run`.
 */

/** Python environment runners: the lockfile that names each, in the order they are preferred. */
export const PYTHON_ENVIRONMENTS: readonly { lockfile: string; prefix: [string, string] }[] = [
  { lockfile: "uv.lock", prefix: ["uv", "run"] },
  { lockfile: "poetry.lock", prefix: ["poetry", "run"] },
  { lockfile: "Pipfile.lock", prefix: ["pipenv", "run"] },
  { lockfile: "pdm.lock", prefix: ["pdm", "run"] },
];

/** The runner prefix of a Python project's environment, from its lockfile, or null. */
export function pythonEnvironment(has: (file: string) => boolean): [string, string] | null {
  return PYTHON_ENVIRONMENTS.find((environment) => has(environment.lockfile))?.prefix ?? null;
}

/** A Composer `vendor/bin` proxy script, which the PHP interpreter runs on every platform. */
const COMPOSER_BIN = /^(?:\.[\\/])?vendor[\\/]bin[\\/][\w.-]+$/;

/**
 * The program a check runs, behind at most two shell launchers and one environment runner, with
 * a `launch` that rebuilds the whole command around new arguments.
 */
export function toolchainCommand(executable: string, args: readonly string[]): LaunchedCommand {
  const outer = launchedCommand(executable, args);
  // `php vendor/bin/phpunit`: a Composer-installed tool run by the interpreter (#1491).
  const vendor = outer.program === "php" ? COMPOSER_BIN.exec(outer.args[0] ?? "") : null;
  if (vendor) {
    const script = outer.args[0] as string;
    return {
      program: programName(script),
      args: outer.args.slice(1),
      launch: (next, program) =>
        outer.launch([program ? script.replace(/[^\\/]+$/, program) : script, ...next]),
    };
  }
  const runner = PYTHON_ENVIRONMENTS.find(
    ({ prefix }) => prefix[0] === outer.program && outer.args[0] === prefix[1],
  );
  const inner = outer.args[1];
  // `uv run --with x pytest`: an option of the runner itself is not unwrapped.
  if (!runner || inner === undefined || inner.startsWith("-")) return outer;
  return {
    program: programName(inner),
    args: outer.args.slice(2),
    launch: (next, program) => outer.launch([outer.args[0] as string, program ?? inner, ...next]),
  };
}
