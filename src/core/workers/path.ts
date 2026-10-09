import { basename, join } from "node:path";
import { dataDir, isCompiledBinary } from "../platform/index.js";

/** Workers can create other workers after being bundled into dist/workers. */
export function workerPath(name: string, moduleUrl: string, moduleDir: string): string {
  if (isCompiledBinary(moduleUrl)) return join(dataDir(), "workers", `${name}.worker.js`);
  if (moduleUrl.endsWith(".js") || /[\\/]dist(?:[\\/]|$)/.test(moduleDir))
    return join(
      moduleDir,
      ...(basename(moduleDir) === "workers" ? [] : ["workers"]),
      `${name}.worker.js`,
    );
  return join(moduleDir, `${name}.worker.ts`);
}
