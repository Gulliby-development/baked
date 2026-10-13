/** `baked sandbox status [--json]`: the OS sandbox mode, its source and the backend of this machine. */
import { getCwd } from "../core/cwd.js";
import { formatSandboxStatus, sandboxStatus } from "../core/security/sandbox.js";

const USAGE = `baked sandbox status [--json]

Shows the OS sandbox mode of shell, project and check commands (the sandbox setting, raised by the
project config), the backend of this machine (bubblewrap on Linux, seatbelt on macOS, a restricted
token on Windows) and whether commands run isolated. See docs/sandbox.md.
`;

export function runSandboxCli(argv: string[]): number {
  const [command = "status", ...rest] = argv;
  if (command === "--help" || command === "-h" || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = command === "--json" || rest.includes("--json");
  if (command !== "status" && command !== "--json") {
    process.stderr.write(USAGE);
    return 1;
  }
  const status = sandboxStatus(getCwd());
  if (json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else process.stdout.write(`${formatSandboxStatus(status).join("\n")}\n`);
  // A required sandbox without a backend refuses every command: report it as a failure.
  return status.effectiveMode === "required" && !status.available ? 1 : 0;
}
