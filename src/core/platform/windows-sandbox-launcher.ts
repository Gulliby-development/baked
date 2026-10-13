/** Runs the Windows sandbox launcher when BAKED runs from source; see windows-sandbox.ts. */
import { runSandboxExecCli } from "./windows-sandbox.js";

process.exit(runSandboxExecCli(process.argv.slice(2)));
