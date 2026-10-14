/**
 * A trace of why a workflow command's process ended early (#1115). A runner that exited 1 left
 * no event and nothing a person could read, so a kill from outside and a crash looked the same.
 * While a command runs, an uncaught error or an unhandled rejection writes one JSON line to
 * stderr (`code`, `message`, the head of the stack) before the process exits 1, and an exit the
 * command did not return through writes the exit code and what was running.
 */
export function traceProcessExit(command: string): () => void {
  let done = false;
  const write = (fields: Record<string, unknown>): void => {
    try {
      process.stderr.write(`${JSON.stringify({ ...fields, command, pid: process.pid })}\n`);
    } catch {}
  };
  const crash = (code: string) => (error: unknown) => {
    done = true;
    write({
      code,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 8).join("\n") : null,
    });
    process.exit(1);
  };
  const uncaught = crash("UNCAUGHT_EXCEPTION");
  const rejected = crash("UNHANDLED_REJECTION");
  const exited = (exitCode: number): void => {
    if (!done)
      write({
        code: "PROCESS_EXITED",
        exitCode,
        message: `The process exited with code ${exitCode} while workflow ${command} was running`,
      });
  };
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", rejected);
  process.on("exit", exited);
  return () => {
    done = true;
    process.removeListener("uncaughtException", uncaught);
    process.removeListener("unhandledRejection", rejected);
    process.removeListener("exit", exited);
  };
}
